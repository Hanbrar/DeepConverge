import { NextRequest } from "next/server";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const MODEL_IDS = {
  nemotron9b: "nvidia/nemotron-nano-9b-v2:free",
  nemotron30b: "nvidia/nemotron-3-nano-30b-a3b",
} as const;

type ChatModel = keyof typeof MODEL_IDS;
type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const CHAT_SYSTEM_PROMPT = [
  "You are DeepConverge, a productivity-focused AI assistant.",
  "This is a live chat UX: default to concise, practical, and context-aware answers.",
  "For short greetings or social pings (e.g., 'hey', 'hi', 'thanks'), respond in one short sentence.",
  "If user intent is unclear, ask one clarifying question instead of inventing a task.",
  "Do not output code unless the user explicitly asks for code or asks to modify code.",
  "Avoid dictionary-style breakdowns unless asked.",
  "Prioritize direct execution guidance, clear structure, and next steps.",
  "Do not expose private chain-of-thought.",
].join(" ");

const MAX_CONVERGENCE_ROUNDS = 4;

function isShortSocialMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length > 60) return false;
  return /^(hi|hello|hey|yo|sup|what'?s up|thanks|thank you|ok|okay|cool|nice|good (morning|afternoon|evening)|how are you)[!,.?\s]*$/.test(
    normalized
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === "string"
          ? item
          : typeof item === "object" &&
            item !== null &&
            "text" in item &&
            typeof (item as { text?: unknown }).text === "string"
          ? (item as { text: string }).text
          : ""
      )
      .join("");
  }
  return "";
}

function extractAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const firstChoice = (payload as { choices?: Array<{ message?: { content?: unknown; reasoning?: unknown } }> })
    .choices?.[0];
  if (!firstChoice?.message) return "";
  const content = extractText(firstChoice.message.content);
  if (content.trim()) return content.trim();
  const reasoning = extractText(firstChoice.message.reasoning);
  return reasoning.trim();
}

function parseJudgeJson(raw: string): {
  convergence_score: number;
  converged: boolean;
  synthesis: string;
  direction_for_next_round: string;
  unresolved_points: string[];
  clarifying_questions: string[];
  final_direction: string;
} | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const candidate =
    fenced ??
    raw.match(/\{[\s\S]*\}/)?.[0] ??
    "";
  if (!candidate) return null;

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    return {
      convergence_score:
        typeof parsed.convergence_score === "number"
          ? Math.max(0, Math.min(100, parsed.convergence_score))
          : 0,
      converged: parsed.converged === true,
      synthesis:
        typeof parsed.synthesis === "string" ? parsed.synthesis.trim() : "",
      direction_for_next_round:
        typeof parsed.direction_for_next_round === "string"
          ? parsed.direction_for_next_round.trim()
          : "",
      unresolved_points: Array.isArray(parsed.unresolved_points)
        ? parsed.unresolved_points.filter((x): x is string => typeof x === "string")
        : [],
      clarifying_questions: Array.isArray(parsed.clarifying_questions)
        ? parsed.clarifying_questions.filter((x): x is string => typeof x === "string")
        : [],
      final_direction:
        typeof parsed.final_direction === "string"
          ? parsed.final_direction.trim()
          : "",
    };
  } catch {
    return null;
  }
}

function estimateAgreementScore(a: string, b: string): number {
  const tokensA = new Set(
    (a.toLowerCase().match(/[a-z0-9]{4,}/g) || []).slice(0, 200)
  );
  const tokensB = new Set(
    (b.toLowerCase().match(/[a-z0-9]{4,}/g) || []).slice(0, 200)
  );
  if (tokensA.size === 0 || tokensB.size === 0) return 35;
  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap++;
  }
  const ratio = overlap / Math.max(tokensA.size, tokensB.size);
  return Math.max(20, Math.min(85, Math.round(ratio * 100)));
}

function statusFromScore(score: number, converged: boolean, needsInput: boolean) {
  if (needsInput) return "needs_input";
  if (converged || score >= 80) return "converged";
  return "running";
}

