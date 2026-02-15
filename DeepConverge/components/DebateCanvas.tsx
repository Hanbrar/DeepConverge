"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";

// ── Types ────────────────────────────────────────────────────────────

interface DebateMessage {
  id: string;
  speaker: "moderator" | "blue" | "red";
  content: string;
  displayedContent: string;
  isVerdict?: boolean;
  round?: number;
}

interface DebateCanvasProps {
  question: string;
  rounds: number;
  onComplete?: () => void;
  onDebateFinished?: (messages: { speaker: string; content: string }[]) => void;
}

type Phase = "loading" | "presenting" | "complete";

// ── Constants ────────────────────────────────────────────────────────

const CHARS_PER_FRAME = 1;
const FRAME_DELAY = 45; // ms between frames (~22 chars/sec, deliberate pacing)
const TURN_DELAY = 3000; // ms pause between blue/red turns
const MOD_TO_AGENT_DELAY = 3000; // ms pause after moderator

// ── SSE Parser ───────────────────────────────────────────────────────

const parseSseEvents = (buffer: string) => {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events: { data: string; event?: string }[] = [];
  let remaining = normalized;

  let idx = remaining.indexOf("\n\n");
  while (idx !== -1) {
    const rawEvent = remaining.slice(0, idx);
    remaining = remaining.slice(idx + 2);

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

    idx = remaining.indexOf("\n\n");
  }

  return { events, remaining };
};

// ── Component ────────────────────────────────────────────────────────

