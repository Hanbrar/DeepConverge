import { NextRequest } from "next/server";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "nvidia/nemotron-nano-9b-v2:free";
const TOPIC_GUARD_MODEL = "nvidia/nemotron-nano-9b-v2:free";
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

interface TopicGuardResult {
  allow: boolean;
  category:
    | "safe"
    | "violence_or_abuse"
    | "sexual_or_exploitative"
    | "hate_or_extremism"
    | "self_harm"
    | "illegal_activity"
    | "political_or_geopolitical"
    | "high_risk_advice"
    | "other";
  reason: string;
}

// ── System prompts ──────────────────────────────────────────────────

const MODERATOR_SYSTEM = `You are the Moderator in a live debate.
Output only one line that starts with "Moderator:" followed by what you say.
Do not include any other text. No planning, no notes, no formatting.
You MUST pick exactly one winner: Blue or Red. No ties, no draws, no "both sides."
State who won and give one clear reason. End with a short encouraging remark.`;

const MODERATOR_INTRO_SYSTEM = `You are the Moderator in a live debate.
Output only one line that starts with "Moderator:" followed by what you say.
Do not include any other text. No planning, no notes, no formatting.
Introduce the topic and assign sides naturally.`;

const DEBATER_SYSTEM = (side: "FOR" | "AGAINST") =>
  `You are ${side === "FOR" ? "Blue" : "Red"} in a live debate arguing ${side} the proposition.
Output only one line that starts with "${side === "FOR" ? "Blue" : "Red"}:" followed by what you say.
Do not include any other text. No planning, no notes, no formatting.
Speak like a real human. Respond directly to your opponent.`;

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

function stripUrls(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\(https?:\/\/[^)]+\)/g, "")
    .replace(/https?:\/\/[^\s<>"'`]+/g, "")
    .replace(/\b\w+\.(?:com|org|net|edu|gov|io)\S*/gi, "")
    .replace(/  +/g, " ")
    .trim();
}

function extractGuardJson(raw: string): TopicGuardResult | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const candidate =
    fenced ??
    raw.match(/\{[\s\S]*\}/)?.[0] ??
    "";
  if (!candidate) return null;

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const categoryRaw =
      typeof parsed.category === "string" ? parsed.category : "other";
    const category: TopicGuardResult["category"] =
      categoryRaw === "safe" ||
      categoryRaw === "violence_or_abuse" ||
      categoryRaw === "sexual_or_exploitative" ||
      categoryRaw === "hate_or_extremism" ||
      categoryRaw === "self_harm" ||
      categoryRaw === "illegal_activity" ||
      categoryRaw === "political_or_geopolitical" ||
      categoryRaw === "high_risk_advice" ||
      categoryRaw === "other"
        ? categoryRaw
        : "other";

    return {
      allow: parsed.allow === true,
      category,
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : "Topic did not pass moderation.",
    };
  } catch {
    return null;
  }
}

// ── Smart extraction ────────────────────────────────────────────────
// Instead of pattern-matching CoT (whack-a-mole), we extract the
// model's actual spoken answer from its reasoning output.
//
// The model's reasoning typically looks like:
//   [Planning about what to say...]
//   [Meta about formatting/counting...]
//   [The actual debate speech]
//   [Maybe more meta-counting...]
//   [Possibly a refined version]
//
// Strategy:
//   1. Look for quoted final answers (model wraps them in quotes)
//   2. Look for answer markers ("Thus final answer:", etc.)
//   3. Split into sentences, reject meta-sentences, keep speech
//   4. Prefer sentences from the END (where the actual answer lives)

