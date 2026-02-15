import { NextRequest } from "next/server";
import { agents, agentOrder } from "@/lib/agents";
import { AgentRole } from "@/lib/types";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface StreamChunk {
  type: "reasoning" | "content";
  text: string;
}

async function* streamFromOpenRouter(
  messages: ChatMessage[],
  apiKey: string
): AsyncGenerator<StreamChunk> {
  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
      "X-Title": "DeepConverge Debate",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 4096,
      // Enable OpenRouter's native reasoning feature
      reasoning: {
        effort: "high",
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    if (
      response.status === 429 ||
      response.status === 402 ||
      error.toLowerCase().includes("credits") ||
      error.toLowerCase().includes("quota")
    ) {
      throw new Error(
        "USAGE_LIMIT: You've hit your usage limit. Extra usage is coming once beta mode is over. Thank you for testing our product!"
      );
    }
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

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
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;

          // Handle native reasoning tokens from OpenRouter
          if (delta?.reasoning) {
            yield { type: "reasoning", text: delta.reasoning };
          }
          // Handle regular content
          if (delta?.content) {
            yield { type: "content", text: delta.content };
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const { question, apiKey } = await request.json();

    if (!apiKey || typeof apiKey !== "string") {
      return new Response(
        JSON.stringify({ error: "API key is required. Please add your OpenRouter API key in Settings." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!question || typeof question !== "string") {
      return new Response(JSON.stringify({ error: "Question is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const encoder = new TextEncoder();
    const responses: { role: AgentRole; content: string }[] = [];

    let isClosed = false;

    const stream = new ReadableStream({
      async start(controller) {
        const safeEnqueue = (data: Uint8Array) => {
          if (!isClosed) {
            try {
              controller.enqueue(data);
            } catch {
              isClosed = true;
            }
          }
        };

        const safeClose = () => {
          if (!isClosed) {
            isClosed = true;
            try {
              controller.close();
            } catch {
              // Already closed
            }
          }
        };

        try {
          for (const agentRole of agentOrder) {
            if (isClosed) break;

            const agent = agents[agentRole];
            const messages: ChatMessage[] = [
              { role: "system", content: agent.systemPrompt },
            ];

            // Build context based on agent role
            if (agentRole === "critic") {
              const advocateResponse = responses.find((r) => r.role === "advocate");
              messages.push({
                role: "user",
                content: `Question: ${question}\n\nAdvocate's Argument:\n${advocateResponse?.content || ""}`,
              });
            } else if (agentRole === "judge") {
              const advocateResponse = responses.find((r) => r.role === "advocate");
              const criticResponse = responses.find((r) => r.role === "critic");
              messages.push({
                role: "user",
                content: `Question: ${question}\n\nAdvocate's Argument:\n${advocateResponse?.content || ""}\n\nCritic's Argument:\n${criticResponse?.content || ""}`,
              });
            } else {
              messages.push({
                role: "user",
                content: `Question: ${question}`,
              });
            }

            // Signal start of this agent
            safeEnqueue(
              encoder.encode(
                `data: ${JSON.stringify({ agent: agentRole, type: "start" })}\n\n`
              )
            );

            let fullContent = "";
            let reasoning = "";

            for await (const chunk of streamFromOpenRouter(messages, apiKey)) {
              if (isClosed) break;

              if (chunk.type === "reasoning") {
                // Stream reasoning tokens
                reasoning += chunk.text;
                safeEnqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ agent: agentRole, type: "reasoning", content: reasoning })}\n\n`
                  )
                );
              } else if (chunk.type === "content") {
                // Stream content tokens
                fullContent += chunk.text;
                safeEnqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ agent: agentRole, type: "content", content: fullContent })}\n\n`
                  )
                );
              }
            }

            // Signal end of this agent
            safeEnqueue(
              encoder.encode(
                `data: ${JSON.stringify({ agent: agentRole, type: "done", content: fullContent, reasoning })}\n\n`
              )
            );

            responses.push({ role: agentRole, content: fullContent });
          }

          // Signal debate complete
          safeEnqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "complete" })}\n\n`)
          );
          safeClose();
        } catch (error) {
          console.error("Debate error:", error);
          safeEnqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", message: String(error) })}\n\n`
            )
          );
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
