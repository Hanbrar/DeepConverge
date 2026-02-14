import { NextRequest } from "next/server";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL_IDS = {
  nemotron9b: "nvidia/nemotron-nano-9b-v2:free",
  nemotron30b: "nvidia/nemotron-3-nano-30b-a3b",
} as const;

type ChatModel = keyof typeof MODEL_IDS;

const CHAT_SYSTEM_PROMPT = [
  "You are DeepConverge, a productivity-focused AI chat assistant.",
  "Operate like a high-throughput work copilot: optimize for clarity, speed, and useful execution.",
  "This is a chat interface, so keep responses natural and context-aware, not essay-like by default.",
  "For greetings or lightweight messages (e.g., 'hey', 'hi', 'thanks'), reply in one short friendly sentence.",
  "Default to concise, action-oriented output with practical next steps.",
  "Use longer explanations only when the user explicitly asks for depth.",
  "Do not provide dictionary-style breakdowns unless requested.",
  "Do not expose private chain-of-thought; provide brief rationale summaries when needed.",
].join(" ");

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const message = typeof body?.message === "string" ? body.message : "";
    const requestedModel =
      typeof body?.model === "string" ? (body.model as ChatModel) : undefined;
    const thinkingRequested = body?.thinking === true;

    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "Message is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "API key not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const resolvedModel: ChatModel =
      requestedModel && requestedModel in MODEL_IDS
        ? requestedModel
        : thinkingRequested
        ? "nemotron30b"
        : "nemotron9b";
    const enableThinking =
      thinkingRequested || resolvedModel === "nemotron30b";

    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
        "X-Title": "DeepConverge AI",
      },
      body: JSON.stringify({
        model: MODEL_IDS[resolvedModel],
        messages: [
          {
            role: "system",
            content: CHAT_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: message,
          },
        ],
        reasoning: enableThinking
          ? { effort: "high" }
          : { effort: "none", exclude: true },
        stream: true,
        temperature: 0.7,
        max_tokens: 8192,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("OpenRouter error:", error);
      return new Response(JSON.stringify({ error: `API error: ${response.status}` }), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let reasoning = "";
        let content = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") continue;

                try {
                  const parsed = JSON.parse(data);
                  const delta = parsed.choices?.[0]?.delta;

                  // Handle reasoning from Nemotron's native reasoning field
                  const reasoningChunk = delta?.reasoning || "";
                  if (reasoningChunk) {
                    reasoning += reasoningChunk;
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ type: "reasoning", content: reasoning })}\n\n`
                      )
                    );
                  }

                  // Handle content
                  const contentChunk = delta?.content || "";
                  if (contentChunk) {
                    content += contentChunk;
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ type: "content", content })}\n\n`
                      )
                    );
                  }
                } catch {
                  // Skip invalid JSON
                }
              }
            }
          }

          // Send final done signal and close
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "done", reasoning, content })}\n\n`
            )
          );
          controller.close();
        } catch (error) {
          console.error("Stream error:", error);
          try {
            controller.close();
          } catch {
            // Controller may already be closed
          }
        }
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
