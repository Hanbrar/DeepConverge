import { agents, agentOrder } from "./agents";
import { AgentRole, StreamChunk } from "./types";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function* streamAgentResponse(
  agentRole: AgentRole,
  question: string,
  previousResponses: { role: AgentRole; content: string }[],
  apiKey: string
): AsyncGenerator<StreamChunk> {
  const agent = agents[agentRole];

  const messages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt },
  ];

  // Build context from previous responses
  if (agentRole === "critic") {
    const advocateResponse = previousResponses.find(r => r.role === "advocate");
    messages.push({
      role: "user",
      content: `Question: ${question}\n\nAdvocate's Argument:\n${advocateResponse?.content || ""}`,
    });
  } else if (agentRole === "judge") {
    const advocateResponse = previousResponses.find(r => r.role === "advocate");
    const criticResponse = previousResponses.find(r => r.role === "critic");
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

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
      "X-Title": "DeepConverge Debate",
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
  let fullContent = "";
  let reasoning = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") {
          yield { agent: agentRole, content: fullContent, reasoning, done: true };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || "";

          if (content) {
            // Check if this is reasoning content (between <think> tags or similar)
            if (content.includes("<think>") || reasoning) {
              reasoning += content;
              if (content.includes("</think>")) {
                // Extract just the reasoning part
                const match = reasoning.match(/<think>([\s\S]*?)<\/think>/);
                if (match) {
                  reasoning = match[1].trim();
                }
              }
            } else {
              fullContent += content;
              yield { agent: agentRole, content: fullContent, reasoning, done: false };
            }
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }

  yield { agent: agentRole, content: fullContent, reasoning, done: true };
}

export async function runDebate(
  question: string,
  onChunk: (chunk: StreamChunk) => void,
  apiKey: string
): Promise<void> {
  const responses: { role: AgentRole; content: string }[] = [];

  for (const agentRole of agentOrder) {
    let finalContent = "";
    let _finalReasoning = "";

    for await (const chunk of streamAgentResponse(agentRole, question, responses, apiKey)) {
      onChunk(chunk);
      if (chunk.done) {
        finalContent = chunk.content;
        _finalReasoning = chunk.reasoning || "";
      }
    }

    responses.push({ role: agentRole, content: finalContent });
  }
}
