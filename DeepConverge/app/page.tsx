"use client";

import { useState, useRef, useEffect, type ChangeEvent, type DragEvent } from "react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { preprocessLaTeX } from "@/lib/latex";
import DebateCanvas from "@/components/DebateCanvas";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachment?: {
    kind: "image" | "pdf";
    name: string;
    dataUrl: string;
  };
  status?: string;
  reasoning?: string;
  isStreaming?: boolean;
  convergent?: {
    status: "idle" | "running" | "converged" | "needs_input";
    score: number;
    round: number;
    maxRounds: number;
    logs: Array<{
      id: string;
      role: "judge" | "debater_a" | "debater_b" | "executor";
      round: number;
      content: string;
    }>;
    clarifyingQuestions: string[];
  };
}

type Mode = "agentic" | "debate";
type DebatePhase = "setup" | "active";
type DebateType = "regular" | "continuous";
type AgenticModel = "nemotron9b" | "nemotron30b";
type PendingAttachment = {
  kind: "image" | "pdf";
  name: string;
  mimeType: string;
  dataUrl: string;
};

const AGENTIC_MODELS: Record<AgenticModel, { label: string; display: string }> = {
  nemotron9b: {
    label: "NVIDIA: Nemotron Nano 9B V2 (free)",
    display: "Nemotron Nano 9B V2 (free)",
  },
  nemotron30b: {
    label: "NVIDIA: Nemotron 3 Nano 30B A3B",
    display: "Nemotron 3 Nano 30B A3B",
  },
};

