import { NextRequest } from "next/server";
import { createWorker, PSM } from "tesseract.js";

export const runtime = "nodejs";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const MODEL_IDS = {
  nemotron9b: "nvidia/nemotron-nano-9b-v2:free",
  nemotron30b: "nvidia/nemotron-3-nano-30b-a3b:free",
} as const;
const VISION_MODEL_ID = "nvidia/nemotron-nano-12b-v2-vl:free";

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
  "For sensitive conflicts or political topics, stay factual and balanced; do not advocate for one side.",
  "Do not expose private chain-of-thought.",
].join(" ");

const CHAT_SAFETY_POLICY_PROMPT = [
  "Do not provide step-by-step instructions for building weapons, explosives, or synthesizing illegal drugs.",
  "Do not provide instructions for self-harm or suicide methods.",
  "For everything else, answer helpfully and factually.",
].join(" ");

const CHAT_WEB_SEARCH_PROMPT = [
  "Web search results have been provided as context below the user's question.",
  "Use these results to ground your answer in current, factual information.",
  "Cite sources naturally when relevant. Focus on answering the user's question directly.",
].join(" ");

const BLOCKED_CHAT_PATTERNS: RegExp[] = [
  /\b(help me|teach me|show me|guide me|how (do|to) (i|we))\b.{0,80}\b(make|build|create|assemble|acquire)\b.{0,80}\b(bomb|explosive|weapon|gun|poison)\b/i,
  /\b(how to|best way to|method to|ways to)\b.{0,60}\b(kill|murder|assassinate|stab|shoot|poison)\b/i,
  /\b(make|cook|synthesize|produce)\b.{0,40}\b(meth|fentanyl|heroin|cocaine|illegal drug)\b/i,
  /\b(how to|ways to|method to)\b.{0,60}\b(self-harm|kill myself|commit suicide)\b/i,
];

const MAX_CONVERGENCE_ROUNDS = 4;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const PDF_MAX_CHARS = 60000;
const PDF_CHUNK_CHARS = 3800;
const PDF_MAX_CHUNKS = 8;
const PDF_OCR_MAX_PAGES = 8;
const PDF_NATIVE_MAX_PAGES = 30;
const PDF_OCR_RENDER_SCALE = 2;

function isShortSocialMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length > 60) return false;
  return /^(hi|hello|hey|yo|sup|what'?s up|thanks|thank you|ok|okay|cool|nice|good (morning|afternoon|evening)|how are you)[!,.?\s]*$/.test(
    normalized
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withSafetySystem(
  message: string,
  opts?: { webSearchEnabled?: boolean }
): ChatMessage {
  const parts = [message, CHAT_SAFETY_POLICY_PROMPT];
  if (opts?.webSearchEnabled) {
    parts.push(CHAT_WEB_SEARCH_PROMPT);
  }
  return {
    role: "system",
    content: parts.join(" "),
  };
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchWeb(
  query: string,
  maxResults = 6
): Promise<WebSearchResult[]> {
  const results: WebSearchResult[] = [];

  // Strategy 1: DuckDuckGo HTML search (real web results, no API key)
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(ddgUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    if (resp.ok) {
      const html = await resp.text();
      const titleRe =
        /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRe =
        /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      const titles = [...html.matchAll(titleRe)];
      const snippets = [...html.matchAll(snippetRe)];
      const cleanHtml = (s: string) =>
        s
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&#x27;/g, "'")
          .replace(/&quot;/g, '"')
          .trim();
      for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
        const rawUrl = titles[i][1];
        const actualUrl = rawUrl.includes("uddg=")
          ? decodeURIComponent(
              rawUrl.split("uddg=")[1]?.split("&")[0] || rawUrl
            )
          : rawUrl;
        results.push({
          title: cleanHtml(titles[i][2]),
          url: actualUrl,
          snippet: snippets[i] ? cleanHtml(snippets[i][1]) : "",
        });
      }
    }
  } catch (error) {
    console.error("[web-search] DuckDuckGo error:", error);
  }

  // Strategy 2: Wikipedia fallback if DuckDuckGo returned nothing
  if (results.length === 0) {
    try {
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${maxResults}&origin=*`;
      const resp = await fetch(wikiUrl);
      if (resp.ok) {
        const data = await resp.json();
        if (data?.query?.search) {
          for (const item of data.query.search) {
            results.push({
              title: item.title,
              url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
              snippet: (item.snippet || "")
                .replace(/<[^>]+>/g, "")
                .slice(0, 200),
            });
          }
        }
      }
    } catch (error) {
      console.error("[web-search] Wikipedia fallback error:", error);
    }
  }

  console.log(`[web-search] "${query}" → ${results.length} results`);
  return results;
}

function formatSearchContext(results: WebSearchResult[]): string {
  if (results.length === 0) return "";
  const lines = results.map(
    (r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`
  );
  return `Web search results:\n${lines.join("\n\n")}`;
}

function createDoneSseResponse(content: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "content", content })}\n\n`
        )
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "done", reasoning: "", content })}\n\n`
        )
      );
      controller.close();
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

