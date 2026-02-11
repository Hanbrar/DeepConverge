"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { preprocessLaTeX } from "@/lib/latex";

interface DebateMessage {
  id: string;
  speaker: "moderator" | "blue" | "red";
  content: string;
  sources: string[];
  reasoning?: string;
  isStreaming?: boolean;
  isVerdict?: boolean;
  round?: number;
}

interface RegularDebateProps {
  question: string;
  rounds: number;
  onComplete?: () => void;
  onBack?: () => void;
}

const normalizeUrl = (value: string): string | null => {
  const trimmed = value.trim().replace(/[),.;!?]+$/, "");
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const parseSourceUrls = (value: unknown): string[] => {
  const urls = new Set<string>();

  const ingest = (entry: unknown) => {
    if (!entry) return;

    if (typeof entry === "string") {
      const normalized = normalizeUrl(entry);
      if (normalized) urls.add(normalized);
      return;
    }

    if (Array.isArray(entry)) {
      for (const item of entry) ingest(item);
      return;
    }

    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const candidates = [
        record.url,
        record.href,
        record.link,
        record.source,
        record.citation,
      ];

      for (const candidate of candidates) ingest(candidate);
      if (Array.isArray(record.sources)) ingest(record.sources);
      if (Array.isArray(record.citations)) ingest(record.citations);
    }
  };

  ingest(value);
  return [...urls];
};

const mergeSourceUrls = (existing: string[], incoming: unknown): string[] => {
  const merged = new Set<string>(existing);
  for (const url of parseSourceUrls(incoming)) merged.add(url);
  return [...merged];
};

const formatSourceLabel = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const parseSseEvents = (buffer: string) => {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events: { data: string; event?: string }[] = [];
  let remaining = normalized;

  let delimiterIndex = remaining.indexOf("\n\n");
  while (delimiterIndex !== -1) {
    const rawEvent = remaining.slice(0, delimiterIndex);
    remaining = remaining.slice(delimiterIndex + 2);

    if (rawEvent.trim()) {
      const lines = rawEvent.split("\n");
      const dataLines: string[] = [];
      let eventType: string | undefined;

      for (const line of lines) {
        if (!line || line.startsWith(":")) continue;
        const [field, ...rest] = line.split(":");
        const value = rest.join(":").trimStart();
        if (field === "data") dataLines.push(value);
        if (field === "event") eventType = value;
      }

      if (dataLines.length > 0) {
        events.push({ data: dataLines.join("\n"), event: eventType });
      }
    }

    delimiterIndex = remaining.indexOf("\n\n");
  }

  return { events, remaining };
};

