"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";

interface DebateMessage {
  id: string;
  speaker: "moderator" | "blue" | "red";
  content: string;
  displayedContent: string;
  isStreaming?: boolean;
  isVerdict?: boolean;
  round?: number;
}

interface DebateCanvasProps {
  question: string;
  rounds: number;
  onComplete?: () => void;
  onBack?: () => void;
}

interface SavedDebate {
  question: string;
  messages: DebateMessage[];
  researchSources: { blue: string[]; red: string[] };
  isComplete: boolean;
  savedAt: number;
}

const CHARS_PER_FRAME = 2;
const FRAME_DELAY = 35; // ms between frames (~57 chars/sec)
const STORAGE_KEY = "kangaroo-debate-log";

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

export default function DebateCanvas({
  question,
  rounds,
  onComplete,
  onBack,
}: DebateCanvasProps) {
  const [messages, setMessages] = useState<DebateMessage[]>([]);
  const [isDebating, setIsDebating] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [isResearching, setIsResearching] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [researchSources, setResearchSources] = useState<{ blue: string[]; red: string[] }>({ blue: [], red: [] });

  const logContainerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const hasStartedRef = useRef(false);

  // ── Save to localStorage whenever messages or sources change ──
  const saveToStorage = useCallback(() => {
    try {
      const data: SavedDebate = {
        question,
        messages: messages.map((m) => ({ ...m, displayedContent: m.content, isStreaming: false })),
        researchSources,
        isComplete,
        savedAt: Date.now(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Storage full or unavailable
    }
  }, [question, messages, researchSources, isComplete]);

  useEffect(() => {
    if (messages.length > 0) {
      saveToStorage();
    }
  }, [messages, saveToStorage]);

  // ── Load from localStorage on mount ──
  useEffect(() => {
    if (hasStartedRef.current) return;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data: SavedDebate = JSON.parse(stored);
        // Only restore if same question and less than 1 hour old
        if (data.question === question && Date.now() - data.savedAt < 3600000) {
          setMessages(data.messages);
          setResearchSources(data.researchSources);
          if (data.isComplete) {
            setIsComplete(true);
            hasStartedRef.current = true;
            return;
          }
        }
      }
    } catch {
      // Invalid stored data
    }
  }, [question]);

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
          displayedContent: "",
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

  // ── Typewriter: runs every frame, reveals chars one at a time ──
  useEffect(() => {
    let running = true;

    const tick = (timestamp: number) => {
      if (!running) return;

      if (timestamp - lastTickRef.current >= FRAME_DELAY) {
        lastTickRef.current = timestamp;

        setMessages((prev) => {
          let needsUpdate = false;
          for (const msg of prev) {
            if (msg.displayedContent.length < msg.content.length) {
              needsUpdate = true;
              break;
            }
          }

          if (!needsUpdate) return prev;

          const updated = [...prev];
          for (let i = 0; i < updated.length; i++) {
            const msg = updated[i];
            if (msg.displayedContent.length < msg.content.length) {
              const newLen = Math.min(
                msg.displayedContent.length + CHARS_PER_FRAME,
                msg.content.length
              );
              updated[i] = {
                ...msg,
                displayedContent: msg.content.slice(0, newLen),
              };
              break;
            }
          }
          return updated;
        });
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ── Auto-scroll debate log ──
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  });

  // ── Start debate on mount ──
  useEffect(() => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;
    startDebate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDebate = async () => {
    setIsDebating(true);
    setMessages([]);
    setResearchSources({ blue: [], red: [] });
    setIsComplete(false);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }

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

            // ── Research phase events ──
            if (data.type === "research-start") {
              setIsResearching(true);
              continue;
            }

            if (data.type === "research-done") {
              const speaker = data.speaker as "blue" | "red";
              const sources = Array.isArray(data.sources) ? data.sources : [];
              setResearchSources((prev) => ({ ...prev, [speaker]: sources }));
              // Check if both sides done
              if (speaker === "red") {
                setIsResearching(false);
              }
              continue;
            }

            if (data.type === "complete") {
              setIsComplete(true);
              setActiveSpeaker(null);
              onComplete?.();
              continue;
            }

            if (data.type === "error") {
              console.error("Debate error:", data.message);
              continue;
            }

            const speaker = data.speaker as "moderator" | "blue" | "red";
            const fallback: Partial<DebateMessage> = {};
            if (typeof data.round === "number") fallback.round = data.round;
            if (typeof data.isVerdict === "boolean") fallback.isVerdict = data.isVerdict;

            if (data.type === "start") {
              setActiveSpeaker(speaker);
              setMessages((prev) => [
                ...prev,
                {
                  id: `${speaker}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  speaker,
                  content: "",
                  displayedContent: "",
                  isStreaming: true,
                  isVerdict: data.isVerdict || false,
                  round: data.round,
                },
              ]);
            } else if (data.type === "content") {
              updateMessage(
                speaker,
                (last) => {
                  const nextContent =
                    typeof data.content === "string" ? data.content : last.content;
                  let nextDisplayed = last.displayedContent;
                  if (!nextDisplayed && nextContent) {
                    const initialLen = Math.min(CHARS_PER_FRAME, nextContent.length);
                    nextDisplayed = nextContent.slice(0, initialLen);
                  }
                  return {
                    ...last,
                    content: nextContent,
                    displayedContent: nextDisplayed,
                    isVerdict:
                      typeof data.isVerdict === "boolean" ? data.isVerdict : last.isVerdict,
                    round: typeof data.round === "number" ? data.round : last.round,
                    isStreaming: true,
                  };
                },
                fallback
              );
            } else if (data.type === "done") {
              updateMessage(
                speaker,
                (last) => {
                  const finalContent =
                    typeof data.content === "string" ? data.content : last.content;
                  return {
                    ...last,
                    content: finalContent,
                    isStreaming: false,
                    isVerdict:
                      typeof data.isVerdict === "boolean" ? data.isVerdict : last.isVerdict,
                    round: typeof data.round === "number" ? data.round : last.round,
                  };
                },
                fallback
              );
              setActiveSpeaker(null);
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
              setActiveSpeaker(null);
              onComplete?.();
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    } catch (error) {
      console.error("Debate stream error:", error);
    } finally {
      clearTimeout(timeoutId);
      setIsDebating(false);
    }
  };

  // ── Helpers ──
  const isMsgTyping = (msg: DebateMessage) =>
    msg.displayedContent.length < msg.content.length;

  const getLatestMessage = (speaker: "moderator" | "blue" | "red") => {
    const speakerMessages = messages.filter((m) => m.speaker === speaker);
    return speakerMessages.length > 0 ? speakerMessages[speakerMessages.length - 1] : null;
  };

  const latestBlue = getLatestMessage("blue");
  const latestRed = getLatestMessage("red");
  const latestModerator = getLatestMessage("moderator");

  // ── Speech bubble above avatar ──
  const renderSpeechBubble = (
    msg: DebateMessage | null,
    speaker: "moderator" | "blue" | "red"
  ) => {
    const isActive = activeSpeaker === speaker;
    const text = msg?.displayedContent || "";
    const hasContent = text.trim().length > 0;

    if (!hasContent && !isActive) return null;

    const styles = {
      blue: { border: "border-blue-400", bg: "bg-blue-50/90", ring: "ring-blue-400", label: "text-blue-600", text: "text-blue-900", dot: "bg-blue-500", cls: "speech-bubble-blue" },
      red: { border: "border-red-400", bg: "bg-red-50/90", ring: "ring-red-400", label: "text-red-600", text: "text-red-900", dot: "bg-red-500", cls: "speech-bubble-red" },
      moderator: { border: "border-gray-400", bg: "bg-white/90", ring: "ring-gray-400", label: "text-gray-600", text: "text-gray-800", dot: "bg-gray-500", cls: "speech-bubble-mod" },
    };
    const s = styles[speaker];
    const preview = text.length > 100 ? "..." + text.slice(-100) : text;

    return (
      <div className={`${s.cls} relative mb-3 w-full rounded-2xl border-2 ${s.border} ${s.bg} backdrop-blur-sm px-4 py-3 shadow-lg ${isActive ? `ring-2 ${s.ring} ring-opacity-50 animate-pulse-subtle` : ""}`}>
        {isActive && !hasContent ? (
          <div className={`flex items-center gap-2 ${s.label} text-sm font-medium`}>
            <span className={`w-2 h-2 ${s.dot} rounded-full animate-pulse`} />
            Thinking...
          </div>
        ) : (
          <p className={`${s.text} text-base leading-relaxed whitespace-pre-wrap`}>
            {preview}
            {msg && isMsgTyping(msg) && (
              <span className={`inline-block w-1.5 h-4 ${s.dot} opacity-60 animate-pulse ml-0.5 align-middle`} />
            )}
          </p>
        )}
      </div>
    );
  };

  // ── Source icons beside avatar ──
  const renderSourceIcons = (speaker: "blue" | "red", accentColor: string) => {
    const sources = researchSources[speaker];
    if (sources.length === 0) return null;

    return (
      <div className="flex flex-col gap-1.5 mb-6">
        <span className="text-[9px] font-bold uppercase tracking-wider text-gray-400 text-center">Sources</span>
        {sources.map((url, i) => (
          <a
            key={`${speaker}-src-${i}`}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={formatSourceLabel(url)}
            className={`group w-9 h-9 rounded-lg bg-white border-2 ${accentColor} flex items-center justify-center hover:scale-110 transition-all shadow-md`}
          >
            <span className="text-xs font-bold text-gray-600 group-hover:text-gray-900">
              {formatSourceLabel(url).charAt(0).toUpperCase()}
            </span>
          </a>
        ))}
      </div>
    );
  };

  const chatBubbleStyle = (speaker: string) => {
    switch (speaker) {
      case "blue": return "bg-blue-50 border-blue-200";
      case "red": return "bg-red-50 border-red-200";
      case "moderator": return "bg-gray-50 border-gray-200";
      default: return "bg-white border-gray-200";
    }
  };

  const speakerTag = (msg: DebateMessage) => {
    const names: Record<string, string> = { blue: "Blue", red: "Red", moderator: "Moderator" };
    const colors: Record<string, string> = { blue: "bg-blue-500 text-white", red: "bg-red-500 text-white", moderator: "bg-gray-600 text-white" };
    let label = names[msg.speaker] || msg.speaker;
    if (msg.round) label += ` - Round ${msg.round}`;
    if (msg.isVerdict) label += " - VERDICT";

    return (
      <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full ${colors[msg.speaker]}`}>
        {label}
        {isMsgTyping(msg) && <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />}
      </span>
    );
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center justify-between px-6 py-4 bg-gradient-to-b from-[#f5f0f5] to-transparent z-50">
        <button onClick={onBack} className="flex items-center gap-2 text-[#6b7280] hover:text-[#2d2d2d] transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#76b900] flex items-center justify-center">
            <span className="text-white font-bold text-sm">K</span>
          </div>
          <span className="font-semibold text-[#2d2d2d]">Debate Arena</span>
        </div>
        <div className="text-xs text-[#6b7280] flex items-center gap-2">
          {isResearching && (
            <><span className="w-2 h-2 bg-purple-500 rounded-full animate-pulse" />Researching...</>
          )}
          {isDebating && !isComplete && !isResearching && (
            <><span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />Live</>
          )}
          {isComplete && (
            <><span className="w-2 h-2 bg-green-500 rounded-full" />Complete</>
          )}
        </div>
      </header>

      {/* Topic bar */}
      <div className="flex-shrink-0 px-6 py-2 z-40">
        <div className="max-w-5xl mx-auto bg-white/80 backdrop-blur-sm rounded-full px-5 py-2 text-center text-sm text-[#4b5563] shadow-sm border border-[#e5e7eb]">
          <span className="font-medium text-[#2d2d2d]">Topic:</span> {question}
        </div>
      </div>

      {/* Main content */}
      <main className="flex-1 min-h-0 flex flex-col px-4 pb-4">
        <div className="max-w-6xl mx-auto w-full flex-1 min-h-0 flex flex-col">
          {/* Avatar stage */}
          <div className="flex-shrink-0 relative flex items-end justify-between gap-4 px-4 mb-4" style={{ minHeight: "380px" }}>
            {/* Blue */}
            <div className="flex flex-col items-center relative" style={{ width: "280px" }}>
              {renderSpeechBubble(latestBlue, "blue")}
              <div className="flex items-end gap-2">
                <div className={`relative transition-all duration-300 ${activeSpeaker === "blue" ? "scale-105" : "opacity-80"}`}>
                  <Image src="/blue.png" alt="Blue Debater" width={220} height={330} className="object-contain drop-shadow-lg" priority />
                  {activeSpeaker === "blue" && (
                    <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded-full shadow">Speaking...</div>
                  )}
                </div>
                {renderSourceIcons("blue", "border-blue-400")}
              </div>
              <span className="mt-2 text-sm font-bold text-blue-600">BLUE</span>
            </div>

            {/* Moderator */}
            <div className="flex flex-col items-center relative" style={{ width: "280px" }}>
              {renderSpeechBubble(latestModerator, "moderator")}
              <div className={`relative transition-all duration-300 ${activeSpeaker === "moderator" ? "scale-105" : "opacity-80"}`}>
                <Image src="/moderator.png" alt="Moderator" width={220} height={330} className="object-contain drop-shadow-lg" priority />
                {activeSpeaker === "moderator" && (
                  <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 bg-gray-700 text-white text-xs font-bold px-3 py-1 rounded-full shadow">Speaking...</div>
                )}
              </div>
              <span className="mt-2 text-sm font-bold text-gray-600">MODERATOR</span>
            </div>

            {/* Red */}
            <div className="flex flex-col items-center relative" style={{ width: "280px" }}>
              {renderSpeechBubble(latestRed, "red")}
              <div className="flex items-end gap-2">
                {renderSourceIcons("red", "border-red-400")}
                <div className={`relative transition-all duration-300 ${activeSpeaker === "red" ? "scale-105" : "opacity-80"}`}>
                  <Image src="/red.png" alt="Red Debater" width={220} height={330} className="object-contain drop-shadow-lg" priority />
                  {activeSpeaker === "red" && (
                    <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 bg-red-500 text-white text-xs font-bold px-3 py-1 rounded-full shadow">Speaking...</div>
                  )}
                </div>
              </div>
              <span className="mt-2 text-sm font-bold text-red-600">RED</span>
            </div>
          </div>

          {/* Debate log */}
          <div className="flex-1 min-h-0 max-w-3xl mx-auto w-full flex flex-col">
            <div className="flex items-center gap-2 mb-3 px-2 flex-shrink-0">
              <div className="h-px flex-1 bg-[#e5e7eb]" />
              <span className="text-xs font-medium text-[#6b7280] uppercase tracking-wider">Debate Log</span>
              <div className="h-px flex-1 bg-[#e5e7eb]" />
            </div>

            <div className="flex-1 min-h-0 bg-white/60 backdrop-blur-sm rounded-2xl border border-[#e5e7eb] shadow-sm overflow-hidden">
              <div ref={logContainerRef} className="h-full overflow-y-auto p-5 flex flex-col gap-4 debate-log-scroll">
                {messages.length === 0 && !isResearching && (
                  <div className="flex-1 flex items-center justify-center text-[#9ca3af] text-sm">Debate starting...</div>
                )}

                {isResearching && messages.length === 0 && (
                  <div className="flex-1 flex flex-col items-center justify-center gap-3">
                    <div className="flex items-center gap-2 text-purple-600">
                      <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      <span className="text-sm font-medium">Gathering research sources...</span>
                    </div>
                    <p className="text-xs text-[#9ca3af]">Both sides are preparing their arguments</p>
                  </div>
                )}

                {messages.map((msg) => {
                  const text = msg.displayedContent;
                  const typing = isMsgTyping(msg);

                  if (!text && !typing) return null;

                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col gap-2 ${
                        msg.speaker === "blue" ? "items-start" :
                        msg.speaker === "red" ? "items-end" : "items-center"
                      }`}
                    >
                      {speakerTag(msg)}
                      <div className={`rounded-2xl border px-5 py-4 max-w-[85%] shadow-sm ${chatBubbleStyle(msg.speaker)} ${msg.isVerdict ? "ring-2 ring-amber-400" : ""}`}>
                        <p className="text-base leading-relaxed whitespace-pre-wrap text-[#1f2937]">
                          {text}
                          {typing && <span className="inline-block w-2 h-4 bg-[#6b7280] opacity-40 animate-pulse ml-0.5 align-middle rounded-sm" />}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
