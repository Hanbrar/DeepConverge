import { NextRequest } from "next/server";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface StreamChunk {
  type: "reasoning" | "content";
  text: string;
  sources?: string[];
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ── System prompts ──────────────────────────────────────────────────

const MODERATOR_SYSTEM = `You are a debate moderator. Professional, fair, and sharp.

Rules:
- Present the topic in 1-2 sentences
- For verdicts: declare a winner with a brief reason, or note a draw
- Use bullet points for key observations
- Keep response under 400 characters

CRITICAL: Output ONLY your final response text. Do NOT include any thinking, planning, reasoning, meta-commentary, character counting, or drafting notes. Start your response directly with the actual content. Never write phrases like "We need to", "Let's craft", "Must be", "Should cite", or any self-talk.`;

const BLUE_SYSTEM = `You are the BLUE debater. You argue FOR the proposition.

Rules:
- Present arguments as short bullet points (use "- " format)
- Each point should be one clear, punchy sentence
- Max 3-4 bullet points per response
- Directly counter Red's points when responding
- Keep response under 400 characters
- Be persuasive but not aggressive

CRITICAL: Output ONLY your bullet points. Do NOT include any thinking, planning, reasoning, meta-commentary, character counting, or drafting notes. Start immediately with your first bullet point. Never write phrases like "We need to", "Let's craft", "Must be", "Should cite", or any self-talk. Do not reference being an AI.`;

const RED_SYSTEM = `You are the RED debater. You argue AGAINST the proposition.

Rules:
- Present arguments as short bullet points (use "- " format)
- Each point should be one clear, punchy sentence
- Max 3-4 bullet points per response
- Directly counter Blue's points when responding
- Keep response under 400 characters
- Be rigorous but respectful

CRITICAL: Output ONLY your bullet points. Do NOT include any thinking, planning, reasoning, meta-commentary, character counting, or drafting notes. Start immediately with your first bullet point. Never write phrases like "We need to", "Let's craft", "Must be", "Should cite", or any self-talk. Do not reference being an AI.`;

// ── Utility functions ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => extractText(part)).join("");
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.parts)) return value.parts.map((part) => extractText(part)).join("");
  }
  return "";
}

function stripUrlsFromText(text: string): string {
  let cleaned = text.replace(/\[([^\]]*)\]\(https?:\/\/[^)]+\)/g, "");
  cleaned = cleaned.replace(/https?:\/\/[^\s<>"'`]+/g, "");
  cleaned = cleaned.replace(/  +/g, " ").trim();
  return cleaned;
}

/** Extract bullet points from text (lines starting with "- " or "Bullet N:") */
function extractBulletPoints(text: string): string | null {
  const lines = text.split("\n");
  const bullets: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      bullets.push(trimmed);
      continue;
    }
    // Match "Bullet N:" or "Bullet N." format — extract content after the label
    const bulletMatch = trimmed.match(/^bullet\s*\d+\s*[:.]?\s*["""]?\s*(.+)/i);
    if (bulletMatch && bulletMatch[1]) {
      let content = bulletMatch[1].trim();
      // Remove trailing quote if present
      content = content.replace(/["""]$/, "").trim();
      if (content) bullets.push(`- ${content}`);
    }
  }

  if (bullets.length > 0) {
    return bullets.join("\n").trim();
  }
  return null;
}

/** Strip obvious chain-of-thought meta-commentary */
function stripChainOfThought(text: string): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];

  // Only strip lines that are clearly internal thinking, not debate content
  const cotPatterns = [
    /^we need to /i,
    /^let's craft/i,
    /^let's count/i,
    /^need to keep under/i,
    /^the user wants/i,
    /^the instruction/i,
    /^thus final answer/i,
    /^could cite/i,
    /^use markdown/i,
    /^use at most/i,
    /^that's \d+ sentence/i,
    /^that domain is/i,
    /approximate characters/i,
    /^use citations/i,
    /^include citation/i,
    /^should cite/i,
    /^must be brief/i,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      cleaned.push(line);
      continue;
    }
    const isCot = cotPatterns.some((p) => p.test(trimmed));
    if (!isCot) {
      cleaned.push(line);
    }
  }

  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Extract the last paragraphs that fit within a character limit */