/** Words/phrases that indicate internal planning, not spoken debate */
const META_SIGNALS = [
  "must be", "need to", "we need", "let's ", "should cite", "should be",
  "characters", "char count", "word count", "bullet point", "bullet ",
  "markdown", "citation", "formatting", "sentence count", "numbered list",
  "the user", "the instruction", "approximate", "response length",
  "domain link", "counter red", "counter blue", "opening argument",
  "present your", "incorporate", "web search", "search results",
  "include citation", "argue for or against", "could cite", "could use",
  "they want", "probably yes", "probably not", "probably need",
  "let's craft", "let's count", "let's keep", "let's try", "let's make",
  "thus final", "final answer", "final response", "final version",
  "here is my", "here are my", "my response", "my answer", "my argument",
  "keep under", "keep within", "under 400", "under 500", "that's ",
  "use at most", "max 3", "max 4", "1-3-4", "3-4 bullet",
  "punchy sentence", "directly counter", "be respectful", "be rigorous",
  "output only", "spoken words", "start directly", "not aggressive",
  "use conversational", "frontiersin", "wiley.com", "psychiatryonline",
  "wikipedia", "deliver your verdict", "who won", "be decisive",
  "[blue]", "[red]", "blue debater", "red debater", "blue's", "red's",
  "so maybe", "actually we", "actually they", "link with", "domain is",
  "total char", "how many char", "how many word", "now deliver",
  "but they want", "that domain", "that is okay", "that likely",
  "that suggests", "can also", "we can", "we should",
  "documented in", "according to", "studies show", "research shows",
  "the article", "the study", "published in", "as reported",
  "check out", "refer to", "as noted in", "evidence from",
  "data shows", "data suggests", "a study", "one study",
  "researchers found", "researchers have", "the research",
  "the evidence", "the data", "peer-reviewed", "meta-analysis",
  "clinical trial", "randomized control", "literature review",
  "journal of", "university of", "institute of",
  "no sources", "without sources", "missing sources",
  "i don't have", "i cannot verify", "i can't verify",
];

function isMetaSentence(s: string): boolean {
  const lower = s.toLowerCase();
  if (lower.length < 15) return true; // too short to be real speech
  return META_SIGNALS.some((kw) => lower.includes(kw));
}

/** Try to extract a quoted final answer from the model output */
function tryExtractQuoted(text: string): string | null {
  // Look for text after "Let's craft:" or "Thus final answer:" in quotes
  const markerQuoteRe =
    /(?:let's craft|thus final answer|final answer|final version)[:\s]*"([^"]{20,})"/gi;
  const matches = [...text.matchAll(markerQuoteRe)];
  if (matches.length > 0) {
    return matches[matches.length - 1][1]; // take the last one
  }

  // Look for text after answer markers (not in quotes)
  const markerRe =
    /(?:thus final answer|final answer|final version|final response)[:\s]*([\s\S]{20,})/i;
  const markerMatch = text.match(markerRe);
  if (markerMatch) {
    // Take everything after the marker, up to the next meta section
    const afterMarker = markerMatch[1].trim();
    // Split into sentences and take clean ones
    const sentences = afterMarker.match(/[^.!?]+[.!?]+/g) || [];
    const clean = sentences.filter((s) => !isMetaSentence(s.trim()));
    if (clean.length > 0) return clean.join(" ").trim();
  }

  return null;
}

/** Extract the spoken line after a speaker prefix (e.g. "Moderator:", "Blue:", "Red:") */
function extractPrefixedLine(rawText: string, prefix: string): string | null {
  // Find ALL occurrences of the prefix, take the LAST one (most refined)
  const re = new RegExp(`${prefix}:\\s*`, "gi");
  let lastIndex = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rawText)) !== null) {
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex === -1) return null;

  // Take everything after the prefix until end or next speaker prefix
  const afterPrefix = rawText.slice(lastIndex);
  const nextSpeaker = afterPrefix.search(/\n\s*(?:Moderator|Blue|Red):/i);
  const spoken = nextSpeaker > 0 ? afterPrefix.slice(0, nextSpeaker) : afterPrefix;
  const cleaned = spoken.trim();
  return cleaned.length > 10 ? cleaned : null;
}

/** Extract actual debate speech from raw model output */
function extractSpeech(rawText: string, maxLen: number, speaker: string): string {
  const noUrls = stripUrls(rawText);

  // Strategy 0: prefix extraction (strongest — model told to use "Speaker: ...")
  const prefixed = extractPrefixedLine(noUrls, speaker);
  if (prefixed) {
    const cleaned = stripFormatting(prefixed);
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
  }

  // Strategy 1: quoted/marked final answer
  const quoted = tryExtractQuoted(noUrls);
  if (quoted) {
    const cleaned = stripFormatting(quoted);
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
  }

  // Strategy 2: sentence-level filtering
  const flat = stripFormatting(noUrls);
  const sentences = flat.match(/[^.!?]+[.!?]+/g) || [flat];
  const cleanSentences = sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 15)
    .filter((s) => !isMetaSentence(s));

  if (cleanSentences.length > 0) {
    let result = "";
    for (let i = cleanSentences.length - 1; i >= 0; i--) {
      const candidate = cleanSentences[i] + (result ? " " + result : "");
      if (candidate.length > maxLen && result) break;
      result = candidate;
    }
    if (result.trim().length > 20) return result.trim();
  }

  // Strategy 3: last paragraph fallback
  const paragraphs = noUrls
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20);
  if (paragraphs.length > 0) {
    const last = stripFormatting(paragraphs[paragraphs.length - 1]);
    return last.length > maxLen ? last.slice(0, maxLen) : last;
  }

  return flat.slice(-maxLen).trim();
}