function buildImageAugmentedTask(userMessage: string, imageAnalysis: string): string {
  const normalizedTask = userMessage.trim() || "Analyze the uploaded image and help the user.";
  return [
    `User request: ${normalizedTask}`,
    "Vision context: The uploaded image was analyzed by NVIDIA Nemotron Nano 12B V2 VL.",
    "Use the vision context as factual evidence, then complete the user request clearly and practically.",
    "",
    "Image analysis:",
    imageAnalysis.slice(0, 5000),
  ].join("\n");
}

function decodePdfDataUrl(dataUrl: string): Buffer | null {
  const match = dataUrl.match(/^data:application\/pdf(?:;charset=[^;]+)?;base64,(.+)$/i);
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

function decodeBase64DataUrlToBuffer(dataUrl: string): Buffer | null {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;
  const base64 = dataUrl.slice(commaIndex + 1);
  try {
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

function normalizePdfExtractedText(text: string): string {
  return text
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\S\n]{2,}/g, " ")
    .trim();
}

async function extractPdfTextNative(data: Buffer): Promise<{
  text: string;
  pageCount: number;
  warning?: string;
}> {
  let loadedPdf: { destroy: () => Promise<void> } | null = null;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
    });
    const pdf = await loadingTask.promise;
    loadedPdf = pdf as unknown as { destroy: () => Promise<void> };

    const pagesToProcess = Math.min(pdf.numPages, PDF_NATIVE_MAX_PAGES);
    if (pagesToProcess <= 0) {
      await pdf.destroy();
      loadedPdf = null;
      return { text: "", pageCount: 0, warning: "This PDF has no pages." };
    }

    const pages: string[] = [];
    for (let pageNum = 1; pageNum <= pagesToProcess; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const items = textContent.items as Array<{ str?: string; hasEOL?: boolean }>;

      let pageText = "";
      for (const item of items) {
        if (typeof item.str === "string") {
          pageText += item.str;
          if (item.hasEOL) pageText += "\n";
        }
      }

      const cleaned = pageText.trim();
      if (cleaned) {
        pages.push(`[Page ${pageNum}] ${cleaned}`);
      }
      page.cleanup();
    }

    const fullText = normalizePdfExtractedText(pages.join("\n\n"));
    await pdf.destroy();
    loadedPdf = null;

    return {
      text: fullText,
      pageCount: pdf.numPages,
      warning:
        pdf.numPages > pagesToProcess
          ? `Only the first ${pagesToProcess} of ${pdf.numPages} pages were extracted.`
          : undefined,
    };
  } catch (err) {
    console.error("Native PDF extraction error:", err);
    return { text: "", pageCount: 0, warning: "Native text extraction failed." };
  } finally {
    if (loadedPdf) {
      try {
        await loadedPdf.destroy();
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}

async function extractPdfTextWithOcr(data: Buffer): Promise<{
  text: string;
  warning?: string;
}> {
  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  let loadedPdf: { destroy: () => Promise<void> } | null = null;

  try {
    const { createCanvas } = await import("@napi-rs/canvas");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
    });
    const pdf = await loadingTask.promise;
    loadedPdf = pdf as { destroy: () => Promise<void> };

    const pagesToProcess = Math.min(pdf.numPages, PDF_OCR_MAX_PAGES);
    if (pagesToProcess <= 0) {
      await pdf.destroy();
      loadedPdf = null;
      return {
        text: "",
        warning: "This PDF has no pages to process.",
      };
    }

    worker = await createWorker("eng", undefined, {
      logger: () => {
        // Keep OCR logs out of normal server output.
      },
    });
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: "1",
    });

    const pages: string[] = [];
    for (let pageNum = 1; pageNum <= pagesToProcess; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: PDF_OCR_RENDER_SCALE });
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
        canvas: canvas as unknown as HTMLCanvasElement,
      }).promise;

      const png = canvas.toBuffer("image/png");
      const ocrResult = await worker.recognize(png);
      const pageText = normalizePdfExtractedText(ocrResult.data.text || "");
      if (pageText) {
        pages.push(`[Page ${pageNum}] ${pageText}`);
      }
      page.cleanup();
    }

    await pdf.destroy();
    loadedPdf = null;
    await worker.terminate();
    worker = null;

    return {
      text: normalizePdfExtractedText(pages.join("\n\n")),
      warning:
        pdf.numPages > pagesToProcess
          ? `Only the first ${pagesToProcess} pages were OCR-processed to keep latency reasonable.`
          : undefined,
    };
  } catch (err) {
    console.error("PDF OCR extraction error:", err);
    return {
      text: "",
      warning: `OCR could not extract readable text from this PDF.${err instanceof Error ? ` (${err.message})` : ""}`,
    };
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        // Ignore worker shutdown errors.
      }
    }
    if (loadedPdf) {
      try {
        await loadedPdf.destroy();
      } catch {
        // Ignore PDF shutdown errors.
      }
    }
  }
}

