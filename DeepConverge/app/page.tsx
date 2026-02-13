"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
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
  reasoning?: string;
  isStreaming?: boolean;
}

type Mode = "agentic" | "debate";
type DebatePhase = "setup" | "active";
type DebateType = "regular" | "continuous";

export default function Home() {
  // Core mode state
  const [mode, setMode] = useState<Mode>("agentic");
  const [debatePhase, setDebatePhase] = useState<DebatePhase>("setup");

  // Chat/agentic state
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Debate state
  const [debateQuestion, setDebateQuestion] = useState("");
  const [debateType, setDebateType] = useState<DebateType>("regular");
  const [continuousRounds, setContinuousRounds] = useState(3);

  // Sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Keyboard shortcut: Ctrl+K for New Chat
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNewChat = () => {
    setMessages([]);
    setInput("");
    setMode("agentic");
  };

  // ── Chat logic (unchanged) ───────────────────────────────────────────
  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
    };

    const assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content: "",
      reasoning: "",
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setIsLoading(true);

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 300000);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input.trim() }),
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
                      ? { ...msg, reasoning: data.content }
                      : msg
                  )
                );
              } else if (data.type === "content") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? { ...msg, content: data.content }
                      : msg
                  )
                );
              } else if (data.type === "done") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? { ...msg, isStreaming: false }
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
                content: isTimeout
                  ? "The request took too long. The reasoning above shows the progress made. Please try a simpler question or try again."
                  : "Sorry, there was an error. Please try again.",
                isStreaming: false,
              }
            : msg
        )
      );
    } finally {
      clearTimeout(timeoutId);
      setIsLoading(false);
    }
  };

  // ── Debate helpers ───────────────────────────────────────────────────
  const startDebate = () => {
    if (!debateQuestion.trim()) return;
    setDebatePhase("active");
  };

  const onDebateBack = () => {
    setDebatePhase("setup");
  };

  const debateRounds = debateType === "regular" ? 2 : continuousRounds;

  // ── DEBATE ACTIVE → full-screen DebateCanvas ──────────────────────────
  if (mode === "debate" && debatePhase === "active") {
    return (
      <DebateCanvas
        question={debateQuestion}
        rounds={debateRounds}
        onBack={onDebateBack}
      />
    );
  }

  // ── Derived values ───────────────────────────────────────────────────
  const sidebarWidth = sidebarOpen ? 240 : 56;
  const isAgenticMode = mode === "agentic";

  // ── SINGLE-PAGE SHELL ────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex bg-[#fffaf3]">
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
        <div className="px-3 mb-2">
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
        {mode === "agentic" ? (
          <>
            {/* Agentic Mode */}
            <main className="flex-1 pb-32 px-4">
              <div className="max-w-3xl mx-auto space-y-6">
                {messages.length === 0 ? (
                  <div className="text-center pt-32">
                    <h1 className="text-4xl font-bold text-[#2d2d2d] mb-6 flex items-center justify-center gap-0">
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

                    {/* Mode toggle */}
                    <div className="flex items-center justify-center gap-10 mb-12">
                      <button
                        onClick={() => setMode("agentic")}
                        className={`text-base pb-1 transition-all ${
                          isAgenticMode
                            ? "text-[#2d2d2d] font-semibold border-b-2 border-[#2d2d2d]"
                            : "text-[#9ca3af] hover:text-[#6b7280]"
                        }`}
                      >
                        Agentic Mode
                      </button>
                      <button
                        onClick={() => setMode("debate")}
                        className={`text-base pb-1 transition-all ${
                          !isAgenticMode
                            ? "text-[#2d2d2d] font-semibold border-b-2 border-[#2d2d2d]"
                            : "text-[#9ca3af] hover:text-[#6b7280]"
                        }`}
                      >
                        Debate Mode
                      </button>
                    </div>

                    {/* Centered input for empty state */}
                    <div className="max-w-2xl mx-auto">
                      <div className="bg-[#fffaf2] rounded-2xl border border-[#e5e7eb] shadow-sm overflow-hidden">
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
                        />
                        <div className="flex items-center justify-between px-4 pb-3">
                          <button className="p-1.5 rounded-md hover:bg-[#f3f4f6] transition-colors text-[#9ca3af]">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                          </button>
                          <button
                            onClick={sendMessage}
                            disabled={!input.trim() || isLoading}
                            className="w-8 h-8 rounded-full bg-[#7c6bf5] text-white flex items-center justify-center hover:bg-[#6c5ce7] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            {isLoading ? (
                              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
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
                  </div>
                ) : (
                  <>
                    {/* Mode toggle (when messages exist) */}
                    <div className="flex items-center justify-center gap-10 pt-6 mb-4">
                      <button
                        onClick={() => setMode("agentic")}
                        className={`text-sm pb-1 transition-all ${
                          isAgenticMode
                            ? "text-[#2d2d2d] font-semibold border-b-2 border-[#2d2d2d]"
                            : "text-[#9ca3af] hover:text-[#6b7280]"
                        }`}
                      >
                        Agentic Mode
                      </button>
                      <button
                        onClick={() => setMode("debate")}
                        className={`text-sm pb-1 transition-all ${
                          !isAgenticMode
                            ? "text-[#2d2d2d] font-semibold border-b-2 border-[#2d2d2d]"
                            : "text-[#9ca3af] hover:text-[#6b7280]"
                        }`}
                      >
                        Debate Mode
                      </button>
                    </div>

                    {/* Messages */}
                    {messages.map((message) => (
                      <div key={message.id}>
                        {message.role === "user" ? (
                          <div className="flex justify-end">
                            <div className="bg-[#f08a7a] text-white px-4 py-3 rounded-2xl rounded-br-md max-w-[80%]">
                              {message.content}
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2 text-xs text-[#76b900]">
                              <span className="w-4 h-4 rounded bg-[#76b900] flex items-center justify-center">
                                <span className="text-white text-[10px] font-bold">N</span>
                              </span>
                              Nemotron
                            </div>

                            {message.reasoning && (
                              <div className="bg-[#f9fafb] border border-[#e5e7eb] rounded-xl overflow-hidden">
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
                                <div className="px-4 py-3 text-sm text-[#4b5563] whitespace-pre-wrap max-h-64 overflow-y-auto">
                                  {message.reasoning}
                                  {message.isStreaming && !message.content && (
                                    <span className="inline-block w-2 h-4 bg-[#4b5563]/50 animate-pulse ml-1" />
                                  )}
                                </div>
                              </div>
                            )}

                            {(message.content || (!message.reasoning && !message.isStreaming)) && (
                              <div className="bg-[#fffaf2] rounded-2xl rounded-tl-md overflow-hidden shadow-sm border border-[#e5e7eb]">
                                <div className="px-4 py-2 border-b border-[#e5e7eb] bg-[#f9fafb] flex items-center gap-2">
                                  {message.isStreaming ? (
                                    <>
                                      <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                                      <span className="text-sm font-medium text-[#4b5563]">Answer</span>
                                    </>
                                  ) : (
                                    <>
                                      <svg className="w-4 h-4 text-[#76b900]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                      </svg>
                                      <span className="text-sm font-medium text-[#4b5563]">Answer</span>
                                    </>
                                  )}
                                </div>
                                <div className="px-5 py-4">
                                  <div className="prose prose-sm max-w-none prose-headings:text-[#2d2d2d] prose-p:text-[#374151] prose-strong:text-[#1f2937] prose-code:bg-[#f3f4f6] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-[#1f2937] prose-pre:text-gray-100">
                                    <ReactMarkdown
                                      remarkPlugins={[remarkMath, remarkGfm]}
                                      rehypePlugins={[rehypeKatex]}
                                    >
                                      {preprocessLaTeX(message.content || "...")}
                                    </ReactMarkdown>
                                    {message.isStreaming && message.content && (
                                      <span className="inline-block w-2 h-4 bg-[#2d2d2d]/50 animate-pulse ml-1" />
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                )}
                <div ref={messagesEndRef} />
              </div>
            </main>

            {/* Chat input bar (when messages exist) */}
            {messages.length > 0 && (
              <div className="fixed bottom-0 right-0 p-4 bg-gradient-to-t from-[#fffaf2] to-transparent transition-all duration-200" style={{ left: sidebarWidth }}>
                <div className="max-w-3xl mx-auto">
                  <div className="bg-[#fffaf2] rounded-2xl border border-[#e5e7eb] shadow-sm overflow-hidden">
                    <div className="flex items-center gap-3 px-4 py-3">
                      <button className="p-1 rounded-md hover:bg-[#f3f4f6] transition-colors text-[#9ca3af] flex-shrink-0">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                      </button>
                      <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
                        placeholder="Ask anything..."
                        className="flex-1 bg-transparent outline-none text-[#2d2d2d] placeholder-[#9ca3af] text-[15px]"
                        disabled={isLoading}
                      />
                      <button
                        onClick={sendMessage}
                        disabled={!input.trim() || isLoading}
                        className="w-8 h-8 rounded-full bg-[#7c6bf5] text-white flex items-center justify-center hover:bg-[#6c5ce7] transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                      >
                        {isLoading ? (
                          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
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
              </div>
            )}
          </>
        ) : (
          <>
            {/* Debate Mode: Setup UI */}
            <main className="flex-1 px-4 flex flex-col items-center justify-center">
              {/* Mode toggle */}
              <div className="flex items-center justify-center gap-10 mb-10">
                <button
                  onClick={() => setMode("agentic")}
                  className={`text-base pb-1 transition-all ${
                    isAgenticMode
                      ? "text-[#2d2d2d] font-semibold border-b-2 border-[#2d2d2d]"
                      : "text-[#9ca3af] hover:text-[#6b7280]"
                  }`}
                >
                  Agentic Mode
                </button>
                <button
                  onClick={() => setMode("debate")}
                  className={`text-base pb-1 transition-all ${
                    !isAgenticMode
                      ? "text-[#2d2d2d] font-semibold border-b-2 border-[#2d2d2d]"
                      : "text-[#9ca3af] hover:text-[#6b7280]"
                  }`}
                >
                  Debate Mode
                </button>
              </div>

              <div className="max-w-lg w-full space-y-8">
                {/* Title */}
                <div className="text-center">
                  <h1 className="text-3xl font-semibold text-[#2d2d2d] mb-2">
                    Debate Mode
                  </h1>
                  <p className="text-[#6b7280]">
                    Watch two AI debaters go head-to-head with a moderator
                  </p>
                </div>

                {/* Debate question input */}
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
                    autoFocus
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
                          ? "border-[#f08a7a] bg-[#f08a7a]/5 shadow-sm"
                          : "border-[#e5e7eb] bg-[#fffaf2] hover:border-[#d1d5db]"
                      }`}
                    >
                      <div className="text-2xl mb-2">&#9889;</div>
                      <div className="font-medium text-[#2d2d2d] text-sm">Regular</div>
                      <div className="text-xs text-[#6b7280] mt-1">
                        2 rounds (4 exchanges) - quick and efficient
                      </div>
                      {debateType === "regular" && (
                        <div className="absolute top-2 right-2 w-5 h-5 bg-[#f08a7a] rounded-full flex items-center justify-center">
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
                          ? "border-[#f08a7a] bg-[#f08a7a]/5 shadow-sm"
                          : "border-[#e5e7eb] bg-[#fffaf2] hover:border-[#d1d5db]"
                      }`}
                    >
                      <div className="text-2xl mb-2">&#128260;</div>
                      <div className="font-medium text-[#2d2d2d] text-sm">Continuous</div>
                      <div className="text-xs text-[#6b7280] mt-1">
                        Set custom rounds (up to 5)
                      </div>
                      {debateType === "continuous" && (
                        <div className="absolute top-2 right-2 w-5 h-5 bg-[#f08a7a] rounded-full flex items-center justify-center">
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
                        <span className="text-sm font-bold text-[#f08a7a]">{continuousRounds}</span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="5"
                        value={continuousRounds}
                        onChange={(e) => setContinuousRounds(parseInt(e.target.value))}
                        className="w-full accent-[#f08a7a]"
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
                  className="w-full py-3.5 bg-[#f08a7a] text-white rounded-xl font-medium text-base hover:bg-[#e87a6a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-[#f08a7a]/20"
                >
                  <span>Start Debate</span>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                </button>

                {/* Footer */}
                <p className="text-xs text-[#9ca3af] text-center">
                  Powered by NVIDIA Nemotron via OpenRouter
                </p>
              </div>
            </main>
          </>
        )}
      </div>
    </div>
  );
}