export default function Home() {
  // Core mode state
  const [mode, setMode] = useState<Mode>("agentic");
  const [debatePhase, setDebatePhase] = useState<DebatePhase>("setup");

  // Chat/agentic state
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [convergentEnabled, setConvergentEnabled] = useState(false);
  const [expandedConvergent, setExpandedConvergent] = useState<Record<string, boolean>>({});
  const [animatedConvergence, setAnimatedConvergence] = useState<Record<string, number>>({});
  const [copiedCodeKey, setCopiedCodeKey] = useState<string | null>(null);
  const [attachedFile, setAttachedFile] = useState<PendingAttachment | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const agenticPanelRef = useRef<HTMLDivElement>(null);
  const debatePanelRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const manualStopRef = useRef(false);
  const [modePanelHeight, setModePanelHeight] = useState<number>(0);

  // Debate state
  const [debateQuestion, setDebateQuestion] = useState("");
  const [debateType, setDebateType] = useState<DebateType>("regular");
  const [continuousRounds, setContinuousRounds] = useState(3);

  // Sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const timer = setInterval(() => {
      setAnimatedConvergence((prev) => {
        let changed = false;
        const next = { ...prev };

        for (const msg of messages) {
          if (msg.role !== "assistant" || !msg.convergent) continue;
          const target = Math.max(0, Math.min(100, msg.convergent.score));
          const current = next[msg.id] ?? target;
          const delta = target - current;

          if (Math.abs(delta) > 0.2) {
            next[msg.id] = current + delta * 0.18;
            changed = true;
          } else if (current !== target) {
            next[msg.id] = target;
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    }, 32);

    return () => clearInterval(timer);
  }, [messages]);

  const getConvergencePhase = (score: number) => {
    if (score < 40) return "Diverging";
    if (score < 75) return "Balanced";
    return "Converging";
  };

  const syncModePanelHeight = () => {
    const activePanel = mode === "agentic" ? agenticPanelRef.current : debatePanelRef.current;
    if (!activePanel) return;
    setModePanelHeight(activePanel.offsetHeight);
  };

  useEffect(() => {
    syncModePanelHeight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, debateType]);

  useEffect(() => {
    const handleResize = () => syncModePanelHeight();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, debateType]);

  // Keyboard shortcuts: Ctrl/Cmd+K for New Chat, Ctrl/Cmd+Alt+D for New Debate
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        handleNewChat();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        handleNewDebate();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleNewChat = () => {
    setMessages([]);
    setExpandedConvergent({});
    setAnimatedConvergence({});
    setInput("");
    setDebatePhase("setup");
    setMode("agentic");
  };

  const handleNewDebate = () => {
    setMode("debate");
    setDebatePhase("setup");
    setDebateQuestion("");
    setInput("");
  };

  const handleModeChange = (nextMode: Mode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
  };

  const activeModel: AgenticModel = convergentEnabled ? "nemotron30b" : "nemotron9b";

  const handleConvergentToggle = (enabled: boolean) => {
    setConvergentEnabled(enabled);
  };

  const markdownComponents: Components = {
    code({ className, children, ...props }) {
      const languageMatch = /language-([\w-]+)/.exec(className || "");
      const codeText = String(children || "").replace(/\n$/, "");

      if (!languageMatch) {
        return (
          <code className={`${className || ""} bg-[#f3f4f6] px-1 py-0.5 rounded`} {...props}>
            {children}
          </code>
        );
      }

      const language = languageMatch[1].toLowerCase();
      const codeKey = `${language}-${codeText.slice(0, 80)}`;
      const copied = copiedCodeKey === codeKey;

      return (
        <div className="not-prose my-3 overflow-hidden rounded-xl border border-[#d1d5db] bg-[#0f172a]">
          <div className="flex items-center justify-between px-3 py-1.5 text-[11px] bg-[#111827] border-b border-[#1f2937]">
            <span className="font-semibold uppercase tracking-wide text-[#9ca3af]">
              {language}
            </span>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(codeText);
                  setCopiedCodeKey(codeKey);
                  setTimeout(() => {
                    setCopiedCodeKey((prev) => (prev === codeKey ? null : prev));
                  }, 1200);
                } catch {
                  // Clipboard may be unavailable in some browsers.
                }
              }}
              className="rounded-md border border-[#374151] px-2 py-0.5 text-[#d1d5db] hover:bg-[#1f2937] transition-colors"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="m-0 overflow-x-auto p-3 text-sm text-[#e5e7eb]">
            <code className={className} {...props}>
              {codeText}
            </code>
          </pre>
        </div>
      );
    },
  };

  const renderMarkdown = (content: string) => (
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkGfm]}
      rehypePlugins={[rehypeKatex]}
      components={markdownComponents}
    >
      {preprocessLaTeX(content)}
    </ReactMarkdown>
  );

  const stopGeneration = () => {
    if (!isLoading || !abortControllerRef.current) return;
    manualStopRef.current = true;
    abortControllerRef.current.abort();
  };

  const handleAttachClick = () => {
    if (isLoading) return;
    imageInputRef.current?.click();
  };

  const fileToDataUrl = async (file: File) => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    }).catch(() => "");
    return dataUrl;
  };

  const toPendingAttachment = async (file: File): Promise<PendingAttachment | null> => {
    const isImage = file.type.startsWith("image/");
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isImage && !isPdf) return null;

    const dataUrl = await fileToDataUrl(file);
    if (!dataUrl) return null;

    return {
      kind: isImage ? "image" : "pdf",
      name: file.name,
      mimeType: file.type || (isPdf ? "application/pdf" : "image/*"),
      dataUrl,
    };
  };

  const attachFromFile = async (file: File) => {
    const attachment = await toPendingAttachment(file);
    if (!attachment) return;
    setAttachedFile(attachment);
  };

  const handleImageFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      event.target.value = "";
      return;
    }
    await attachFromFile(file);
    event.target.value = "";
  };

  const hasFileDataInClipboard = (items: DataTransferItemList | undefined | null) => {
    if (!items) return false;
    return Array.from(items).some((item) => {
      const type = item.type || "";
      return type.startsWith("image/") || type === "application/pdf";
    });
  };

  const findSupportedFile = (files: FileList | null | undefined) => {
    if (!files) return null;
    return (
      Array.from(files).find((file) => {
        const type = file.type || "";
        return type.startsWith("image/") || type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      }) || null
    );
  };

  useEffect(() => {
    const onPaste = async (event: ClipboardEvent) => {
      if (isLoading) return;

      const clipboardItems = event.clipboardData?.items;
      let file = findSupportedFile(event.clipboardData?.files);
      if (!file && hasFileDataInClipboard(clipboardItems)) {
        const fileItem = clipboardItems
          ? Array.from(clipboardItems).find((item) => {
              const type = item.type || "";
              return type.startsWith("image/") || type === "application/pdf";
            })
          : null;
        file = fileItem?.getAsFile() || null;
      }
      if (!file) return;

      event.preventDefault();
      await attachFromFile(file);
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    if (!isDragActive) setIsDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    if (isDragActive) setIsDragActive(false);
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    if (isLoading) return;

    const file = findSupportedFile(event.dataTransfer?.files);
    if (!file) return;
    await attachFromFile(file);
  };

  // ── Chat logic (unchanged) ───────────────────────────────────────────
  const sendMessage = async () => {
    const trimmedInput = input.trim();
    const fileToSend = attachedFile;
    if ((!trimmedInput && !fileToSend) || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: trimmedInput || (fileToSend?.kind === "pdf" ? "Analyze this PDF." : "Analyze this image."),
      attachment: fileToSend
        ? {
            kind: fileToSend.kind,
            name: fileToSend.name,
            dataUrl: fileToSend.dataUrl,
          }
        : undefined,
    };

    const assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content: "",
      status: fileToSend
        ? fileToSend.kind === "pdf"
          ? "Analyzing PDF."
          : "Analyzing image with the Nemotron Nano 12B V2 model."
        : undefined,
      reasoning: "",
      isStreaming: true,
      convergent: convergentEnabled
        ? {
            status: "idle",
            score: 0,
            round: 0,
            maxRounds: 0,
            logs: [],
            clarifyingQuestions: [],
          }
        : undefined,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setAttachedFile(null);
    setIsLoading(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    manualStopRef.current = false;
    activeAssistantIdRef.current = assistantMessage.id;
    timeoutRef.current = setTimeout(() => abortController.abort(), 300000);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmedInput,
          model: activeModel,
          thinking: convergentEnabled,
          convergentThinking: convergentEnabled,
          imageDataUrl: fileToSend?.kind === "image" ? fileToSend.dataUrl : undefined,
          pdfDataUrl: fileToSend?.kind === "pdf" ? fileToSend.dataUrl : undefined,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
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
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === "reasoning") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? { ...msg, reasoning: data.content, status: undefined }
                      : msg
                  )
                );
              } else if (data.type === "status") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? {
                          ...msg,
                          status: typeof data.content === "string" ? data.content : msg.status,
                        }
                      : msg
                  )
                );
              } else if (data.type === "convergent_start") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? {
                          ...msg,
                          convergent: {
                            status: "running",
                            score: typeof data.score === "number" ? data.score : 0,
                            round: typeof data.round === "number" ? data.round : 0,
                            maxRounds: typeof data.maxRounds === "number" ? data.maxRounds : 0,
                            logs: msg.convergent?.logs || [],
                            clarifyingQuestions: msg.convergent?.clarifyingQuestions || [],
                          },
                        }
                      : msg
                  )
                );
              } else if (data.type === "convergent_log") {
                setMessages((prev) =>
                  prev.map((msg) => {
                    if (msg.id !== assistantMessage.id) return msg;
                    const log = {
                      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                      role: data.role as "judge" | "debater_a" | "debater_b" | "executor",
                      round: typeof data.round === "number" ? data.round : 0,
                      content: typeof data.content === "string" ? data.content : "",
                    };
                    return {
                      ...msg,
                      convergent: {
                        status: msg.convergent?.status || "running",
                        score: msg.convergent?.score ?? 0,
                        round: msg.convergent?.round ?? 0,
                        maxRounds: msg.convergent?.maxRounds ?? 0,
                        logs: [...(msg.convergent?.logs || []), log],
                        clarifyingQuestions: msg.convergent?.clarifyingQuestions || [],
                      },
                    };
                  })
                );
              } else if (data.type === "convergence_state") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? {
                          ...msg,
                          convergent: {
                            status:
                              data.status === "converged"
                                ? "converged"
                                : data.status === "needs_input"
                                ? "needs_input"
                                : "running",
                            score:
                              typeof data.score === "number"
                                ? data.score
                                : msg.convergent?.score ?? 0,
                            round:
                              typeof data.round === "number"
                                ? data.round
                                : msg.convergent?.round ?? 0,
                            maxRounds:
                              typeof data.maxRounds === "number"
                                ? data.maxRounds
                                : msg.convergent?.maxRounds ?? 0,
                            logs: msg.convergent?.logs || [],
                            clarifyingQuestions: msg.convergent?.clarifyingQuestions || [],
                          },
                        }
                      : msg
                  )
                );
              } else if (data.type === "clarifying_questions") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? {
                          ...msg,
                          convergent: {
                            status: "needs_input",
                            score: msg.convergent?.score ?? 0,
                            round: msg.convergent?.round ?? 0,
                            maxRounds: msg.convergent?.maxRounds ?? 0,
                            logs: msg.convergent?.logs || [],
                            clarifyingQuestions: Array.isArray(data.questions)
                              ? data.questions
                              : [],
                          },
                        }
                      : msg
                  )
                );
              } else if (data.type === "content") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? { ...msg, content: data.content, status: undefined }
                      : msg
                  )
                );
              } else if (data.type === "done") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? {
                          ...msg,
                          isStreaming: false,
                          status: undefined,
                          convergent: msg.convergent
                            ? {
                                ...msg.convergent,
                                status:
                                  msg.convergent.status === "running"
                                    ? "converged"
                                    : msg.convergent.status,
                              }
                            : undefined,
                        }
                      : msg
                  )
                );
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (error) {
      console.error("Error:", error);
      const isTimeout = error instanceof Error && error.name === "AbortError";
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessage.id
            ? {
                ...msg,
                content:
                  isTimeout && manualStopRef.current
                    ? (msg.content.trim() ? msg.content : "Generation stopped.")
                    : isTimeout
                    ? "The request took too long. The reasoning above shows the progress made. Please try a simpler question or try again."
                    : "Sorry, there was an error. Please try again.",
                status: undefined,
                isStreaming: false,
              }
            : msg
        )
      );
    } finally {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      abortControllerRef.current = null;
      activeAssistantIdRef.current = null;
      manualStopRef.current = false;
      setIsLoading(false);
    }
  };

  // ── Debate helpers ───────────────────────────────────────────────────
  const startDebate = () => {
    if (!debateQuestion.trim()) return;
    setDebatePhase("active");
  };

  const debateRounds = debateType === "regular" ? 2 : continuousRounds;
  // ── Derived values ───────────────────────────────────────────────────
  const sidebarWidth = sidebarOpen ? 240 : 56;
  const isAgenticMode = mode === "agentic";
  const isDebateActive = mode === "debate" && debatePhase === "active";
  const isLanding = messages.length === 0;

  // ── SINGLE-PAGE SHELL ────────────────────────────────────────────────
  return (
    <div
      className="min-h-screen flex bg-[#fffaf3]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*,application/pdf,.pdf"
        className="hidden"
        onChange={handleImageFileChange}
      />
      {isDragActive && (
        <div className="fixed inset-0 z-50 bg-[#111827]/35 backdrop-blur-[1px] flex items-center justify-center pointer-events-none">
          <div className="rounded-2xl border border-white/30 bg-[#0f172a]/80 px-6 py-4 text-white text-sm font-medium shadow-xl">
            Drop image or PDF to attach
          </div>
        </div>
      )}
      {/* ── Left Sidebar ──────────────────────────────────────────────── */}
      <aside
        className="fixed top-0 left-0 bottom-0 z-40 flex flex-col bg-[#fffaf2] border-r border-[#ebebeb] transition-all duration-200"
        style={{ width: sidebarWidth }}
      >
        {/* Logo + collapse toggle */}
        <div className="flex items-center justify-between px-3 py-4">
          <div className="flex items-center gap-2 overflow-hidden">
            {sidebarOpen && (
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
            )}
          </div>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1.5 rounded-md hover:bg-[#f3f4f6] transition-colors flex-shrink-0"
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            <svg className="w-4 h-4 text-[#9ca3af]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {sidebarOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              )}
            </svg>
          </button>
        </div>

        {/* New Chat button */}
        <div className="px-3 mb-2 space-y-1">
          <button
            onClick={handleNewChat}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[#f3f4f6] transition-colors text-sm text-[#4b5563]"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {sidebarOpen && (
              <>
                <span className="flex-1 text-left">New Chat</span>
                <span className="text-[10px] text-[#9ca3af] font-medium">Ctrl K</span>
              </>
            )}
          </button>
          <button
            onClick={handleNewDebate}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[#f3f4f6] transition-colors text-sm text-[#4b5563]"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {sidebarOpen && (
              <>
                <span className="flex-1 text-left">New Debate</span>
              </>
            )}
          </button>
        </div>

        {/* Divider */}
        <div className="mx-3 border-t border-[#ebebeb]" />

        {/* Chat History */}
        <div className="px-3 pt-3 flex-1 overflow-y-auto">
          {sidebarOpen && (
            <>
              <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[#9ca3af] mb-2 px-1">
                Chat History
              </h3>
              <div className="text-xs text-[#9ca3af] py-2 px-1">
                No sessions yet
              </div>

              <div className="mt-4 mb-2 border-t border-[#ebebeb]" />

              <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[#9ca3af] mb-2 px-1 mt-3">
                Debate History
              </h3>
              <div className="text-xs text-[#9ca3af] py-2 px-1">
                No sessions yet
              </div>
            </>
          )}
        </div>
      </aside>

      {/* ── Main Content ──────────────────────────────────────────────── */}
      <div
        className="flex-1 flex flex-col min-h-screen transition-all duration-200"
        style={{ marginLeft: sidebarWidth }}
      >
        {isAgenticMode && (
          <div className="fixed top-4 right-4 z-30">
            <div className="rounded-xl border border-[#e5e7eb] bg-[#fffaf2]/95 backdrop-blur-sm shadow-sm px-3 py-2">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="w-3.5 h-3.5 rounded overflow-hidden border border-[#d1d5db] bg-white flex items-center justify-center">
                  <Image
                    src="/nvidia_logo.png"
                    alt="NVIDIA logo"
                    width={14}
                    height={14}
                    className="object-contain"
                  />
                </span>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[#9ca3af]">
                  Active Model
                </p>
              </div>
              <p className="text-xs font-semibold text-[#2d2d2d]">
                {AGENTIC_MODELS[activeModel].display}
              </p>
              <p className="text-[11px] text-[#6b7280]">
                ConvergentThinking {convergentEnabled ? "On" : "Off"}
              </p>
            </div>
          </div>
        )}

        {isDebateActive ? (
          <div className="flex-1 min-h-0">
            <DebateCanvas
              question={debateQuestion}
              rounds={debateRounds}
            />
          </div>
        ) : isLanding ? (
          /* ── LANDING VIEW: Title + Converging Arrows + Content ──── */
          <main className="flex-1 flex flex-col items-center justify-center px-4">
            {/* Title */}
            <h1 className="text-4xl font-bold text-[#2d2d2d] mb-8 flex items-center justify-center gap-0">
              <span>DeepConverge</span>
              <Image
                src="/bestlogo.png"
                alt="DeepConverge logo"
                width={84}
                height={84}
                className="object-contain -ml-3"
                priority
              />
            </h1>

            {/* Mode tabs */}
            <div className="flex items-center gap-16 mb-0">
              <button
                onClick={() => handleModeChange("agentic")}
                className={`text-base px-1 pb-1 transition-all duration-300 ${
                  isAgenticMode
                    ? "text-[#2d2d2d] font-semibold"
                    : "text-[#c0c0c0] hover:text-[#9ca3af]"
                }`}
              >
                Agentic Mode
              </button>
              <button
                onClick={() => handleModeChange("debate")}
                className={`text-base px-1 pb-1 transition-all duration-300 ${
                  !isAgenticMode
                    ? "text-[#2d2d2d] font-semibold"
                    : "text-[#c0c0c0] hover:text-[#9ca3af]"
                }`}
              >
                Debate Mode
              </button>
            </div>

            {/* L-shaped converging arrows SVG */}
            <svg viewBox="0 0 320 70" className="w-80 h-[70px] mb-6" aria-hidden="true">
              {isAgenticMode ? (
                <>
                  {/* Inactive branch first */}
                  <path
                    d="M240 0 L240 18 Q240 25, 233 25 L167 25 Q160 25, 160 32"
                    fill="none"
                    stroke="#e0e0e0"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-all duration-500 ease-in-out"
                  />
                  {/* Active branch on top */}
                  <path
                    d="M80 0 L80 18 Q80 25, 87 25 L153 25 Q160 25, 160 32"
                    fill="none"
                    stroke="#2d2d2d"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-all duration-500 ease-in-out"
                  />
                </>
              ) : (
                <>
                  {/* Inactive branch first */}
                  <path
                    d="M80 0 L80 18 Q80 25, 87 25 L153 25 Q160 25, 160 32"
                    fill="none"
                    stroke="#e0e0e0"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-all duration-500 ease-in-out"
                  />
                  {/* Active branch on top */}
                  <path
                    d="M240 0 L240 18 Q240 25, 233 25 L167 25 Q160 25, 160 32"
                    fill="none"
                    stroke="#2d2d2d"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-all duration-500 ease-in-out"
                  />
                </>
              )}
              {/* Shared vertical trunk (kept solid in both modes) */}
              <path
                d="M160 32 L160 58"
                fill="none"
                stroke="#2d2d2d"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-all duration-500 ease-in-out"
              />
              {/* Arrowhead at bottom */}
              <path
                d="M155 55 L160 65 L165 55"
                fill="none"
                stroke="#2d2d2d"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>

            {/* Content area — crossfade between agentic input and debate settings */}
            <div
              className="relative w-full max-w-2xl transition-[height] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{ height: modePanelHeight || undefined }}
            >
              {/* Agentic: Chat textarea */}
              <div
                ref={agenticPanelRef}
                className={`absolute inset-x-0 top-0 transition-[opacity,transform,filter] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform] ${
                isAgenticMode
                  ? "opacity-100 translate-y-0 blur-0 pointer-events-auto"
                  : "opacity-0 -translate-y-1 blur-[2px] pointer-events-none"
                }`}
                aria-hidden={!isAgenticMode}
              >
                <div className="bg-[#fffaf2] rounded-2xl border border-[#e5e7eb] shadow-sm overflow-hidden">
                  {attachedFile && (
                    <div className="px-4 pt-3">
                      <div className="flex items-center gap-3 rounded-xl border border-[#e5e7eb] bg-[#f8fafc] px-3 py-2">
                        {attachedFile.kind === "image" ? (
                          <Image
                            src={attachedFile.dataUrl}
                            alt={attachedFile.name}
                            width={48}
                            height={48}
                            unoptimized
                            className="h-12 w-12 rounded-md object-cover border border-[#d1d5db]"
                          />
                        ) : (
                          <div className="h-12 w-12 rounded-md border border-[#d1d5db] bg-white flex items-center justify-center text-[#dc2626]">
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 3v6h6" />
                            </svg>
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-[#2d2d2d] truncate">
                            {attachedFile.name}
                          </p>
                          <p className="text-[11px] text-[#64748b]">
                            {attachedFile.kind === "pdf" ? "Analyzing PDF." : "Analyzing image."}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setAttachedFile(null)}
                          className="text-[#9ca3af] hover:text-[#6b7280] transition-colors"
                          aria-label="Remove attachment"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  )}
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    placeholder="Ask Anything..."
                    className="w-full bg-transparent outline-none text-[#2d2d2d] placeholder-[#9ca3af] px-5 pt-4 pb-2 resize-none text-[15px]"
                    rows={2}
                    disabled={isLoading}
                    tabIndex={isAgenticMode ? 0 : -1}
                  />
                  <div className="flex items-center justify-between gap-3 px-4 pb-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={handleAttachClick}
                        className="p-1.5 rounded-md hover:bg-[#f3f4f6] transition-colors text-[#9ca3af]"
                        tabIndex={isAgenticMode ? 0 : -1}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4.5 4.5 0 016.36 6.36l-9.2 9.19a3 3 0 01-4.24-4.24l8.49-8.48" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConvergentToggle(!convergentEnabled)}
                        disabled={isLoading}
                        tabIndex={isAgenticMode ? 0 : -1}
                        className={`h-8 px-3 rounded-lg border text-xs font-medium transition-colors ${
                          convergentEnabled
                            ? "bg-[#2d2d2d] border-[#2d2d2d] text-white"
                            : "bg-[#fffaf2] border-[#e5e7eb] text-[#6b7280] hover:bg-[#f3f4f6]"
                        } disabled:opacity-60`}
                      >
                        ConvergentThinking {convergentEnabled ? "On" : "Off"}
                      </button>
                      <span className="text-[11px] text-[#6b7280]">
                        Active: {convergentEnabled ? "30B" : "9B"}
                      </span>
                    </div>
                    <button
                      onClick={isLoading ? stopGeneration : sendMessage}
                      disabled={!isLoading && !input.trim() && !attachedFile}
                      className="w-8 h-8 rounded-full bg-[#7c6bf5] text-white flex items-center justify-center hover:bg-[#6c5ce7] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      tabIndex={isAgenticMode ? 0 : -1}
                      title={isLoading ? "Stop generation" : "Send message"}
                    >
                      {isLoading ? (
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
                          <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Debate: Settings */}
              <div
                ref={debatePanelRef}
                className={`absolute inset-x-0 top-0 transition-[opacity,transform,filter] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform] ${
                !isAgenticMode
                  ? "opacity-100 translate-y-0 blur-0 pointer-events-auto"
                  : "opacity-0 translate-y-1 blur-[2px] pointer-events-none"
                }`}
                aria-hidden={isAgenticMode}
              >
                <div className="space-y-6">
                  <p className="text-center text-[#6b7280] text-sm">
                    Watch two AI debaters go head-to-head with a moderator
                  </p>

                  {/* Debate topic input */}
                  <div>
                    <label className="block text-sm font-medium text-[#2d2d2d] mb-2">
                      Debate Topic
                    </label>
                    <input
                      type="text"
                      value={debateQuestion}
                      onChange={(e) => setDebateQuestion(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && startDebate()}
                      placeholder="e.g., Is AI going to replace programmers?"
                      className="w-full bg-[#fffaf2] rounded-xl px-4 py-3 border border-[#e5e7eb] outline-none focus:ring-2 focus:ring-[#7c6bf5]/30 focus:border-[#7c6bf5] text-[#2d2d2d] placeholder-[#9ca3af]"
                      tabIndex={!isAgenticMode ? 0 : -1}
                    />
                  </div>

                  {/* Debate type */}
                  <div>
                    <label className="block text-sm font-medium text-[#2d2d2d] mb-3">
                      Debate Type
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        onClick={() => setDebateType("regular")}
                        className={`relative p-4 rounded-xl border-2 transition-all text-left ${
                          debateType === "regular"
                            ? "border-[#000000] bg-[#6b7280]/10 shadow-sm"
                            : "border-[#e5e7eb] bg-[#fffaf2] hover:border-[#d1d5db]"
                        }`}
                        tabIndex={!isAgenticMode ? 0 : -1}
                      >
                        <div className="text-2xl mb-2">&#9889;</div>
                        <div className="font-medium text-[#2d2d2d] text-sm">Regular</div>
                        <div className="text-xs text-[#6b7280] mt-1">
                          2 rounds (4 exchanges) - quick and efficient
                        </div>
                        {debateType === "regular" && (
                          <div className="absolute top-2 right-2 w-5 h-5 bg-[#6b7280] rounded-full flex items-center justify-center">
                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </button>

                      <button
                        onClick={() => setDebateType("continuous")}
                        className={`relative p-4 rounded-xl border-2 transition-all text-left ${
                          debateType === "continuous"
                            ? "border-[#000000] bg-[#6b7280]/10 shadow-sm"
                            : "border-[#e5e7eb] bg-[#fffaf2] hover:border-[#d1d5db]"
                        }`}
                        tabIndex={!isAgenticMode ? 0 : -1}
                      >
                        <div className="text-2xl mb-2">&#128260;</div>
                        <div className="font-medium text-[#2d2d2d] text-sm">Continuous</div>
                        <div className="text-xs text-[#6b7280] mt-1">
                          Set custom rounds (up to 5)
                        </div>
                        {debateType === "continuous" && (
                          <div className="absolute top-2 right-2 w-5 h-5 bg-[#6b7280] rounded-full flex items-center justify-center">
                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </button>
                    </div>

                    {/* Round slider for continuous mode */}
                    {debateType === "continuous" && (
                      <div className="mt-4 bg-[#fffaf2] rounded-xl p-4 border border-[#e5e7eb]">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm text-[#4b5563]">Number of rounds</span>
                          <span className="text-sm font-bold text-[#6b7280]">{continuousRounds}</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="5"
                          value={continuousRounds}
                          onChange={(e) => setContinuousRounds(parseInt(e.target.value))}
                          className="w-full accent-[#6b7280]"
                          tabIndex={!isAgenticMode ? 0 : -1}
                        />
                        <div className="flex justify-between text-xs text-[#9ca3af] mt-1">
                          <span>1</span>
                          <span>3</span>
                          <span>5</span>
                        </div>
                        <p className="text-xs text-[#6b7280] mt-2">
                          {continuousRounds} round{continuousRounds > 1 ? "s" : ""} = {continuousRounds * 2} exchanges (Blue + Red each round)
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Start button */}
                  <button
                    onClick={startDebate}
                    disabled={!debateQuestion.trim()}
                    className="w-full py-3.5 bg-[#000000] text-white rounded-xl font-medium text-base hover:bg-[#1f2937] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-[#000000]/20"
                    tabIndex={!isAgenticMode ? 0 : -1}
                  >
                    <span>Start Debate</span>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Footer */}
              <p className="text-xs text-[#9ca3af] text-center mt-6">
                Powered by NVIDIA Nemotron via OpenRouter
              </p>
            </div>
          </main>
        ) : (
          /* ── ACTIVE CHAT VIEW: Messages + Input bar ────────────── */
          <>
            <main className="flex-1 pb-32 px-4">
              <div className="w-full max-w-5xl mx-auto space-y-6 px-2 sm:px-4">
                {/* Current mode label */}
                <div className="flex items-center justify-center pt-6 mb-4">
                  <span className="text-sm pb-1 text-[#2d2d2d] font-semibold border-b-2 border-[#2d2d2d]">
                    {isAgenticMode ? "Agentic Mode" : "Debate Mode"}
                  </span>
                </div>

                {/* Messages */}
                {messages.map((message) => (
                  <div key={message.id}>
                    {message.role === "user" ? (
                      <div className="flex justify-end">
                        <div className="bg-[#6b7280] text-white px-4 py-3 rounded-2xl rounded-br-md max-w-[80%] space-y-2">
                          {message.attachment?.kind === "image" && (
                            <Image
                              src={message.attachment.dataUrl}
                              alt={message.attachment.name || "Uploaded image"}
                              width={320}
                              height={180}
                              unoptimized
                              className="max-h-40 w-auto rounded-lg border border-white/30"
                            />
                          )}
                          {message.attachment?.kind === "pdf" && (
                            <div className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-black/10 px-2 py-1 text-xs">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 3v6h6" />
                              </svg>
                              <span className="truncate max-w-48">{message.attachment.name}</span>
                            </div>
                          )}
                          <div>{message.content}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3 max-w-3xl">
                        <div className="flex items-center gap-2 text-xs text-[#76b900]">
                          <span className="w-4 h-4 rounded overflow-hidden border border-[#d1d5db] bg-white flex items-center justify-center">
                            <Image
                              src="/nvidia_logo.png"
                              alt="NVIDIA logo"
                              width={16}
                              height={16}
                              className="object-contain"
                            />
                          </span>
                          Nemotron
                        </div>

                        {message.isStreaming && message.status && (
                          <div className="px-2 sm:px-3">
                            <div className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-3 py-1 text-xs text-[#64748b]">
                              <span className="w-1.5 h-1.5 rounded-full bg-[#6366f1] animate-pulse" />
                              {message.status}
                            </div>
                          </div>
                        )}

                        {message.reasoning && (
                          <div className="bg-[#f9fafb] border border-[#e5e7eb] rounded-xl overflow-hidden shadow-sm">
                            <div className="px-4 py-2 border-b border-[#e5e7eb] text-sm font-medium text-[#4b5563] flex items-center gap-2">
                              {message.isStreaming && !message.content ? (
                                <>
                                  <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                                  Thinking...
                                </>
                              ) : (
                                <>
                                  <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                  Reasoning
                                </>
                              )}
                            </div>
                            <div className="px-4 py-3">
                              <div className="prose prose-sm max-w-none prose-headings:text-[#2d2d2d] prose-p:text-[#374151] prose-strong:text-[#1f2937] prose-code:bg-[#f3f4f6] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-[#1f2937] prose-pre:text-gray-100">
                                {renderMarkdown(message.reasoning || "")}
                              </div>
                              {message.isStreaming && !message.content && (
                                <span className="inline-block w-2 h-4 bg-[#4b5563]/50 animate-pulse ml-1 align-middle" />
                              )}
                            </div>
                          </div>
                        )}

                        {message.convergent && (
                          <div className="bg-gradient-to-br from-[#f8fafc] via-[#f8fbff] to-[#f5f7ff] border border-[#d6deea] rounded-2xl overflow-hidden shadow-sm">
                            <div className="px-4 py-2.5 border-b border-[#dbe3ea] bg-gradient-to-r from-[#edf2f8] to-[#eef5ff] flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-[#6366f1]" />
                                <span className="text-sm font-semibold text-[#1f2937]">
                                  Convergent Thinking Mode
                                </span>
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-white border border-[#dbe3ea] text-[#64748b]">
                                  {message.convergent.status === "needs_input"
                                    ? "Needs Input"
                                    : message.convergent.status === "converged"
                                    ? "Converged"
                                    : "Running"}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedConvergent((prev) => ({
                                    ...prev,
                                    [message.id]: !prev[message.id],
                                  }))
                                }
                                className="text-xs font-semibold text-[#475569] hover:text-[#0f172a] transition-colors"
                              >
                                {expandedConvergent[message.id] ? "Collapse" : "Expand"}
                              </button>
                            </div>

                            <div className="px-4 py-3 space-y-3">
                              <div>
                                {(() => {
                                  const meterScoreRaw = animatedConvergence[message.id] ?? message.convergent.score;
                                  const meterScore = Math.max(0, Math.min(100, Math.round(meterScoreRaw)));
                                  const phase = getConvergencePhase(meterScore);
                                  const phaseColor =
                                    phase === "Diverging"
                                      ? "text-red-600"
                                      : phase === "Balanced"
                                      ? "text-amber-600"
                                      : "text-emerald-600";

                                  return (
                                    <>
                                      <div className="flex items-center justify-between text-xs text-[#64748b] mb-1">
                                        <span>
                                          Convergence Meter
                                          {message.convergent.maxRounds > 0 && (
                                            <span>{` · Round ${message.convergent.round}/${message.convergent.maxRounds}`}</span>
                                          )}
                                        </span>
                                        <span className={`font-semibold ${phaseColor}`}>
                                          {phase} · {meterScore}%
                                        </span>
                                      </div>
                                      <div className="relative h-3 rounded-full bg-[#e2e8f0] overflow-hidden">
                                        <div
                                          className={`h-full rounded-full transition-[width] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                                            message.convergent.status === "running" ? "animate-pulse" : ""
                                          }`}
                                          style={{
                                            width: `${meterScore}%`,
                                            background:
                                              meterScore < 40
                                                ? "linear-gradient(90deg,#f97316,#ef4444)"
                                                : meterScore < 75
                                                ? "linear-gradient(90deg,#f59e0b,#fbbf24)"
                                                : "linear-gradient(90deg,#10b981,#22c55e)",
                                          }}
                                        />
                                        <div
                                          className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border-2 border-white shadow transition-[left] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                                            message.convergent.status === "running" ? "animate-pulse" : ""
                                          }`}
                                          style={{
                                            left: `calc(${meterScore}% - 7px)`,
                                            background:
                                              meterScore < 40
                                                ? "#ef4444"
                                                : meterScore < 75
                                                ? "#f59e0b"
                                                : "#22c55e",
                                          }}
                                        />
                                      </div>
                                      <div className="mt-1.5 grid grid-cols-3 text-[10px] font-semibold uppercase tracking-wide">
                                        <span
                                          className={`text-left ${
                                            phase === "Diverging" ? "text-red-600" : "text-[#94a3b8]"
                                          }`}
                                        >
                                          Diverging
                                        </span>
                                        <span
                                          className={`text-center ${
                                            phase === "Balanced" ? "text-amber-600" : "text-[#94a3b8]"
                                          }`}
                                        >
                                          Balanced
                                        </span>
                                        <span
                                          className={`text-right ${
                                            phase === "Converging" ? "text-emerald-600" : "text-[#94a3b8]"
                                          }`}
                                        >
                                          Converging
                                        </span>
                                      </div>
                                    </>
                                  );
                                })()}
                              </div>

                              {expandedConvergent[message.id] && (
                                <div className="space-y-2">
                                  {message.convergent.logs.length === 0 && (
                                    <p className="text-xs text-[#64748b]">
                                      Initializing judge and debaters...
                                    </p>
                                  )}

                                  {message.convergent.logs.map((log) => (
                                    <div
                                      key={log.id}
                                      className={`rounded-xl border px-3 py-2 shadow-sm ${
                                        log.role === "judge"
                                          ? "border-[#dbeafe] bg-[#eff6ff]"
                                          : log.role === "debater_a"
                                          ? "border-[#e2e8f0] bg-white"
                                          : log.role === "debater_b"
                                          ? "border-[#fee2e2] bg-[#fff5f5]"
                                          : "border-[#dcfce7] bg-[#f0fdf4]"
                                      }`}
                                    >
                                      <div className="mb-1 flex items-center justify-between text-[11px]">
                                        <span className="font-semibold text-[#475569] uppercase tracking-wide">
                                          {log.role === "judge"
                                            ? "Judge"
                                            : log.role === "debater_a"
                                            ? "Debater A"
                                            : log.role === "debater_b"
                                            ? "Debater B"
                                            : "Executor"}
                                        </span>
                                        <span className="text-[#94a3b8]">
                                          {log.round > 0 ? `Round ${log.round}` : "Init"}
                                        </span>
                                      </div>
                                      <div className="prose prose-sm max-w-none prose-headings:text-[#2d2d2d] prose-p:text-[#334155] prose-strong:text-[#1f2937] prose-code:bg-[#f3f4f6] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-[#1f2937] prose-pre:text-gray-100">
                                        {renderMarkdown(log.content || "")}
                                      </div>
                                    </div>
                                  ))}

                                  {message.convergent.clarifyingQuestions.length > 0 && (
                                    <div className="rounded-lg border border-[#f59e0b]/30 bg-[#fffbeb] px-3 py-2">
                                      <p className="text-xs font-semibold text-[#92400e] mb-1">
                                        Clarifying Questions from Judge
                                      </p>
                                      <ul className="list-disc pl-4 space-y-0.5 text-sm text-[#78350f]">
                                        {message.convergent.clarifyingQuestions.map((q, idx) => (
                                          <li key={`${message.id}-q-${idx}`}>{q}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {message.isStreaming &&
                          !message.content &&
                          !message.reasoning &&
                          !message.convergent && (
                            <div className="px-2 sm:px-3">
                              <div className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e7eb] bg-[#f9fafb] px-3 py-1.5 text-[#6b7280]">
                                <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce" />
                                <span
                                  className="h-1.5 w-1.5 rounded-full bg-current animate-bounce"
                                  style={{ animationDelay: "120ms" }}
                                />
                                <span
                                  className="h-1.5 w-1.5 rounded-full bg-current animate-bounce"
                                  style={{ animationDelay: "240ms" }}
                                />
                              </div>
                            </div>
                          )}

                        {(message.content || (!message.reasoning && !message.isStreaming)) && (
                          <div className="px-2 sm:px-3">
                            <div className="prose prose-sm max-w-none prose-headings:text-[#2d2d2d] prose-p:text-[#374151] prose-strong:text-[#1f2937] prose-code:bg-[#f3f4f6] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-[#1f2937] prose-pre:text-gray-100">
                              {renderMarkdown(message.content || "...")}
                              {message.isStreaming && message.content && (
                                <span className="inline-block w-2 h-4 bg-[#2d2d2d]/50 animate-pulse ml-1 align-middle" />
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            </main>

            {/* Chat input bar */}
            <div className="fixed bottom-0 right-0 p-4 bg-gradient-to-t from-[#fffaf2] to-transparent transition-all duration-200" style={{ left: sidebarWidth }}>
              <div className="w-full max-w-5xl mx-auto px-2 sm:px-4">
                <div className="bg-[#fffaf2] rounded-2xl border border-[#e5e7eb] shadow-sm overflow-hidden">
                  {attachedFile && (
                    <div className="px-4 pt-3">
                      <div className="flex items-center gap-3 rounded-xl border border-[#e5e7eb] bg-[#f8fafc] px-3 py-2">
                        {attachedFile.kind === "image" ? (
                          <Image
                            src={attachedFile.dataUrl}
                            alt={attachedFile.name}
                            width={48}
                            height={48}
                            unoptimized
                            className="h-12 w-12 rounded-md object-cover border border-[#d1d5db]"
                          />
                        ) : (
                          <div className="h-12 w-12 rounded-md border border-[#d1d5db] bg-white flex items-center justify-center text-[#dc2626]">
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 3v6h6" />
                            </svg>
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-[#2d2d2d] truncate">
                            {attachedFile.name}
                          </p>
                          <p className="text-[11px] text-[#64748b]">
                            {attachedFile.kind === "pdf" ? "Analyzing PDF." : "Analyzing image."}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setAttachedFile(null)}
                          className="text-[#9ca3af] hover:text-[#6b7280] transition-colors"
                          aria-label="Remove attachment"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="px-4 pt-3 pb-2">
                    <div className="flex items-end gap-3">
                      <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            sendMessage();
                          }
                        }}
                        placeholder="Ask anything..."
                        className="min-h-[42px] max-h-40 w-full bg-transparent outline-none text-[#2d2d2d] placeholder-[#9ca3af] text-[15px] leading-6 resize-none overflow-y-auto whitespace-pre-wrap break-words"
                        rows={2}
                        disabled={isLoading}
                      />
                      <button
                        onClick={isLoading ? stopGeneration : sendMessage}
                        disabled={!isLoading && !input.trim() && !attachedFile}
                        className="w-8 h-8 mb-1 rounded-full bg-[#7c6bf5] text-white flex items-center justify-center hover:bg-[#6c5ce7] transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                        title={isLoading ? "Stop generation" : "Send message"}
                      >
                        {isLoading ? (
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
                            <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 px-4 pb-3">
                    <button
                      type="button"
                      onClick={handleAttachClick}
                      className="p-1 rounded-md hover:bg-[#f3f4f6] transition-colors text-[#9ca3af] flex-shrink-0"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4.5 4.5 0 016.36 6.36l-9.2 9.19a3 3 0 01-4.24-4.24l8.49-8.48" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConvergentToggle(!convergentEnabled)}
                      disabled={isLoading}
                      className={`h-8 px-3 rounded-lg border text-xs font-medium transition-colors flex-shrink-0 ${
                        convergentEnabled
                          ? "bg-[#2d2d2d] border-[#2d2d2d] text-white"
                          : "bg-[#fffaf2] border-[#e5e7eb] text-[#6b7280] hover:bg-[#f3f4f6]"
                      } disabled:opacity-60`}
                    >
                      ConvergentThinking {convergentEnabled ? "On" : "Off"}
                    </button>
                    <span className="text-[11px] text-[#6b7280]">
                      Active: {convergentEnabled ? "30B" : "9B"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}