function extractLastParagraphs(text: string, maxLen: number): string {
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length > 5);
  if (paragraphs.length === 0) return text.slice(-maxLen);

  let result = "";
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const candidate = paragraphs[i] + (result ? "\n\n" + result : "");
    if (candidate.length > maxLen && result) break;
    result = candidate;
  }
  return result || paragraphs[paragraphs.length - 1].slice(0, maxLen);
}

/** Clean debate content: try bullet extraction first, then CoT filter, always fallback */
function cleanDebateContent(text: string): string {
  const stripped = stripUrlsFromText(text);
  // For debaters: try extracting just the bullet points
  const bullets = extractBulletPoints(stripped);
  if (bullets) {
    // Keep at most 4 bullet points (as per system prompt)
    return bullets.split("\n").slice(0, 4).join("\n");
  }
  // Fallback: strip CoT patterns
  const cotCleaned = stripChainOfThought(stripped);
  let result = cotCleaned;
  if (!result.trim() && stripped.trim()) result = stripped;
  // Length limit: take last meaningful paragraphs
  if (result.length > 400) result = extractLastParagraphs(result, 400);
  return result;
}

/** Clean moderator content: CoT filter + length limit */
function cleanModeratorContent(text: string): string {
  const stripped = stripUrlsFromText(text);
  const cotCleaned = stripChainOfThought(stripped);
  let result = cotCleaned;
  if (!result.trim() && stripped.trim()) result = stripped;
  // Length limit: take last meaningful paragraphs
  if (result.length > 500) result = extractLastParagraphs(result, 500);
  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Wikipedia Search ────────────────────────────────────────────────

async function searchWikipedia(query: string, limit = 3): Promise<SearchResult[]> {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${limit}&origin=*`;
    const response = await fetch(url);
    if (!response.ok) return [];

    const data = await response.json();
    const results: SearchResult[] = [];

    if (data?.query?.search) {
      for (const item of data.query.search) {
        results.push({
          title: item.title,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
          snippet: (item.snippet || "").replace(/<[^>]+>/g, "").slice(0, 200),
        });
      }
    }

    return results;
  } catch (error) {
    console.error("Wikipedia search error:", error);
    return [];
  }
}

// ── OpenRouter streaming ────────────────────────────────────────────

async function fetchWithRetry(
  messages: ChatMessage[],
  label: string,
  maxRetries = 5
): Promise<Response> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY not configured");
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const requestId = `${label}-${Date.now()}-${attempt}`;
    console.log(
      `[debate-mode] ${label}: OpenRouter request attempt ${attempt + 1}/${maxRetries + 1}`
    );
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer":
          process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
        "X-Title": `Kangaroo AI Debate - ${label}`,
        "X-Request-Id": requestId,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 600,
      }),
    });

    if (response.status === 429 && attempt < maxRetries) {
      let waitMs = (attempt + 1) * 5000;
      try {
        const errorBody = await response.json();
        const resetTimestamp =
          errorBody?.error?.metadata?.headers?.["X-RateLimit-Reset"];
        if (resetTimestamp) {
          const resetMs = Number(resetTimestamp) - Date.now();
          if (resetMs > 0 && resetMs < 120000) {
            waitMs = resetMs + 1000;
          }
        }
      } catch {
        // Use default backoff
      }
      console.log(
        `Rate limited (attempt ${attempt + 1}/${maxRetries}), waiting ${Math.round(waitMs / 1000)}s...`
      );
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
    }

    console.log(`[debate-mode] ${label}: OpenRouter response ${response.status}`);
    return response;
  }

  throw new Error("Max retries exceeded for rate limit");
}

async function* streamFromOpenRouter(
  messages: ChatMessage[],
  label: string
): AsyncGenerator<StreamChunk> {
  const response = await fetchWithRetry(messages, label);

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmedLine = line.trimEnd();
      if (!trimmedLine.startsWith("data:")) continue;

      const data = trimmedLine.slice(5).trimStart();
      if (!data) continue;
      if (data === "[DONE]") return;

      try {
        const rawParsed = JSON.parse(data);
        if (!isRecord(rawParsed)) continue;

        const choices = Array.isArray(rawParsed.choices) ? rawParsed.choices : [];
        const choice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : undefined;
        const delta = choice && isRecord(choice.delta) ? choice.delta : undefined;
        const message = choice && isRecord(choice.message) ? choice.message : undefined;

        const reasoningText = extractText(delta?.reasoning);
        const deltaContent = extractText(delta?.content) || extractText(delta?.text);
        const messageContent = extractText(message?.content) || extractText(choice?.text);
        const contentText = deltaContent || messageContent;

        // Yield whatever text the model returns (it puts everything in reasoning tokens)
        const allText = contentText || reasoningText;
        if (allText) {
          yield { type: "content", text: allText };
        }
      } catch {
        // Skip invalid JSON
      }
    }
  }
}

// ── POST handler ────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const { question, rounds = 2 } = await request.json();

    if (!question || typeof question !== "string") {
      return new Response(JSON.stringify({ error: "Question is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!OPENROUTER_API_KEY) {
      return new Response(
        JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const clampedRounds = Math.min(Math.max(1, rounds), 10);
    const encoder = new TextEncoder();
    const debateHistory: { speaker: string; content: string }[] = [];

    let isClosed = false;

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: Record<string, unknown>) => {
          if (!isClosed) {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            } catch {
              isClosed = true;
            }
          }
        };

        const safeClose = () => {
          if (!isClosed) {
            isClosed = true;
            try { controller.close(); } catch { /* Already closed */ }
          }
        };

        try {
          // ── RESEARCH PHASE ──────────────────────────────────
          send({ type: "research-start" });

          // Search Wikipedia for both sides in parallel
          const [blueResearch, redResearch] = await Promise.all([
            searchWikipedia(`${question} arguments for benefits evidence`),
            searchWikipedia(`${question} arguments against problems criticism`),
          ]);

          // Send research results to frontend (sources appear as icons)
          send({
            type: "research-done",
            speaker: "blue",
            sources: blueResearch.map((r) => r.url),
          });

          send({
            type: "research-done",
            speaker: "red",
            sources: redResearch.map((r) => r.url),
          });

          // Build research context strings for LLM prompts
          const blueResearchContext = blueResearch.length > 0
            ? `\n\nResearch sources (use these to support your argument):\n${blueResearch.map((r) => `- ${r.title}: ${r.snippet} (${r.url})`).join("\n")}`
            : "";

          const redResearchContext = redResearch.length > 0
            ? `\n\nResearch sources (use these to support your argument):\n${redResearch.map((r) => `- ${r.title}: ${r.snippet} (${r.url})`).join("\n")}`
            : "";

          // ── MODERATOR INTRO ─────────────────────────────────
          console.log("[debate-mode] moderator-intro: start");
          send({ speaker: "moderator", type: "start" });

          const modIntroMessages: ChatMessage[] = [
            { role: "system", content: MODERATOR_SYSTEM },
            {
              role: "user",
              content: `Present the following debate topic and invite both sides to argue. Be brief (1-2 sentences):\n\n"${question}"`,
            },
          ];

          let modIntroContent = "";

          for await (const chunk of streamFromOpenRouter(modIntroMessages, "moderator-intro")) {
            if (isClosed) break;
            if (chunk.type === "content" && chunk.text) {
              modIntroContent += chunk.text;
            }
          }

          const cleanedModIntro = cleanModeratorContent(modIntroContent);
          console.log(
            `[debate-mode] moderator-intro: done (${cleanedModIntro.length} chars)`
          );
          send({ speaker: "moderator", type: "done", content: cleanedModIntro });
          debateHistory.push({ speaker: "moderator", content: cleanedModIntro });

          // ── DEBATE ROUNDS ───────────────────────────────────
          for (let round = 0; round < clampedRounds; round++) {
            if (isClosed) break;

            // ── BLUE TURN ──
            const blueLabel = `blue-r${round + 1}`;
            console.log(`[debate-mode] ${blueLabel}: start`);
            send({ speaker: "blue", type: "start", round: round + 1 });

            const blueContext = debateHistory
              .map((h) => `[${h.speaker.toUpperCase()}]: ${h.content}`)
              .join("\n\n");

            const blueMessages: ChatMessage[] = [
              { role: "system", content: BLUE_SYSTEM },
              {
                role: "user",
                content:
                  round === 0
                    ? `Debate topic: "${question}"\n\nModerator said: ${cleanedModIntro}\n\nPresent your opening argument FOR this proposition.${blueResearchContext}`
                    : `Debate topic: "${question}"\n\nPrevious discussion:\n${blueContext}\n\nRespond to the Red debater's latest points and strengthen your position.${blueResearchContext}`,
              },
            ];

            let blueContent = "";

            for await (const chunk of streamFromOpenRouter(blueMessages, blueLabel)) {
              if (isClosed) break;
              if (chunk.type === "content" && chunk.text) {
                blueContent += chunk.text;
              }
            }

            const cleanedBlue = cleanDebateContent(blueContent);
            console.log(
              `[debate-mode] ${blueLabel}: done (${cleanedBlue.length} chars)`
            );
            send({ speaker: "blue", type: "done", content: cleanedBlue });
            debateHistory.push({ speaker: "blue", content: cleanedBlue });

            if (isClosed) break;

            // ── RED TURN ──
            const redLabel = `red-r${round + 1}`;
            console.log(`[debate-mode] ${redLabel}: start`);
            send({ speaker: "red", type: "start", round: round + 1 });

            const redContext = debateHistory
              .map((h) => `[${h.speaker.toUpperCase()}]: ${h.content}`)
              .join("\n\n");

            const redMessages: ChatMessage[] = [
              { role: "system", content: RED_SYSTEM },
              {
                role: "user",
                content:
                  round === 0
                    ? `Debate topic: "${question}"\n\nThe Blue debater argued:\n${cleanedBlue}\n\nPresent your opening argument AGAINST this proposition and counter the Blue debater.${redResearchContext}`
                    : `Debate topic: "${question}"\n\nPrevious discussion:\n${redContext}\n\nCounter the Blue debater's latest points and strengthen your position.${redResearchContext}`,
              },
            ];

            let redContent = "";

            for await (const chunk of streamFromOpenRouter(redMessages, redLabel)) {
              if (isClosed) break;
              if (chunk.type === "content" && chunk.text) {
                redContent += chunk.text;
              }
            }

            const cleanedRed = cleanDebateContent(redContent);
            console.log(
              `[debate-mode] ${redLabel}: done (${cleanedRed.length} chars)`
            );
            send({ speaker: "red", type: "done", content: cleanedRed });
            debateHistory.push({ speaker: "red", content: cleanedRed });
          }

          if (isClosed) { safeClose(); return; }

          // ── VERDICT ─────────────────────────────────────────
          console.log("[debate-mode] verdict: start");
          send({ speaker: "moderator", type: "start", isVerdict: true });

          const fullDebateContext = debateHistory
            .map((h) => `[${h.speaker.toUpperCase()}]: ${h.content}`)
            .join("\n\n");

          const verdictMessages: ChatMessage[] = [
            { role: "system", content: MODERATOR_SYSTEM },
            {
              role: "user",
              content: `Debate topic: "${question}"\n\nFull debate:\n${fullDebateContext}\n\nNow deliver your verdict. Who won this debate and why? Or did they reach agreement? Be decisive.`,
            },
          ];

          let verdictContent = "";

          for await (const chunk of streamFromOpenRouter(verdictMessages, "verdict")) {
            if (isClosed) break;
            if (chunk.type === "content" && chunk.text) {
              verdictContent += chunk.text;
            }
          }

          console.log(`[debate-mode] verdict: done (${verdictContent.length} chars)`);
          send({
            speaker: "moderator",
            type: "done",
            content: cleanModeratorContent(verdictContent),
            isVerdict: true,
          });

          send({ type: "complete" });
          safeClose();
        } catch (error) {
          console.error("Debate mode error:", error);
          send({ type: "error", message: String(error) });
          safeClose();
        }
      },
      cancel() {
        isClosed = true;
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Request error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