function hasMeaningfulPdfText(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length < 80) return false;
  const words = compact.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || [];
  const letters = compact.match(/[A-Za-z]/g) || [];
  const noisyRuns = compact.match(/[^\w\s]{4,}/g) || [];
  if (words.length < 12) return false;
  if (letters.length < 30) return false;
  if (noisyRuns.length > 20) return false;
  return true;
}

async function extractPdfText(data: Buffer): Promise<{
  text: string;
  method: "native" | "ocr";
  warning?: string;
}> {
  // Step 1: Try native text extraction (fast, works for digital PDFs)
  const native = await extractPdfTextNative(data);
  if (hasMeaningfulPdfText(native.text)) {
    return { text: native.text, method: "native", warning: native.warning };
  }

  // Step 2: Fall back to OCR (slower, for scanned/image PDFs)
  console.log(
    `Native extraction yielded ${native.text.length} chars (insufficient). Falling back to OCR.`
  );
  const ocr = await extractPdfTextWithOcr(data);
  if (hasMeaningfulPdfText(ocr.text)) {
    return { text: ocr.text, method: "ocr", warning: ocr.warning };
  }

  // Step 3: If OCR also failed but native had SOME text, use it anyway
  if (native.text.trim().length > 20) {
    return {
      text: native.text,
      method: "native",
      warning: "Text quality is low; results may be incomplete.",
    };
  }

  return {
    text: "",
    method: "ocr",
    warning: ocr.warning || native.warning || "No readable text could be extracted.",
  };
}

function chunkText(source: string, chunkSize: number) {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    chunks.push(source.slice(cursor, cursor + chunkSize));
    cursor += chunkSize;
  }
  return chunks;
}

async function summarizePdfForTask(params: {
  apiKey: string;
  model: string;
  userMessage: string;
  extractedText: string;
}) {
  const trimmed = params.extractedText.trim();
  if (!trimmed) {
    return "No readable PDF text was extracted. Ask the user for a clearer PDF or pasted excerpt.";
  }

  const capped = trimmed.slice(0, PDF_MAX_CHARS);
  const chunks = chunkText(capped, PDF_CHUNK_CHARS).slice(0, PDF_MAX_CHUNKS);
  const partials: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkSummary = await completeOnce({
      apiKey: params.apiKey,
      model: params.model,
      temperature: 0.2,
      maxTokens: 550,
      reasoning: { effort: "none", exclude: true },
      messages: [
        {
          role: "system",
          content:
            "You summarize document chunks for downstream task execution. Keep only facts, key points, entities, numbers, and actionable details relevant to the user request.",
        },
        {
          role: "user",
          content: [
            `User request: ${params.userMessage || "Summarize this PDF."}`,
            `Chunk ${i + 1}/${chunks.length}:`,
            chunks[i],
            "Return compact bullets only.",
          ].join("\n\n"),
        },
      ],
    });
    partials.push(chunkSummary);
  }

  if (partials.length === 1) return partials[0];

  return completeOnce({
    apiKey: params.apiKey,
    model: params.model,
    temperature: 0.2,
    maxTokens: 750,
    reasoning: { effort: "none", exclude: true },
    messages: [
      {
        role: "system",
        content:
          "Merge partial PDF summaries into one concise structured brief: key facts, constraints, and useful action items aligned to the user request.",
      },
      {
        role: "user",
        content: [
          `User request: ${params.userMessage || "Summarize this PDF."}`,
          "Partial summaries:",
          partials.join("\n\n"),
          "Return a compact summary with clear sections.",
        ].join("\n\n"),
      },
    ],
  });
}

