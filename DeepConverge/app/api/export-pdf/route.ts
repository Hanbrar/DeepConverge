import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { jsPDF } from "jspdf";

async function createSupabaseClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component — can't set cookies here
          }
        },
      },
    }
  );
}

export async function GET() {
  try {
    const supabase = await createSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Fetch all conversations
    const { data: conversations } = await supabase
      .from("conversations")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (!conversations || conversations.length === 0) {
      return new Response(
        JSON.stringify({ error: "No conversations to export" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch all messages for all conversations
    const conversationIds = conversations.map((c) => c.id);
    const { data: allMessages } = await supabase
      .from("messages")
      .select("*")
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: true });

    const messagesByConv: Record<
      string,
      Array<{ role: string; content: string; created_at: string }>
    > = {};
    for (const msg of allMessages || []) {
      if (!messagesByConv[msg.conversation_id]) {
        messagesByConv[msg.conversation_id] = [];
      }
      messagesByConv[msg.conversation_id].push(msg);
    }

    // Generate PDF
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 20;
    const maxWidth = pageWidth - margin * 2;
    let y = margin;

    const addPage = () => {
      doc.addPage();
      y = margin;
    };

    const checkPageBreak = (needed: number) => {
      if (y + needed > pageHeight - margin) {
        addPage();
      }
    };

    // ── Cover page ──
    y = 80;
    doc.setFontSize(28);
    doc.setFont("helvetica", "bold");
    doc.text("DeepConverge", pageWidth / 2, y, { align: "center" });
    y += 12;

    doc.setFontSize(14);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text("Your AI Conversation Archive", pageWidth / 2, y, {
      align: "center",
    });
    y += 20;

    doc.setFontSize(11);
    const userName =
      user.user_metadata?.full_name || user.email || "User";
    doc.text(`Exported by: ${userName}`, pageWidth / 2, y, {
      align: "center",
    });
    y += 7;
    doc.text(
      `Date: ${new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })}`,
      pageWidth / 2,
      y,
      { align: "center" }
    );
    y += 7;
    doc.text(
      `Total conversations: ${conversations.length}`,
      pageWidth / 2,
      y,
      { align: "center" }
    );

    doc.setTextColor(0, 0, 0);

    // ── Conversations ──
    for (const conv of conversations) {
      addPage();

      // Conversation header
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      const titleLines = doc.splitTextToSize(conv.title, maxWidth);
      checkPageBreak(titleLines.length * 7 + 12);
      doc.text(titleLines, margin, y);
      y += titleLines.length * 7 + 2;

      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(120, 120, 120);
      const modeLabel = conv.mode === "debate" ? "Debate" : "Chat";
      const dateStr = new Date(conv.created_at).toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      doc.text(`${modeLabel} · ${dateStr}`, margin, y);
      y += 8;
      doc.setTextColor(0, 0, 0);

      // Divider
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, y, pageWidth - margin, y);
      y += 6;

      // Messages
      const msgs = messagesByConv[conv.id] || [];
      for (const msg of msgs) {
        const roleLabel =
          msg.role === "user"
            ? "You"
            : msg.role === "assistant"
            ? "Nemotron"
            : msg.role === "debater_blue"
            ? "Blue Debater"
            : msg.role === "debater_red"
            ? "Red Debater"
            : msg.role === "moderator"
            ? "Moderator"
            : msg.role;

        // Role label
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        checkPageBreak(14);
        doc.text(roleLabel, margin, y);
        y += 5;

        // Content — strip markdown for cleaner PDF
        const cleanContent = msg.content
          .replace(/#{1,6}\s/g, "")
          .replace(/\*\*(.*?)\*\*/g, "$1")
          .replace(/\*(.*?)\*/g, "$1")
          .replace(/`{1,3}[^`]*`{1,3}/g, (m: string) =>
            m.replace(/`/g, "")
          )
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .trim();

        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        const contentLines = doc.splitTextToSize(cleanContent, maxWidth);

        for (const line of contentLines) {
          checkPageBreak(5);
          doc.text(line, margin, y);
          y += 5;
        }

        y += 4;
      }
    }

    // Footer on each page
    const totalPages = doc.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(160, 160, 160);
      doc.text(
        `DeepConverge · Page ${i} of ${totalPages}`,
        pageWidth / 2,
        pageHeight - 10,
        { align: "center" }
      );
    }

    const pdfBuffer = doc.output("arraybuffer");

    return new Response(pdfBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="DeepConverge_Conversations.pdf"`,
      },
    });
  } catch (error) {
    console.error("PDF export error:", error);
    return new Response(JSON.stringify({ error: "Export failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