export default function RegularDebate({
  question,
  rounds,
  onComplete,
  onBack,
}: RegularDebateProps) {
  const [messages, setMessages] = useState<DebateMessage[]>([]);
  const [isDebating, setIsDebating] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const updateMessage = (
    speaker: DebateMessage["speaker"],
    updater: (message: DebateMessage) => DebateMessage,
    fallback?: Partial<DebateMessage>
  ) => {
    setMessages((prev) => {
      const updated = [...prev];
      let index = -1;

      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].speaker === speaker) {
          index = i;
          break;
        }
      }

      if (index === -1) {
        updated.push({
          id: `${speaker}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          speaker,
          content: "",
          sources: [],
          reasoning: "",
          isStreaming: true,
          isVerdict: false,
          round: undefined,
          ...fallback,
        });
        index = updated.length - 1;
      }

      updated[index] = updater(updated[index]);
      return updated;
    });
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    startDebate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDebate = async () => {
    setIsDebating(true);
    setMessages([]);

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 600000);

    try {
      const response = await fetch("/api/debate-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, rounds }),
        signal: abortController.signal,
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseEvents(buffer);
        buffer = parsed.remaining;

        for (const event of parsed.events) {
          const raw = event.data.trim();
          if (!raw) continue;

          try {
            const data = JSON.parse(raw);

            if (data.type === "complete") {
              setIsComplete(true);
              onComplete?.();
              continue;
            }

            if (data.type === "error") continue;

            const speaker = data.speaker as "moderator" | "blue" | "red";
            const fallback: Partial<DebateMessage> = {};
            if (typeof data.round === "number") fallback.round = data.round;
            if (typeof data.isVerdict === "boolean") fallback.isVerdict = data.isVerdict;

            if (data.type === "start") {
              const newMsg: DebateMessage = {
                id: `${speaker}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                speaker,
                content: "",
                sources: [],
                reasoning: "",
                isStreaming: true,
                isVerdict: data.isVerdict || false,
                round: data.round,
              };
              setMessages((prev) => [...prev, newMsg]);
            } else if (data.type === "reasoning") {
              updateMessage(
                speaker,
                (last) => ({
                  ...last,
                  reasoning: typeof data.content === "string" ? data.content : last.reasoning,
                }),
                fallback
              );
            } else if (data.type === "content") {
              updateMessage(
                speaker,
                (last) => ({
                  ...last,
                  content: typeof data.content === "string" ? data.content : last.content,
                  sources: mergeSourceUrls(last.sources, data.sources),
                  isVerdict:
                    typeof data.isVerdict === "boolean" ? data.isVerdict : last.isVerdict,
                  round: typeof data.round === "number" ? data.round : last.round,
                }),
                fallback
              );
            } else if (data.type === "done") {
              updateMessage(
                speaker,
                (last) => ({
                  ...last,
                  content: typeof data.content === "string" ? data.content : last.content,
                  sources: mergeSourceUrls(last.sources, data.sources),
                  isStreaming: false,
                  isVerdict:
                    typeof data.isVerdict === "boolean" ? data.isVerdict : last.isVerdict,
                  round: typeof data.round === "number" ? data.round : last.round,
                }),
                fallback
              );
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }

      if (buffer.trim()) {
        const finalParsed = parseSseEvents(`${buffer}\n\n`);
        for (const event of finalParsed.events) {
          const raw = event.data.trim();
          if (!raw) continue;
          try {
            const data = JSON.parse(raw);
            if (data.type === "complete") {
              setIsComplete(true);
              onComplete?.();
            }
          } catch {
            // Skip invalid JSON
          }
        }
        buffer = "";
      }
    } catch (error) {
      console.error("Debate error:", error);
    } finally {
      clearTimeout(timeoutId);
      setIsDebating(false);
    }
  };

  const getSpeakerStyle = (speaker: string, isVerdict?: boolean) => {
    if (isVerdict) return "border-l-4 border-amber-500 bg-amber-50";
    switch (speaker) {
      case "blue":
        return "border-l-4 border-blue-500 bg-blue-50/80";
      case "red":
        return "border-l-4 border-red-500 bg-red-50/80";
      case "moderator":
        return "border-l-4 border-gray-500 bg-gray-50/80";
      default:
        return "";
    }
  };

  const getSpeakerLabel = (speaker: string) => {
    switch (speaker) {
      case "blue":
        return { name: "Blue Debater", color: "text-blue-700", dot: "bg-blue-500" };
      case "red":
        return { name: "Red Debater", color: "text-red-700", dot: "bg-red-500" };
      case "moderator":
        return { name: "Moderator", color: "text-gray-700", dot: "bg-gray-500" };
      default:
        return { name: speaker, color: "text-gray-700", dot: "bg-gray-500" };
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 bg-gradient-to-b from-[#f5f0f5] to-transparent">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-[#6b7280] hover:text-[#2d2d2d] transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Back
        </button>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#76b900] flex items-center justify-center">
            <span className="text-white font-bold text-sm">K</span>
          </div>
          <span className="font-semibold text-[#2d2d2d]">Debate Mode</span>
        </div>
        <div className="text-xs text-[#6b7280] flex items-center gap-2">
          {isDebating && !isComplete && (
            <>
              <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
              Live
            </>
          )}
          {isComplete && (
            <>
              <span className="w-2 h-2 bg-green-500 rounded-full" />
              Complete
            </>
          )}
        </div>
      </header>

      {/* Messages */}
      <main className="flex-1 pt-20 pb-8 px-4">
        <div className="max-w-3xl mx-auto">
          {/* Topic */}
          <div className="mb-6 bg-white rounded-2xl p-4 shadow-sm border border-[#e5e7eb]">
            <div className="text-xs font-medium text-[#6b7280] uppercase tracking-wider mb-1">
              Debate Topic
            </div>
            <div className="text-[#2d2d2d] font-medium">{question}</div>
            <div className="mt-2 flex items-center gap-4 text-xs text-[#6b7280]">
              <span>{rounds} round{rounds > 1 ? "s" : ""}</span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 bg-blue-500 rounded-full" /> Blue (For)
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 bg-red-500 rounded-full" /> Red (Against)
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 bg-gray-500 rounded-full" /> Moderator
              </span>
            </div>
          </div>

          {/* Message list */}
          <div className="space-y-4">
            {messages.map((msg) => {
              const label = getSpeakerLabel(msg.speaker);
              return (
                <div
                  key={msg.id}
                  className={`rounded-xl p-4 ${getSpeakerStyle(msg.speaker, msg.isVerdict)} ${
                    msg.isVerdict ? "ring-1 ring-amber-300" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-2 h-2 rounded-full ${label.dot}`} />
                    <span className={`text-sm font-bold ${label.color}`}>
                      {label.name}
                      {msg.round ? ` - Round ${msg.round}` : ""}
                      {msg.isVerdict ? " - VERDICT" : ""}
                    </span>
                    {msg.isStreaming && (
                      <span className="text-xs text-[#6b7280] animate-pulse">
                        speaking...
                      </span>
                    )}
                  </div>

                  {msg.reasoning && (
                    <details className="mb-2">
                      <summary className="text-xs text-[#6b7280] cursor-pointer hover:text-[#4b5563]">
                        Show reasoning
                      </summary>
                      <div className="mt-1 text-xs text-[#6b7280] bg-white/60 rounded-lg p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">
                        {msg.reasoning}
                      </div>
                    </details>
                  )}

                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                    >
                      {preprocessLaTeX(msg.content || "...")}
                    </ReactMarkdown>
                    {msg.isStreaming && msg.content && (
                      <span className="inline-block w-1.5 h-3 bg-current/30 animate-pulse ml-0.5" />
                    )}
                  </div>

                  {msg.sources.length > 0 && (
                    <div className="mt-3 border-t border-[#d1d5db] pt-2">
                      <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#6b7280]">
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 11-5.656-5.656l1.5-1.5m8.828-1.5l1.5-1.5a4 4 0 015.656 5.656l-3 3a4 4 0 01-5.656 0" />
                        </svg>
                        Sources
                      </div>
                      <div className="flex flex-col gap-1">
                        {msg.sources.map((sourceUrl, index) => (
                          <a
                            key={`${msg.id}-source-${index}`}
                            href={sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-xs text-[#2563eb] hover:text-[#1d4ed8] hover:underline break-all"
                          >
                            <svg className="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 3h7m0 0v7m0-7L10 14m-4 3h5a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v5a2 2 0 002 2z" />
                            </svg>
                            {formatSourceLabel(sourceUrl)}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </main>
    </div>
  );
}