function buildPdfAugmentedTask(userMessage: string, pdfSummary: string) {
  const normalizedTask = userMessage.trim() || "Analyze the uploaded PDF and help the user.";
  const summary =
    pdfSummary.trim() ||
    "No readable PDF summary available. Ask the user for key excerpts.";
  return [
    `User request: ${normalizedTask}`,
    "Document context: The uploaded PDF was OCR-processed and summarized in chunks.",
    "Use this summarized document context as primary evidence and answer accurately.",
    "",
    "Summarized PDF context:",
    summary.slice(0, 6000),
  ].join("\n");
}

async function analyzeImageWithVision(params: {
  apiKey: string;
  imageDataUrl: string;
  userMessage: string;
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
      model: VISION_MODEL_ID,
      stream: false,
      max_tokens: 1200,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are a vision analysis agent. Return concise, accurate visual observations, extracted text, and relevant details for downstream task execution.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `User prompt: ${params.userMessage || "Analyze this image."}`,
                "Produce: 1) key visual facts, 2) any text/OCR, 3) constraints or ambiguities, 4) short actionable interpretation.",
              ].join("\n"),
            },
            {
              type: "image_url",
              image_url: { url: params.imageDataUrl },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vision model error: ${response.status} - ${errText}`);
  }

  const json = await response.json();
  return extractAssistantText(json);
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
    const webSearchEnabled = body?.webSearch === true;
    const imageDataUrlRaw =
      typeof body?.imageDataUrl === "string" ? body.imageDataUrl.trim() : "";
    const pdfDataUrlRaw =
      typeof body?.pdfDataUrl === "string" ? body.pdfDataUrl.trim() : "";
    const hasImage = imageDataUrlRaw.startsWith("data:image/");
    const hasPdf = pdfDataUrlRaw.startsWith("data:application/pdf");
    const imageBuffer = hasImage ? decodeBase64DataUrlToBuffer(imageDataUrlRaw) : null;
    const pdfBuffer = hasPdf ? decodePdfDataUrl(pdfDataUrlRaw) : null;

    if (!message && !hasImage && !hasPdf) {
      return new Response(JSON.stringify({ error: "Message is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (hasImage && (!imageBuffer || imageBuffer.length > MAX_UPLOAD_BYTES)) {
      return new Response(
        JSON.stringify({ error: "Image upload is invalid or exceeds 10MB limit." }),
        {
          status: 413,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (hasPdf && (!pdfBuffer || pdfBuffer.length > MAX_UPLOAD_BYTES)) {
      return new Response(
        JSON.stringify({ error: "PDF upload is invalid or exceeds 10MB limit." }),
        {
          status: 413,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "API key is required. Please add your OpenRouter API key in Settings." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const rawTask = message || "Analyze the uploaded file.";
    const trimmedUserMessage = message.trim();
    if (trimmedUserMessage) {
      if (BLOCKED_CHAT_PATTERNS.some((pattern) => pattern.test(trimmedUserMessage))) {
        return createDoneSseResponse(
          "I can't help with harmful requests (violence, weapons, terrorism, illegal drugs, abuse, or self-harm). I can help with safe academic or practical topics instead."
        );
      }

    }

    // Product rule: Convergent Off -> 9B chat model, Convergent On -> 30B workflow model.
    const resolvedModel: ChatModel = convergentThinking ? "nemotron30b" : "nemotron9b";
    const resolvedModelId = MODEL_IDS[resolvedModel];

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
            const convergentModel = MODEL_IDS["nemotron30b"];
            let taskMessage = rawTask;

            if (hasImage) {
              send({
                type: "status",
                content: "Analyzing image with the Nemotron Nano 12B V2 model.",
              });
              const imageAnalysis = await analyzeImageWithVision({
                apiKey,
                imageDataUrl: imageDataUrlRaw,
                userMessage: rawTask,
              });
              taskMessage = buildImageAugmentedTask(rawTask, imageAnalysis);
            }

            if (hasPdf) {
              send({
                type: "status",
                content: "Extracting text from PDF...",
              });
              const extraction = pdfBuffer
                ? await extractPdfText(pdfBuffer)
                : { text: "", method: "native" as const, warning: "Invalid PDF payload." };
              if (!extraction.text.trim()) {
                const failMessage = [
                  "I could not extract readable text from this PDF.",
                  extraction.warning || "",
                  "Please upload a clearer PDF or paste the relevant text excerpt.",
                ].join(" ").trim();
                send({ type: "status", content: "PDF extraction failed." });
                send({ type: "content", content: failMessage });
                send({ type: "done", reasoning: "", content: failMessage });
                safeClose();
                return;
              }
              send({
                type: "status",
                content: `PDF text extracted (${extraction.method}). Summarizing for convergent reasoning...`,
              });
              const pdfSummary = await summarizePdfForTask({
                apiKey,
                model: convergentModel,
                userMessage: rawTask,
                extractedText: extraction.text,
              });
              taskMessage = buildPdfAugmentedTask(taskMessage, pdfSummary);
            }

            // ── Web search phase (convergent) ──
            if (webSearchEnabled) {
              send({ type: "web-search-start" });
              const searchResults = await searchWeb(taskMessage);
              send({
                type: "web-search-done",
                results: searchResults.map((r) => ({
                  title: r.title,
                  url: r.url,
                })),
              });
              if (searchResults.length > 0) {
                taskMessage = `${formatSearchContext(searchResults)}\n\nUser question: ${taskMessage}`;
              }
            }

            if (!hasImage && !hasPdf && isShortSocialMessage(rawTask)) {
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
                    withSafetySystem(CHAT_SYSTEM_PROMPT, {
                      webSearchEnabled,
                    }),
                    {
                      role: "user",
                      content: rawTask,
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
                withSafetySystem(
                  "You are the Judge in a convergent-thinking multi-agent workflow. State task framing, evaluation criteria, and convergence target in 3 concise bullets. Keep this productivity-focused and avoid code unless explicitly requested.",
                  { webSearchEnabled }
                ),
                {
                  role: "user",
                  content: `Task: ${taskMessage}`,
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
              `User task: ${taskMessage}`,
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
                  withSafetySystem(
                    "You are Debater A. Produce a concise, practical proposal focused on execution and measurable outcomes. Do not generate code unless explicitly requested.",
                    { webSearchEnabled }
                  ),
                  {
                    role: "user",
                    content: `Task: ${taskMessage}\n\nCurrent context:\n${contextTail}\n\nJudge direction:\n${latestJudgeDirection}\n\nGive your round-${round} position.`,
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
                  withSafetySystem(
                    "You are Debater B. Stress-test assumptions, identify risks, and propose a competing practical path. Do not generate code unless explicitly requested.",
                    { webSearchEnabled }
                  ),
                  {
                    role: "user",
                    content: `Task: ${taskMessage}\n\nContext:\n${contextTail}\n\nDebater A round-${round}:\n${latestA}\n\nJudge direction:\n${latestJudgeDirection}\n\nGive your round-${round} position.`,
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
                  withSafetySystem(
                    "You are the Judge. Compare Debater A vs Debater B and return strict JSON only with keys: convergence_score (0-100), converged (boolean), synthesis, direction_for_next_round, unresolved_points (string array), clarifying_questions (string array), final_direction. Keep synthesis concise and avoid code unless explicitly requested.",
                    { webSearchEnabled }
                  ),
                  {
                    role: "user",
                    content: `Task: ${taskMessage}\n\nDebater A:\n${latestA}\n\nDebater B:\n${latestB}\n\nCurrent round: ${round}\n\nIf convergence is high, set converged=true and final_direction. If convergence is low and this is final round (${MAX_CONVERGENCE_ROUNDS}), include 2-4 clarifying_questions.`,
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
                  withSafetySystem(
                    "You are the Execution Agent. Turn the judge's converged direction into the final response for the user. Be concrete, actionable, concise, and chat-aware. Do not include code unless explicitly requested.",
                    { webSearchEnabled }
                  ),
                  {
                    role: "user",
                    content: `Task: ${taskMessage}\n\nJudge final direction:\n${finalDirection}\n\nDebater A final:\n${latestA}\n\nDebater B final:\n${latestB}\n\nProduce the final answer.`,
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
    let nonConvergentTask = rawTask;

    if (hasImage) {
      const imageAnalysis = await analyzeImageWithVision({
        apiKey,
        imageDataUrl: imageDataUrlRaw,
        userMessage: rawTask,
      });
      nonConvergentTask = buildImageAugmentedTask(rawTask, imageAnalysis);
    }

    if (hasPdf) {
      const extraction = pdfBuffer
        ? await extractPdfText(pdfBuffer)
        : { text: "", method: "native" as const, warning: "Invalid PDF payload." };
      if (!extraction.text.trim()) {
        return createDoneSseResponse(
          [
            "I could not extract readable text from this PDF.",
            extraction.warning || "",
            "Please upload a clearer PDF or paste the relevant text excerpt.",
          ].join(" ").trim()
        );
      }
      const pdfSummary = await summarizePdfForTask({
        apiKey,
        model: resolvedModelId,
        userMessage: rawTask,
        extractedText: extraction.text,
      });
      nonConvergentTask = buildPdfAugmentedTask(nonConvergentTask, pdfSummary);
    }

    // Instant UX for simple social pings in non-convergent chat mode.
    if (!convergentThinking && !hasImage && !hasPdf && isShortSocialMessage(rawTask)) {
      const normalized = rawTask.trim().toLowerCase();
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
            isClosed = true;
          }
        };

        try {
          // ── Web search phase ──
          let searchContext = "";
          if (webSearchEnabled) {
            send({ type: "web-search-start" });
            const searchResults = await searchWeb(nonConvergentTask);
            send({
              type: "web-search-done",
              results: searchResults.map((r) => ({
                title: r.title,
                url: r.url,
              })),
            });
            if (searchResults.length > 0) {
              searchContext = formatSearchContext(searchResults);
            }
          }

          const userContent = searchContext
            ? `${searchContext}\n\nUser question: ${nonConvergentTask}`
            : nonConvergentTask;

          const messages: ChatMessage[] = [
            withSafetySystem(CHAT_SYSTEM_PROMPT, {
              webSearchEnabled: !!searchContext,
            }),
            { role: "user", content: userContent },
          ];

          const requestHeaders = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer":
              process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
            "X-Title": "DeepConverge AI",
          };

          const buildPayload = (includeReasoning: boolean) => {
            const p: Record<string, unknown> = {
              model: resolvedModelId,
              messages,
              stream: true,
              temperature: enableThinking ? 0.7 : 0.45,
              max_tokens: resolvedModel === "nemotron9b" ? 4096 : 8192,
            };
            if (includeReasoning && enableThinking) {
              p.reasoning = { effort: "high" };
            }
            return p;
          };

          let response = await fetch(OPENROUTER_API_URL, {
            method: "POST",
            headers: requestHeaders,
            body: JSON.stringify(buildPayload(true)),
          });

          if (
            !response.ok &&
            resolvedModel === "nemotron9b" &&
            !enableThinking
          ) {
            const initialError = await response.text();
            console.warn(
              "9B request failed; retrying without reasoning hints:",
              initialError
            );
            response = await fetch(OPENROUTER_API_URL, {
              method: "POST",
              headers: requestHeaders,
              body: JSON.stringify(buildPayload(false)),
            });
          }

          if (!response.ok) {
            const errText = await response.text();
            console.error("OpenRouter error:", errText);
            const isUsageLimit =
              response.status === 429 ||
              response.status === 402 ||
              errText.toLowerCase().includes("credits") ||
              errText.toLowerCase().includes("quota") ||
              errText.toLowerCase().includes("rate limit");
            send({
              type: "content",
              content: isUsageLimit
                ? "You've hit your usage limit. Extra usage is coming once beta mode is over. Thank you for testing our product!"
                : "Sorry, there was an error connecting to the AI model. Please try again.",
            });
            send({ type: "done", reasoning: "", content: "" });
            safeClose();
            return;
          }

          // ── Stream OpenRouter response ──
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
                send({ type: "reasoning", content: reasoning });
              }

              const contentChunk = delta?.content || "";
              if (contentChunk) {
                content += contentChunk;
                send({ type: "content", content });
              }
            } catch {
              // Skip invalid JSON
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) processLine(line);
          }

          buffer += decoder.decode();
          if (buffer.trim()) {
            for (const line of buffer.split("\n"))
              processLine(line.trimEnd());
          }

          send({ type: "done", reasoning, content });
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
