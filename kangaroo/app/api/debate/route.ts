import { NextRequest } from "next/server";
import { agents, agentOrder } from "@/lib/agents";
import { AgentRole } from "@/lib/types";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function* streamFromOpenRouter(
  messages: ChatMessage[]
): AsyncGenerator<string> {
  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
      "X-Title": "Kangaroo AI Debate",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
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
          const content = parsed.choices?.[0]?.delta?.content || "";
          if (content) yield content;
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const { question } = await request.json();

    if (!question || typeof question !== "string") {
      return new Response(JSON.stringify({ error: "Question is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const encoder = new TextEncoder();
    const responses: { role: AgentRole; content: string }[] = [];

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (const agentRole of agentOrder) {
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
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ agent: agentRole, type: "start" })}\n\n`
              )
            );

            let fullContent = "";
            let reasoning = "";
            let inReasoning = false;

            for await (const chunk of streamFromOpenRouter(messages)) {
              // Handle reasoning tags
              if (chunk.includes("<think>")) {
                inReasoning = true;
              }

              if (inReasoning) {
                reasoning += chunk;
                if (chunk.includes("</think>")) {
                  inReasoning = false;
                  // Extract clean reasoning
                  const match = reasoning.match(/<think>([\s\S]*?)<\/think>/);
                  if (match) {
                    reasoning = match[1].trim();
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ agent: agentRole, type: "reasoning", content: reasoning })}\n\n`
                      )
                    );
                  }
                  // Get any content after </think>
                  const afterThink = chunk.split("</think>")[1] || "";
                  if (afterThink) {
                    fullContent += afterThink;
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ agent: agentRole, type: "content", content: fullContent })}\n\n`
                      )
                    );
                  }
                }
              } else {
                fullContent += chunk;
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ agent: agentRole, type: "content", content: fullContent })}\n\n`
                  )
                );
              }
            }

            // Signal end of this agent
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ agent: agentRole, type: "done", content: fullContent, reasoning })}\n\n`
              )
            );

            responses.push({ role: agentRole, content: fullContent });
          }

          // Signal debate complete
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "complete" })}\n\n`)
          );
          controller.close();
        } catch (error) {
          console.error("Debate error:", error);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", message: String(error) })}\n\n`
            )
          );
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
