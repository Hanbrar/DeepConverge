import { NextRequest } from "next/server";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";

export async function POST(request: NextRequest) {
  try {
    const { message } = await request.json();

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

    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
        "X-Title": "Kangaroo AI",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "user",
            content: message,
          },
        ],
        stream: true,
        temperature: 0.7,
        max_tokens: 2048,
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
        let inReasoning = false;

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
                  const chunk = parsed.choices?.[0]?.delta?.content || "";

                  if (chunk) {
                    // Check for reasoning tags
                    const fullText = (inReasoning ? reasoning : content) + chunk;

                    if (chunk.includes("<think>") || fullText.includes("<think>")) {
                      inReasoning = true;
                    }

                    if (inReasoning) {
                      reasoning += chunk;

                      // Check if reasoning ended
                      if (reasoning.includes("</think>")) {
                        inReasoning = false;
                        const parts = reasoning.split("</think>");
                        reasoning = parts[0].replace("<think>", "").trim();
                        content += parts[1] || "";

                        // Send reasoning complete
                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify({ type: "reasoning", content: reasoning, done: true })}\n\n`
                          )
                        );

                        // Send content if any
                        if (content) {
                          controller.enqueue(
                            encoder.encode(
                              `data: ${JSON.stringify({ type: "content", content })}\n\n`
                            )
                          );
                        }
                      } else {
                        // Still in reasoning, send update
                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify({ type: "reasoning", content: reasoning.replace("<think>", ""), done: false })}\n\n`
                          )
                        );
                      }
                    } else {
                      content += chunk;
                      controller.enqueue(
                        encoder.encode(
                          `data: ${JSON.stringify({ type: "content", content })}\n\n`
                        )
                      );
                    }
                  }
                } catch {
                  // Skip invalid JSON
                }
              }
            }
          }

          // Send final done signal
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "done", reasoning, content })}\n\n`
            )
          );
        } catch (error) {
          console.error("Stream error:", error);
        } finally {
          controller.close();
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