/** Convert bullet/dash/numbered formatting to prose */
function stripFormatting(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let t = line.trim();
      t = t.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "");
      return t;
    })
    .filter((l) => l.length > 1)
    .join(" ")
    .replace(/  +/g, " ")
    .trim();
}

/** Strip markdown, em dashes, and ensure text ends on a complete sentence */
function finalize(text: string): string {
  let result = text;
  // Strip markdown bold/italic
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1"); // **bold**
  result = result.replace(/\*([^*]+)\*/g, "$1");       // *italic*
  result = result.replace(/__([^_]+)__/g, "$1");       // __bold__
  result = result.replace(/_([^_]+)_/g, "$1");          // _italic_
  result = result.replace(/#{1,6}\s+/g, "");            // # headings
  // Strip em dashes
  result = result.replace(/\u2014/g, ", ").replace(/\u2013/g, ", ");
  // Collapse double commas/spaces from replacement
  result = result.replace(/,\s*,/g, ",").replace(/  +/g, " ").trim();
  // Ensure it ends on a complete sentence
  const lastEnd = Math.max(
    result.lastIndexOf("."),
    result.lastIndexOf("!"),
    result.lastIndexOf("?")
  );
  if (lastEnd > 20) {
    result = result.slice(0, lastEnd + 1);
  }
  return result.trim();
}

/** Clean debate content: extract speech, enforce length, finalize */
function cleanDebateContent(text: string, speaker: "blue" | "red"): string {
  const prefix = speaker === "blue" ? "Blue" : "Red";
  return finalize(extractSpeech(text, 400, prefix));
}

/** Clean moderator content: extract speech, enforce length, finalize */
function cleanModeratorContent(text: string): string {
  return finalize(extractSpeech(text, 500, "Moderator"));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BLOCKED_DEBATE_TOPIC_PATTERNS: RegExp[] = [
  /\b(suicide|self-harm|kill myself|how to die)\b/i,
  /\b(rape|sexual assault|child porn|cp|incest)\b/i,
  /\b(bomb|explosive|terror attack|mass shooting|ethnic cleansing)\b/i,
  /\b(genocide|racial superiority|hate crime)\b/i,
  /\b(how to make meth|hard drug recipe|weapon build)\b/i,
  /\b(election|vote|voting|campaign|candidate|senate|congress|prime minister|president)\b/i,
  /\b(israel|palestine|ukraine|russia|china[-\s]?taiwan|geopolitical)\b/i,
];

function validateDebateQuestion(question: string): {
  allowed: boolean;
  error?: string;
} {
  const trimmed = question.trim();
  if (trimmed.length < 6) {
    return { allowed: false, error: "Please provide a clearer debate topic." };
  }
  if (trimmed.length > 240) {
    return {
      allowed: false,
      error: "Debate topics must be under 240 characters for now.",
    };
  }
  if (BLOCKED_DEBATE_TOPIC_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return {
      allowed: false,
      error:
        "This debate topic is blocked for safety. Please use a neutral, constructive topic.",
    };
  }
  return { allowed: true };
}

async function moderateDebateQuestionWithGuardModel(
  question: string
): Promise<TopicGuardResult> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY not configured");
  }

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
      "X-Title": "DeepConverge Debate Topic Guard",
    },
    body: JSON.stringify({
      model: TOPIC_GUARD_MODEL,
      stream: false,
      temperature: 0,
      max_tokens: 220,
      reasoning: { effort: "none", exclude: true },
      messages: [
        {
          role: "system",
          content: [
            "You are a safety gate for an entertainment/academic debate app.",
            "Classify whether the topic is allowed.",
            "Block violent abuse, sexual exploitation, self-harm, hate/extremism, illegal wrongdoing, and high-risk advice.",
            "Also block politically sensitive or geopolitical topics (elections, campaigns, politicians, conflicts).",
            "Allow only neutral, constructive, low-risk topics suitable for general audiences.",
            "Respond with strict JSON only:",
            '{"allow": boolean, "category": "safe|violence_or_abuse|sexual_or_exploitative|hate_or_extremism|self_harm|illegal_activity|political_or_geopolitical|high_risk_advice|other", "reason": "short reason"}',
          ].join(" "),
        },
        {
          role: "user",
          content: `Debate topic: "${question.trim()}"`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Topic guard API error: ${response.status} - ${errText}`);
  }

  const payload = await response.json();
  const firstChoice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const raw =
    extractText(firstChoice?.message?.content) ||
    extractText(firstChoice?.message?.reasoning);
  const parsed = extractGuardJson(raw);
  if (parsed) return parsed;

  // Fail closed if guard output is malformed.
  return {
    allow: false,
    category: "other",
    reason: "Topic guard could not validate this request safely.",
  };
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
        "X-Title": `DeepConverge Debate - ${label}`,
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
    const moderation = validateDebateQuestion(question);
    if (!moderation.allowed) {
      return new Response(
        JSON.stringify({
          error:
            moderation.error ||
            "This debate topic is blocked for safety.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    if (!OPENROUTER_API_KEY) {
      return new Response(
        JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    let guardResult: TopicGuardResult;
    try {
      guardResult = await moderateDebateQuestionWithGuardModel(question);
    } catch (error) {
      console.error("Topic guard error:", error);
      return new Response(
        JSON.stringify({
          error:
            "Debate topic safety check is temporarily unavailable. Please try again.",
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (!guardResult.allow) {
      return new Response(
        JSON.stringify({
          error:
            "This topic is blocked in Debate Mode. Please choose a neutral, academic, or entertainment topic.",
          reason: guardResult.reason,
          category: guardResult.category,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const clampedRounds = Math.min(Math.max(1, rounds), 5);
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

          // ── COIN TOSS (speaking order) ─────────────────────
          const blueFirst = Math.random() < 0.5;
          const coinResult = blueFirst ? "Heads" : "Tails";
          const firstSpeaker = blueFirst ? "Blue" : "Red";
          console.log(`[debate-mode] coin toss: ${coinResult} → ${firstSpeaker} speaks first`);

          // ── MODERATOR INTRO ─────────────────────────────────
          console.log("[debate-mode] moderator-intro: start");
          send({ speaker: "moderator", type: "start" });

          const modIntroMessages: ChatMessage[] = [
            { role: "system", content: MODERATOR_INTRO_SYSTEM },
            {
              role: "user",
              content: `The debate topic is: "${question}"\n\nBlue argues FOR. Red argues AGAINST.\n\nCoin toss result: ${coinResult}. ${firstSpeaker} speaks first.`,
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
          // Flat alternating loop: speaker A → speaker B → A → B ...
          // Each speaker ONLY sees opponent's last message, never own prior output.
          const order: ("blue" | "red")[] = blueFirst
            ? ["blue", "red"]
            : ["red", "blue"];

          // Build flat turn sequence
          const turns: ("blue" | "red")[] = [];
          for (let r = 0; r < clampedRounds; r++) {
            for (const s of order) turns.push(s);
          }

          let lastBlueMsg = "";
          let lastRedMsg = "";

          for (let i = 0; i < turns.length; i++) {
            if (isClosed) break;

            const speaker = turns[i];
            const isFor = speaker === "blue";
            const opponent = isFor ? "Red" : "Blue";
            const round = Math.floor(i / 2) + 1;
            const label = `${speaker}-r${round}`;
            console.log(`[debate-mode] ${label}: start`);
            send({ speaker, type: "start", round });

            // Only feed opponent's last message (never own prior output)
            const opponentLastMsg = isFor ? lastRedMsg : lastBlueMsg;

            let userContent: string;
            if (i === 0) {
              // First speaker: only has moderator intro
              userContent = `Topic: "${question}"\n\nThe moderator said: ${cleanedModIntro}\n\nMake your case.`;
            } else {
              // Every subsequent turn: only opponent's last message
              userContent = `Topic: "${question}"\n\n${opponent} just said: ${opponentLastMsg}\n\nRespond directly.`;
            }

            const messages: ChatMessage[] = [
              { role: "system", content: DEBATER_SYSTEM(isFor ? "FOR" : "AGAINST") },
              { role: "user", content: userContent },
            ];

            let turnContent = "";

            for await (const chunk of streamFromOpenRouter(messages, label)) {
              if (isClosed) break;
              if (chunk.type === "content" && chunk.text) {
                turnContent += chunk.text;
              }
            }

            const cleaned = cleanDebateContent(turnContent, speaker);
            console.log(`[debate-mode] ${label}: done (${cleaned.length} chars)`);
            send({ speaker, type: "done", content: cleaned });
            debateHistory.push({ speaker, content: cleaned });

            // Track last message per speaker (feeds into opponent's next turn)
            if (speaker === "blue") lastBlueMsg = cleaned;
            else lastRedMsg = cleaned;
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
              content: `Topic: "${question}"\n\nThe debate:\n${fullDebateContext}\n\nWho won and why?`,
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