async function completeOnce(params: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  reasoning?: { effort?: "none" | "low" | "medium" | "high"; exclude?: boolean };
}) {
  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
      "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
      "X-Title": "DeepConverge AI",
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      stream: false,
      max_tokens: params.maxTokens ?? 1024,
      temperature: params.temperature ?? 0.4,
      reasoning: params.reasoning,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errText}`);
  }

  const json = await response.json();
  return extractAssistantText(json);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const convergentThinking = body?.convergentThinking === true;

    if (!message) {
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

    // Product rule: Convergent Off -> 9B chat model, Convergent On -> 30B workflow model.
    const resolvedModel: ChatModel = convergentThinking ? "nemotron30b" : "nemotron9b";

    if (convergentThinking) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          let isClosed = false;
          const safeClose = () => {
            if (isClosed) return;
            try {
              controller.close();
            } catch {
              // Stream may already be closed/cancelled by the client.
            } finally {
              isClosed = true;
            }
          };
          const send = (payload: Record<string, unknown>) => {
            if (isClosed) return;
            try {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
              );
            } catch {
              // Avoid crashing when client disconnects mid-stream.
              isClosed = true;
            }
          };

          let finalContent = "";

          try {
            const convergentModel = MODEL_IDS.nemotron30b;

            if (isShortSocialMessage(message)) {
              send({
                type: "convergent_start",
                round: 0,
                maxRounds: 0,
                score: 100,
                status: "converged",
              });

              finalContent =
                (await completeOnce({
                  apiKey,
                  model: convergentModel,
                  temperature: 0.3,
                  maxTokens: 120,
                  reasoning: { effort: "none", exclude: true },
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
                })) || "Hey - how can I help?";

              send({
                type: "convergence_state",
                round: 0,
                maxRounds: 0,
                score: 100,
                status: "converged",
              });
              send({ type: "content", content: finalContent });
              send({ type: "done", reasoning: "", content: finalContent });
              safeClose();
              return;
            }

            send({
              type: "convergent_start",
              round: 0,
              maxRounds: MAX_CONVERGENCE_ROUNDS,
              score: 8,
              status: "running",
            });

            const kickoff = await completeOnce({
              apiKey,
              model: convergentModel,
              temperature: 0.3,
              maxTokens: 350,
              reasoning: { effort: "none", exclude: true },
                messages: [
                  {
                    role: "system",
                    content:
                      "You are the Judge in a convergent-thinking multi-agent workflow. State task framing, evaluation criteria, and convergence target in 3 concise bullets. Keep this productivity-focused and avoid code unless explicitly requested.",
                },
                {
                  role: "user",
                  content: `Task: ${message}`,
                },
              ],
            });

            send({
              type: "convergent_log",
              role: "judge",
              round: 0,
              content: kickoff,
            });

            let score = 12;
            let converged = false;
            let needsInput = false;
            let finalDirection = "";
            let clarifyingQuestions: string[] = [];
            let unresolvedPoints: string[] = [];
            let latestA = "";
            let latestB = "";
            let latestJudgeDirection = kickoff;
            const transcript: string[] = [
              `User task: ${message}`,
              `Judge kickoff: ${kickoff}`,
            ];

            for (let round = 1; round <= MAX_CONVERGENCE_ROUNDS; round++) {
              const contextTail = transcript.slice(-10).join("\n\n");

              latestA = await completeOnce({
                apiKey,
                model: convergentModel,
                temperature: 0.55,
                maxTokens: 700,
                reasoning: { effort: "none", exclude: true },
                messages: [
                  {
                    role: "system",
                    content:
                      "You are Debater A. Produce a concise, practical proposal focused on execution and measurable outcomes. Do not generate code unless explicitly requested.",
                  },
                  {
                    role: "user",
                    content: `Task: ${message}\n\nCurrent context:\n${contextTail}\n\nJudge direction:\n${latestJudgeDirection}\n\nGive your round-${round} position.`,
                  },
                ],
              });

              send({
                type: "convergent_log",
                role: "debater_a",
                round,
                content: latestA,
              });

              latestB = await completeOnce({
                apiKey,
                model: convergentModel,
                temperature: 0.6,
                maxTokens: 700,
                reasoning: { effort: "none", exclude: true },
                messages: [
                  {
                    role: "system",
                    content:
                      "You are Debater B. Stress-test assumptions, identify risks, and propose a competing practical path. Do not generate code unless explicitly requested.",
                  },
                  {
                    role: "user",
                    content: `Task: ${message}\n\nContext:\n${contextTail}\n\nDebater A round-${round}:\n${latestA}\n\nJudge direction:\n${latestJudgeDirection}\n\nGive your round-${round} position.`,
                  },
                ],
              });

              send({
                type: "convergent_log",
                role: "debater_b",
                round,
                content: latestB,
              });

              const judgeRaw = await completeOnce({
                apiKey,
                model: convergentModel,
                temperature: 0.2,
                maxTokens: 900,
                reasoning: { effort: "none", exclude: true },
                messages: [
                  {
                    role: "system",
                    content:
                      "You are the Judge. Compare Debater A vs Debater B and return strict JSON only with keys: convergence_score (0-100), converged (boolean), synthesis, direction_for_next_round, unresolved_points (string array), clarifying_questions (string array), final_direction. Keep synthesis concise and avoid code unless explicitly requested.",
                  },
                  {
                    role: "user",
                    content: `Task: ${message}\n\nDebater A:\n${latestA}\n\nDebater B:\n${latestB}\n\nCurrent round: ${round}\n\nIf convergence is high, set converged=true and final_direction. If convergence is low and this is final round (${MAX_CONVERGENCE_ROUNDS}), include 2-4 clarifying_questions.`,
                  },
                ],
              });

              const judgeParsed = parseJudgeJson(judgeRaw);
              const judgeSynthesis =
                judgeParsed?.synthesis ||
                "The agents are still refining toward a practical consensus.";
              latestJudgeDirection =
                judgeParsed?.direction_for_next_round || judgeSynthesis;

              send({
                type: "convergent_log",
                role: "judge",
                round,
                content:
                  judgeParsed
                    ? `${judgeSynthesis}\n\nDirection: ${judgeParsed.direction_for_next_round || "Continue refining tradeoffs."}`
                    : judgeSynthesis,
              });

              score = judgeParsed?.convergence_score ?? estimateAgreementScore(latestA, latestB);
              converged = judgeParsed?.converged === true || score >= 80;
              finalDirection = judgeParsed?.final_direction || latestJudgeDirection;
              unresolvedPoints = judgeParsed?.unresolved_points || [];
              clarifyingQuestions = judgeParsed?.clarifying_questions || [];
              needsInput =
                !converged &&
                round === MAX_CONVERGENCE_ROUNDS &&
                clarifyingQuestions.length > 0;

              send({
                type: "convergence_state",
                round,
                maxRounds: MAX_CONVERGENCE_ROUNDS,
                score,
                status: statusFromScore(score, converged, needsInput),
              });

              transcript.push(
                `Round ${round} Debater A: ${latestA}`,
                `Round ${round} Debater B: ${latestB}`,
                `Round ${round} Judge: ${judgeSynthesis}`,
              );

              if (converged) break;
            }

            if (converged) {
              const executorOutput = await completeOnce({
                apiKey,
                model: convergentModel,
                temperature: 0.35,
                maxTokens: 1100,
                reasoning: { effort: "none", exclude: true },
                messages: [
                  {
                    role: "system",
                    content:
                      "You are the Execution Agent. Turn the judge's converged direction into the final response for the user. Be concrete, actionable, concise, and chat-aware. Do not include code unless explicitly requested.",
                  },
                  {
                    role: "user",
                    content: `Task: ${message}\n\nJudge final direction:\n${finalDirection}\n\nDebater A final:\n${latestA}\n\nDebater B final:\n${latestB}\n\nProduce the final answer.`,
                  },
                ],
              });

              send({
                type: "convergent_log",
                role: "executor",
                round: MAX_CONVERGENCE_ROUNDS,
                content: executorOutput,
              });

              finalContent = executorOutput;
              send({
                type: "convergence_state",
                round: MAX_CONVERGENCE_ROUNDS,
                maxRounds: MAX_CONVERGENCE_ROUNDS,
                score: Math.max(score, 82),
                status: "converged",
              });
              send({ type: "content", content: finalContent });
            } else {
              const fallbackQuestions =
                clarifyingQuestions.length > 0
                  ? clarifyingQuestions
                  : [
                      "What outcome matters most: speed, quality, or cost?",
                      "What constraints are non-negotiable?",
                    ];
              const unresolvedText =
                unresolvedPoints.length > 0
                  ? unresolvedPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")
                  : "The agents disagree on tradeoffs and prioritization details.";

              send({
                type: "clarifying_questions",
                questions: fallbackQuestions,
              });
              send({
                type: "convergence_state",
                round: MAX_CONVERGENCE_ROUNDS,
                maxRounds: MAX_CONVERGENCE_ROUNDS,
                score,
                status: "needs_input",
              });

              finalContent = [
                "The agents have not fully converged yet.",
                "",
                "Current unresolved points:",
                unresolvedText,
                "",
                "Please clarify the following so I can restart convergent thinking with your constraints:",
                ...fallbackQuestions.map((q, i) => `${i + 1}. ${q}`),
              ].join("\n");
              send({ type: "content", content: finalContent });
            }

            send({
              type: "done",
              reasoning: "",
              content: finalContent,
            });
            safeClose();
          } catch (error) {
            console.error("Convergent chat error:", error);
            const messageText =
              "Convergent Thinking Mode ran into an error. Please try again.";
            send({ type: "content", content: messageText });
            send({ type: "done", reasoning: "", content: messageText });
            safeClose();
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
    }

    const enableThinking = convergentThinking;

    // Instant UX for simple social pings in non-convergent chat mode.
    if (!convergentThinking && isShortSocialMessage(message)) {
      const normalized = message.trim().toLowerCase();
      const instantReply =
        /how are you/.test(normalized)
          ? "I am doing well. What can I help you with?"
          : "Hey! How can I help you today?";
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          let partial = "";
          try {
            const words = instantReply.split(" ");
            for (let i = 0; i < words.length; i++) {
              partial += `${i > 0 ? " " : ""}${words[i]}`;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "content",
                    content: partial,
                  })}\n\n`
                )
              );
              await wait(38);
            }

            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "done",
                  reasoning: "",
                  content: instantReply,
                })}\n\n`
              )
            );
            controller.close();
          } catch {
            try {
              controller.close();
            } catch {
              // Client may have disconnected.
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
    }
    const baseMessages: ChatMessage[] = [
      {
        role: "system",
        content: CHAT_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: message,
      },
    ];
    const buildStreamPayload = (includeReasoning: boolean) => {
      const payload: Record<string, unknown> = {
        model: MODEL_IDS[resolvedModel],
        messages: baseMessages,
        stream: true,
        temperature: enableThinking ? 0.7 : 0.45,
        max_tokens: resolvedModel === "nemotron9b" ? 4096 : 8192,
      };
      if (includeReasoning && enableThinking) {
        payload.reasoning = { effort: "high" };
      }
      return payload;
    };

    const requestHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
      "X-Title": "DeepConverge AI",
    };

    let response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(buildStreamPayload(true)),
    });

    if (!response.ok && resolvedModel === "nemotron9b" && !enableThinking) {
      const initialError = await response.text();
      console.warn(
        "9B request failed with default payload; retrying without reasoning hints:",
        initialError
      );
      response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(buildStreamPayload(false)),
      });
    }

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
        let isClosed = false;
        const safeClose = () => {
          if (isClosed) return;
          try {
            controller.close();
          } catch {
            // Stream may already be closed/cancelled by the client.
          } finally {
            isClosed = true;
          }
        };
        const safeEnqueue = (payload: Record<string, unknown>) => {
          if (isClosed) return;
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
            );
          } catch {
            // Avoid throwing ERR_INVALID_STATE after disconnect/close.
            isClosed = true;
          }
        };

        const reader = response.body?.getReader();
        if (!reader) {
          safeClose();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let reasoning = "";
        let content = "";
        const processLine = (line: string) => {
          if (!line.startsWith("data: ")) return;
          const data = line.slice(6);
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            const reasoningChunk = delta?.reasoning || "";
            if (enableThinking && reasoningChunk) {
              reasoning += reasoningChunk;
              safeEnqueue({ type: "reasoning", content: reasoning });
            }

            const contentChunk = delta?.content || "";
            if (contentChunk) {
              content += contentChunk;
              safeEnqueue({ type: "content", content });
            }
          } catch {
            // Skip invalid JSON
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              processLine(line);
            }
          }

          // Flush any remaining decoder/buffer tail to avoid clipped last tokens.
          buffer += decoder.decode();
          if (buffer.trim()) {
            const tailLines = buffer.split("\n");
            for (const line of tailLines) {
              processLine(line.trimEnd());
            }
          }

          safeEnqueue({ type: "done", reasoning, content });
          safeClose();
        } catch (error) {
          console.error("Stream error:", error);
          safeClose();
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