export default function DebateCanvas({
  question,
  rounds,
  onComplete,
  onDebateFinished,
}: DebateCanvasProps) {
  // ── State ──
  const [phase, setPhase] = useState<Phase>("loading");
  const [messages, setMessages] = useState<DebateMessage[]>([]);
  const [loadingLabel, setLoadingLabel] = useState("Preparing debate...");
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [isGenerationStopped, setIsGenerationStopped] = useState(false);
  const [stopMessage, setStopMessage] = useState<string | null>(null);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [logExpanded, setLogExpanded] = useState(false);
  const [researchSources, setResearchSources] = useState<{
    blue: string[];
    red: string[];
  }>({ blue: [], red: [] });

  // ── Refs ──
  const preloadedRef = useRef<DebateMessage[]>([]);
  const nextIndexRef = useRef(0);
  const waitingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<Phase>("loading");
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // ── PRELOAD DEBATE ─────────────────────────────────────────────────

  useEffect(() => {
    preloadDebate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preloadDebate = async () => {
    setPhase("loading");
    setIsGenerationStopped(false);
    setStopMessage(null);
    stoppedRef.current = false;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const collected: DebateMessage[] = [];
    // 2 research-done + moderator + rounds*2 + verdict
    const totalSteps = 4 + rounds * 2;
    let step = 0;

    try {
      const response = await fetch("/api/debate-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, rounds }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorText = `API error: ${response.status}`;
        try {
          const payload = await response.json();
          if (payload && typeof payload.error === "string") {
            errorText = payload.error;
          }
          if (
            payload &&
            typeof payload.reason === "string" &&
            payload.reason.trim()
          ) {
            errorText = `${errorText} ${payload.reason.trim()}`;
          }
        } catch {
          // Ignore JSON parsing errors and keep status-based message.
        }
        setLoadingLabel(
          response.status === 400 ? "Debate topic blocked." : "Debate failed."
        );
        setStopMessage(errorText);
        setIsGenerationStopped(true);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        if (stoppedRef.current) break;
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

            if (data.type === "research-start") {
              setLoadingLabel("Researching topic...");
              continue;
            }

            if (data.type === "research-done") {
              const speaker = data.speaker as "blue" | "red";
              const sources = Array.isArray(data.sources)
                ? data.sources
                : [];
              setResearchSources((prev) => ({
                ...prev,
                [speaker]: sources,
              }));
              step++;
              setLoadingProgress((step / totalSteps) * 100);
              continue;
            }

            if (data.type === "start") {
              const labels: Record<string, string> = {
                moderator: data.isVerdict
                  ? "Moderator deliberating..."
                  : "Moderator preparing...",
                blue: `Blue preparing${
                  data.round ? ` round ${data.round}` : ""
                }...`,
                red: `Red preparing${
                  data.round ? ` round ${data.round}` : ""
                }...`,
              };
              setLoadingLabel(labels[data.speaker] || "Preparing...");
              continue;
            }

            if (data.type === "done") {
              collected.push({
                id: `${data.speaker}-${Date.now()}-${Math.random()
                  .toString(36)
                  .slice(2, 6)}`,
                speaker: data.speaker,
                content: data.content || "",
                displayedContent: "",
                isVerdict: data.isVerdict || false,
                round: data.round,
              });
              step++;
              setLoadingProgress((step / totalSteps) * 100);
              continue;
            }

            if (data.type === "complete") break;
            if (data.type === "error")
              console.error("Debate error:", data.message);
          } catch {
            /* skip invalid JSON */
          }
        }
      }
    } catch (error) {
      const isAbortError =
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.name === "AbortError");
      if (isAbortError && stoppedRef.current) {
        setLoadingLabel("Debate stopped.");
        setStopMessage("Debate stopped. No further generation will run.");
        setIsGenerationStopped(true);
        return;
      }
      if (isAbortError) {
        // Ignore non-manual aborts (e.g., transient remounts in dev).
        return;
      }
      console.error("Debate preload error:", error);
      setLoadingLabel("Debate failed.");
      setStopMessage(
        error instanceof Error ? error.message : "Debate failed to start. Please try again."
      );
      setIsGenerationStopped(true);
      return;
    } finally {
      abortControllerRef.current = null;
    }

    if (stoppedRef.current) return;
    preloadedRef.current = collected;
    nextIndexRef.current = 0;
    waitingRef.current = false;
    setLoadingProgress(100);

    // Small pause before starting presentation
    setTimeout(() => {
      if (!stoppedRef.current) setPhase("presenting");
    }, 400);
  };

  const stopDebateGeneration = () => {
    if (phase !== "loading" || stoppedRef.current) return;
    stoppedRef.current = true;
    setIsGenerationStopped(true);
    setLoadingLabel("Debate stopped.");
    setStopMessage("Debate stopped. No further generation will run.");
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  };

  // ── TYPEWRITER ─────────────────────────────────────────────────────

  useEffect(() => {
    let running = true;

    const tick = (timestamp: number) => {
      if (!running) return;

      if (timestamp - lastTickRef.current >= FRAME_DELAY) {
        lastTickRef.current = timestamp;

        setMessages((prev) => {
          for (let i = 0; i < prev.length; i++) {
            const msg = prev[i];
            if (msg.displayedContent.length < msg.content.length) {
              const newLen = Math.min(
                msg.displayedContent.length + CHARS_PER_FRAME,
                msg.content.length
              );
              const updated = [...prev];
              updated[i] = {
                ...msg,
                displayedContent: msg.content.slice(0, newLen),
              };
              return updated;
            }
          }
          return prev;
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

  // ── REVEAL TIMER ───────────────────────────────────────────────────

  useEffect(() => {
    if (phase !== "presenting") return;
    if (waitingRef.current) return;

    const preloaded = preloadedRef.current;
    const nextIdx = nextIndexRef.current;

    // All revealed — check if typing finished
    if (nextIdx >= preloaded.length) {
      const allTyped = messages.every(
        (m) => m.displayedContent.length >= m.content.length
      );
      if (allTyped && messages.length > 0) {
        setPhase("complete");
        setActiveSpeaker(null);
        onComplete?.();
        onDebateFinished?.(
          messages.map((m) => ({ speaker: m.speaker, content: m.content }))
        );
      }
      return;
    }

    // Wait for current message to finish typing
    const lastMsg = messages[messages.length - 1];
    const isDone =
      !lastMsg || lastMsg.displayedContent.length >= lastMsg.content.length;
    if (!isDone) return;

    // Calculate delay
    const delay =
      messages.length === 0
        ? 200
        : lastMsg?.speaker === "moderator"
        ? MOD_TO_AGENT_DELAY
        : TURN_DELAY;

    waitingRef.current = true;

    timerRef.current = setTimeout(() => {
      if (phaseRef.current !== "presenting") return;
      const nextMsg = preloaded[nextIdx];
      nextIndexRef.current++;
      waitingRef.current = false;
      setMessages((prev) => [...prev, { ...nextMsg, displayedContent: "" }]);
      setActiveSpeaker(nextMsg.speaker);
    }, delay);
  }, [phase, messages, onComplete]);

  // Clear active speaker when current message finishes typing
  useEffect(() => {
    if (!activeSpeaker) return;
    const lastMsg = messages[messages.length - 1];
    if (
      lastMsg &&
      lastMsg.displayedContent.length >= lastMsg.content.length
    ) {
      setActiveSpeaker(null);
    }
  }, [messages, activeSpeaker]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current && logExpanded) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // ── HELPERS ────────────────────────────────────────────────────────

  const isTyping = (msg: DebateMessage) =>
    msg.displayedContent.length < msg.content.length;

  const getLatest = (speaker: "moderator" | "blue" | "red") => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].speaker === speaker) return messages[i];
    }
    return null;
  };

  const latestBlue = getLatest("blue");
  const latestRed = getLatest("red");
  const latestMod = getLatest("moderator");

  const domainLabel = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };

  // ── SPEECH BUBBLE ──────────────────────────────────────────────────

  const renderBubble = (
    msg: DebateMessage | null,
    speaker: "moderator" | "blue" | "red"
  ) => {
    const isActive = activeSpeaker === speaker;
    const text = msg?.displayedContent || "";
    const hasContent = text.trim().length > 0;

    if (!hasContent && !isActive) return null;

    const palette = {
      blue: {
        border: "border-blue-200/80",
        bg: "bg-gradient-to-br from-blue-50 to-white",
        text: "text-blue-900",
        dot: "bg-blue-500",
      },
      red: {
        border: "border-red-200/80",
        bg: "bg-gradient-to-br from-red-50 to-white",
        text: "text-red-900",
        dot: "bg-red-500",
      },
      moderator: {
        border: "border-gray-200/80",
        bg: "bg-gradient-to-br from-gray-50 to-white",
        text: "text-gray-800",
        dot: "bg-gray-500",
      },
    };
    const s = palette[speaker];
    const preview = text.length > 140 ? "\u2026" + text.slice(-140) : text;

    return (
      <div
        className={`relative w-full rounded-2xl border ${s.border} ${s.bg} backdrop-blur-sm px-5 py-4 shadow-lg mb-3 transition-all duration-300`}
      >
        {isActive && !hasContent ? (
          <div className="flex items-center gap-2 text-sm font-medium text-gray-400">
            <span
              className={`w-2 h-2 ${s.dot} rounded-full animate-pulse`}
            />
            Preparing response...
          </div>
        ) : (
          <p
            className={`${s.text} text-[15px] leading-[1.75] whitespace-pre-wrap tracking-[-0.01em]`}
          >
            {preview}
            {msg && isTyping(msg) && (
              <span
                className={`inline-block w-[2px] h-[17px] ${s.dot} opacity-60 animate-pulse ml-0.5 align-middle`}
              />
            )}
          </p>
        )}
      </div>
    );
  };

  // ── SOURCE ICONS ───────────────────────────────────────────────────

  const renderSources = (
    speaker: "blue" | "red",
    borderColor: string
  ) => {
    const sources = researchSources[speaker];
    if (sources.length === 0) return null;

    return (
      <div className="flex flex-col gap-1.5 mt-3">
        <span className="text-[8px] font-semibold uppercase tracking-widest text-gray-400 text-center">
          Sources
        </span>
        {sources.map((url, i) => (
          <a
            key={`${speaker}-src-${i}`}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={domainLabel(url)}
            className={`group w-8 h-8 rounded-lg bg-white border ${borderColor} flex items-center justify-center hover:scale-110 transition-all shadow-sm`}
          >
            <span className="text-[10px] font-bold text-gray-500 group-hover:text-gray-800">
              {domainLabel(url).charAt(0).toUpperCase()}
            </span>
          </a>
        ))}
      </div>
    );
  };

  // ── LOADING VIEW ───────────────────────────────────────────────────

  if (phase === "loading") {
    return (
      <div className="h-full min-h-0 flex flex-col overflow-hidden bg-[#fffaf3]">
        {/* Header */}
        <header className="flex-shrink-0 flex items-center justify-between px-6 py-4">
          <div className="w-16" aria-hidden="true" />
          <span className="font-semibold text-[#2d2d2d] text-lg whitespace-nowrap flex items-center gap-1">
            <span>DeepConverge</span>
            <Image
              src="/bestlogo.png"
              alt="DeepConverge logo"
              width={42}
              height={42}
              className="object-contain -ml-2"
              priority
            />
          </span>
          <div className="w-16" />
        </header>

        {/* Topic */}
        <div className="px-6 py-2">
          <div className="max-w-3xl mx-auto bg-white/70 backdrop-blur-sm rounded-full px-5 py-2.5 text-center text-sm text-gray-500 shadow-sm border border-gray-200/50">
            <span className="font-medium text-gray-800">Topic:</span>{" "}
            {question}
          </div>
        </div>

        {/* Loading content */}
        <main className="flex-1 flex flex-col items-center justify-center gap-10 px-6">
          <div className="flex items-end gap-12">
            <div className="opacity-25 grayscale">
              <Image
                src="/blue.png"
                alt="Blue"
                width={130}
                height={195}
                className="object-contain"
                priority
              />
            </div>
            <div className="opacity-25 grayscale">
              <Image
                src="/moderator.png"
                alt="Moderator"
                width={130}
                height={195}
                className="object-contain"
                priority
              />
            </div>
            <div className="opacity-25 grayscale">
              <Image
                src="/red.png"
                alt="Red"
                width={130}
                height={195}
                className="object-contain"
                priority
              />
            </div>
          </div>

          <div className="flex flex-col items-center gap-3 w-full max-w-xs">
            <div className="w-full h-1.5 bg-gray-200/80 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#76b900] rounded-full transition-all duration-700 ease-out"
                style={{ width: `${loadingProgress}%` }}
              />
            </div>
            <p className="text-sm text-gray-500 font-medium">
              {loadingLabel}
            </p>
            {stopMessage && (
              <p className="text-xs text-[#9a3412] bg-[#fffbeb] border border-[#fde68a] rounded-lg px-3 py-2 text-center w-full">
                {stopMessage}
              </p>
            )}
            <button
              type="button"
              onClick={stopDebateGeneration}
              disabled={isGenerationStopped}
              className="mt-1 px-4 py-2 rounded-lg border border-[#d1d5db] text-sm font-medium text-[#4b5563] bg-white hover:bg-[#f8fafc] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isGenerationStopped ? "Stopped" : "Stop Debate"}
            </button>
          </div>
        </main>
      </div>
    );
  }

  // ── DEBATE VIEW (presenting + complete) ────────────────────────────

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#fffaf3]">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center justify-between px-6 py-4">
        <div className="w-16" aria-hidden="true" />
        <span className="font-semibold text-[#2d2d2d] text-lg whitespace-nowrap flex items-center gap-1">
          <span>DeepConverge</span>
          <Image
            src="/bestlogo.png"
            alt="DeepConverge logo"
            width={42}
            height={42}
            className="object-contain -ml-2"
            priority
          />
        </span>
        <div className="text-xs text-gray-400 flex items-center gap-2">
          {phase === "presenting" && (
            <>
              <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
              Live
            </>
          )}
          {phase === "complete" && (
            <>
              <span className="w-2 h-2 bg-green-500 rounded-full" />
              Complete
            </>
          )}
        </div>
      </header>

      {/* Topic */}
      <div className="flex-shrink-0 px-6 py-2">
        <div className="max-w-3xl mx-auto bg-white/70 backdrop-blur-sm rounded-full px-5 py-2.5 text-center text-sm text-gray-500 shadow-sm border border-gray-200/50">
          <span className="font-medium text-gray-800">Topic:</span>{" "}
          {question}
        </div>
      </div>

      {/* Main content */}
      <main className="flex-1 flex flex-col px-4 pb-4">
        <div className="max-w-6xl mx-auto w-full flex-1 flex flex-col">
          {/* Avatar stage */}
          <div
            className="flex-shrink-0 relative flex items-end justify-between gap-4 px-4 mb-2"
            style={{ minHeight: "360px" }}
          >
            {/* Blue */}
            <div
              className="flex flex-col items-center"
              style={{ width: "280px" }}
            >
              {renderBubble(latestBlue, "blue")}
              <div className="flex items-end gap-3">
                <div
                  className={`relative transition-all duration-500 ${
                    activeSpeaker === "blue" ? "scale-105" : "opacity-70"
                  }`}
                >
                  <Image
                    src="/blue.png"
                    alt="Blue Debater"
                    width={200}
                    height={300}
                    className="object-contain drop-shadow-lg"
                    priority
                  />
                  {activeSpeaker === "blue" && (
                    <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-blue-500 text-white text-[10px] font-bold px-3 py-0.5 rounded-full shadow-md">
                      Speaking
                    </div>
                  )}
                </div>
                {renderSources("blue", "border-blue-200")}
              </div>
              <span className="mt-2 text-[11px] font-bold text-blue-500 uppercase tracking-widest">
                Blue
              </span>
            </div>

            {/* Moderator */}
            <div
              className="flex flex-col items-center"
              style={{ width: "280px" }}
            >
              {renderBubble(latestMod, "moderator")}
              <div
                className={`relative transition-all duration-500 ${
                  activeSpeaker === "moderator" ? "scale-105" : "opacity-70"
                }`}
              >
                <Image
                  src="/moderator.png"
                  alt="Moderator"
                  width={200}
                  height={300}
                  className="object-contain drop-shadow-lg"
                  priority
                />
                {activeSpeaker === "moderator" && (
                  <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-gray-700 text-white text-[10px] font-bold px-3 py-0.5 rounded-full shadow-md">
                    Speaking
                  </div>
                )}
              </div>
              <span className="mt-2 text-[11px] font-bold text-gray-500 uppercase tracking-widest">
                Moderator
              </span>
            </div>

            {/* Red */}
            <div
              className="flex flex-col items-center"
              style={{ width: "280px" }}
            >
              {renderBubble(latestRed, "red")}
              <div className="flex items-end gap-3">
                {renderSources("red", "border-red-200")}
                <div
                  className={`relative transition-all duration-500 ${
                    activeSpeaker === "red" ? "scale-105" : "opacity-70"
                  }`}
                >
                  <Image
                    src="/red.png"
                    alt="Red Debater"
                    width={200}
                    height={300}
                    className="object-contain drop-shadow-lg"
                    priority
                  />
                  {activeSpeaker === "red" && (
                    <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-red-500 text-white text-[10px] font-bold px-3 py-0.5 rounded-full shadow-md">
                      Speaking
                    </div>
                  )}
                </div>
              </div>
              <span className="mt-2 text-[11px] font-bold text-red-500 uppercase tracking-widest">
                Red
              </span>
            </div>
          </div>

          {/* Debate Log (collapsible) */}
          <div className="flex-shrink-0 max-w-3xl mx-auto w-full mt-2">
            <button
              onClick={() => setLogExpanded(!logExpanded)}
              className="w-full flex items-center justify-center gap-2 py-2 text-sm font-medium text-gray-400 hover:text-gray-600 transition-colors"
            >
              <div className="h-px flex-1 bg-gray-200/80" />
              <div className="flex items-center gap-1.5 px-3">
                <svg
                  className={`w-3.5 h-3.5 transition-transform duration-200 ${
                    logExpanded ? "rotate-180" : ""
                  }`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
                <span className="uppercase tracking-wider text-xs">
                  Debate Log
                </span>
                {messages.length > 0 && (
                  <span className="text-[10px] bg-gray-200/80 text-gray-500 px-1.5 py-0.5 rounded-full font-semibold">
                    {messages.length}
                  </span>
                )}
              </div>
              <div className="h-px flex-1 bg-gray-200/80" />
            </button>

            <div
              className={`overflow-hidden transition-all duration-300 ease-in-out ${
                logExpanded
                  ? "max-h-[400px] opacity-100 mt-2"
                  : "max-h-0 opacity-0"
              }`}
            >
              <div
                ref={logRef}
                className="max-h-[380px] overflow-y-auto bg-white/50 backdrop-blur-sm rounded-2xl border border-gray-200/50 shadow-sm p-5 flex flex-col gap-4"
              >
                {messages.length === 0 && (
                  <div className="text-center text-gray-400 text-sm py-6">
                    Waiting for debate to begin...
                  </div>
                )}

                {messages.map((msg) => {
                  const text = msg.displayedContent;
                  if (!text.trim()) return null;

                  const tagColors: Record<string, string> = {
                    blue: "bg-blue-500",
                    red: "bg-red-500",
                    moderator: "bg-gray-600",
                  };
                  const bubbleColors: Record<string, string> = {
                    blue: "bg-blue-50/80 border-blue-100",
                    red: "bg-red-50/80 border-red-100",
                    moderator: "bg-gray-50/80 border-gray-100",
                  };
                  const names: Record<string, string> = {
                    blue: "Blue",
                    red: "Red",
                    moderator: "Moderator",
                  };

                  let label = names[msg.speaker];
                  if (msg.round) label += ` \u00b7 R${msg.round}`;
                  if (msg.isVerdict) label += " \u00b7 Verdict";

                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col gap-1.5 ${
                        msg.speaker === "blue"
                          ? "items-start"
                          : msg.speaker === "red"
                          ? "items-end"
                          : "items-center"
                      }`}
                    >
                      <span
                        className={`text-[10px] font-semibold text-white px-2 py-0.5 rounded-full ${tagColors[msg.speaker]}`}
                      >
                        {label}
                      </span>
                      <div
                        className={`rounded-xl border px-4 py-3 max-w-[85%] shadow-sm ${
                          bubbleColors[msg.speaker]
                        } ${msg.isVerdict ? "ring-1 ring-amber-300" : ""}`}
                      >
                        <p className="text-[13px] leading-[1.7] whitespace-pre-wrap text-gray-700">
                          {text}
                          {isTyping(msg) && (
                            <span className="inline-block w-[2px] h-[15px] bg-gray-400 opacity-40 animate-pulse ml-0.5 align-middle" />
                          )}
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
