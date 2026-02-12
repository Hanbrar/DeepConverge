"use client";

import { useState, useRef, useEffect } from "react";
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

type AppMode = "home" | "chat" | "debate-setup" | "debate-active";
type DebateType = "regular" | "continuous";

export default function Home() {
  const [appMode, setAppMode] = useState<AppMode>("home");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Debate state
  const [debateQuestion, setDebateQuestion] = useState("");
  const [debateType, setDebateType] = useState<DebateType>("regular");
  const [continuousRounds, setContinuousRounds] = useState(3);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

  const goHome = () => {
    setAppMode("home");
    setDebateQuestion("");
    setMessages([]);
  };

  const startDebate = () => {
    if (!debateQuestion.trim()) return;
    setAppMode("debate-active");
  };

  const debateRounds = debateType === "regular" ? 2 : continuousRounds;

  // --- DEBATE ACTIVE VIEW ---
  if (appMode === "debate-active") {
    return (
      <DebateCanvas
        question={debateQuestion}
        rounds={debateRounds}
        onBack={goHome}
      />
    );
  }

  // --- CHAT VIEW ---
  if (appMode === "chat") {
    return (
      <div className="min-h-screen flex flex-col">
        {/* Header */}
        <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 bg-gradient-to-b from-[#f5f0f5] to-transparent">
          <button
            onClick={goHome}
            className="flex items-center gap-2 text-[#6b7280] hover:text-[#2d2d2d] transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-[#76b900] flex items-center justify-center">
              <span className="text-white font-bold text-sm">K</span>
            </div>
            <span className="font-semibold text-[#2d2d2d]">Kangaroo</span>
          </div>
          <div className="text-xs text-[#6b7280] flex items-center gap-2">
            <span className="w-2 h-2 bg-[#76b900] rounded-full"></span>
            Nemotron 3 Nano 30B A3B
          </div>
        </header>

        {/* Messages */}
        <main className="flex-1 pt-20 pb-32 px-4">
          <div className="max-w-3xl mx-auto space-y-6">
            {messages.length === 0 ? (
              <div className="text-center py-20">
                <div className="w-16 h-16 rounded-2xl bg-white shadow-sm flex items-center justify-center mx-auto mb-6">
                  <span className="text-3xl">🦘</span>
                </div>
                <h1 className="text-3xl font-semibold text-[#2d2d2d] mb-3">
                  Ask anything
                </h1>
                <p className="text-[#6b7280] max-w-md mx-auto">
                  Powered by NVIDIA Nemotron with reasoning capabilities
                </p>
              </div>
            ) : (
              messages.map((message) => (
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
                        Nemotron 3 Nano 30B A3B
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
                        <div className="bg-white rounded-2xl rounded-tl-md overflow-hidden shadow-sm border border-[#e5e7eb]">
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
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        </main>

        {/* Input */}
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-[#f5f0f5] to-transparent">
          <div className="max-w-3xl mx-auto">
            <div className="bg-white rounded-full flex items-center gap-3 p-2 pl-5 shadow-lg">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
                placeholder="Ask Kangaroo anything..."
                className="flex-1 bg-transparent outline-none text-[#2d2d2d] placeholder-[#6b7280]"
                disabled={isLoading}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || isLoading}
                className="px-5 py-2.5 bg-[#f08a7a] text-white rounded-full font-medium text-sm hover:bg-[#e87a6a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isLoading ? (
                  <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- DEBATE SETUP VIEW ---
  if (appMode === "debate-setup") {
    return (
      <div className="min-h-screen flex flex-col">
        <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 bg-gradient-to-b from-[#f5f0f5] to-transparent">
          <button
            onClick={goHome}
            className="flex items-center gap-2 text-[#6b7280] hover:text-[#2d2d2d] transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-[#76b900] flex items-center justify-center">
              <span className="text-white font-bold text-sm">K</span>
            </div>
            <span className="font-semibold text-[#2d2d2d]">Debate Setup</span>
          </div>
          <div className="w-16" />
        </header>

        <main className="flex-1 pt-20 px-4 flex items-center justify-center">
          <div className="max-w-lg w-full space-y-8">
            {/* Title */}
            <div className="text-center">
              <div className="w-20 h-20 rounded-2xl bg-white shadow-sm flex items-center justify-center mx-auto mb-4">
                <span className="text-4xl">⚔️</span>
              </div>
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
                className="w-full bg-white rounded-xl px-4 py-3 border border-[#e5e7eb] outline-none focus:ring-2 focus:ring-[#f08a7a]/50 focus:border-[#f08a7a] text-[#2d2d2d] placeholder-[#9ca3af]"
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
                      : "border-[#e5e7eb] bg-white hover:border-[#d1d5db]"
                  }`}
                >
                  <div className="text-2xl mb-2">⚡</div>
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
                      : "border-[#e5e7eb] bg-white hover:border-[#d1d5db]"
                  }`}
                >
                  <div className="text-2xl mb-2">🔄</div>
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
                <div className="mt-4 bg-white rounded-xl p-4 border border-[#e5e7eb]">
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
          </div>
        </main>
      </div>
    );
  }

  // --- HOME SCREEN ---
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 bg-gradient-to-b from-[#f5f0f5] to-transparent">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#76b900] flex items-center justify-center">
            <span className="text-white font-bold text-sm">K</span>
          </div>
          <span className="font-semibold text-[#2d2d2d]">Kangaroo</span>
        </div>
        <div className="text-xs text-[#6b7280] flex items-center gap-2">
          <span className="w-2 h-2 bg-[#76b900] rounded-full"></span>
          Nemotron 3 Nano 30B A3B
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="max-w-lg w-full text-center space-y-10">
          {/* Logo */}
          <div>
            <div className="w-20 h-20 rounded-2xl bg-white shadow-sm flex items-center justify-center mx-auto mb-6">
              <span className="text-4xl">🦘</span>
            </div>
            <h1 className="text-4xl font-bold text-[#2d2d2d] mb-3">Kangaroo</h1>
            <p className="text-[#6b7280] text-lg">
              AI-powered conversations and debates
            </p>
          </div>

          {/* Mode selection */}
          <div className="grid grid-cols-2 gap-4">
            {/* Chat mode */}
            <button
              onClick={() => setAppMode("chat")}
              className="group relative bg-white rounded-2xl p-6 border-2 border-[#e5e7eb] hover:border-[#76b900] hover:shadow-lg transition-all text-left"
            >
              <div className="w-12 h-12 rounded-xl bg-[#76b900]/10 flex items-center justify-center mb-4 group-hover:bg-[#76b900]/20 transition-colors">
                <span className="text-2xl">💬</span>
              </div>
              <h2 className="text-lg font-semibold text-[#2d2d2d] mb-1">Chat</h2>
              <p className="text-sm text-[#6b7280]">
                Regular conversation with AI reasoning
              </p>
              <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                <svg className="w-5 h-5 text-[#76b900]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </div>
            </button>

            {/* Debate mode */}
            <button
              onClick={() => setAppMode("debate-setup")}
              className="group relative bg-white rounded-2xl p-6 border-2 border-[#e5e7eb] hover:border-[#f08a7a] hover:shadow-lg transition-all text-left"
            >
              <div className="w-12 h-12 rounded-xl bg-[#f08a7a]/10 flex items-center justify-center mb-4 group-hover:bg-[#f08a7a]/20 transition-colors">
                <span className="text-2xl">⚔️</span>
              </div>
              <h2 className="text-lg font-semibold text-[#2d2d2d] mb-1">Debate</h2>
              <p className="text-sm text-[#6b7280]">
                Watch AIs argue with a moderator
              </p>
              <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                <svg className="w-5 h-5 text-[#f08a7a]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </div>
            </button>
          </div>

          {/* Footer note */}
          <p className="text-xs text-[#9ca3af]">
            Powered by NVIDIA Nemotron via OpenRouter
          </p>
        </div>
      </main>
    </div>
  );
}
