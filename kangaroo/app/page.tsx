"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  isStreaming?: boolean;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input.trim() }),
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
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessage.id
            ? { ...msg, content: "Sorry, there was an error. Please try again.", isStreaming: false }
            : msg
        )
      );
    } finally {
      setIsLoading(false);
    }
  };

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
          Nemotron 3 Nano 30B A3B (free)
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
                    {/* Model indicator */}
                    <div className="flex items-center gap-2 text-xs text-[#76b900]">
                      <span className="w-4 h-4 rounded bg-[#76b900] flex items-center justify-center">
                        <span className="text-white text-[10px] font-bold">N</span>
                      </span>
                      Nemotron 3 Nano 30B A3B (free)
                    </div>

                    {/* Reasoning block - always visible when present */}
                    {message.reasoning && (
                      <div className="bg-[#f9fafb] border border-[#e5e7eb] rounded-xl overflow-hidden">
                        <div className="px-4 py-2 border-b border-[#e5e7eb] text-sm font-medium text-[#4b5563]">
                          Reasoning
                        </div>
                        <div className="px-4 py-3 text-sm text-[#4b5563] whitespace-pre-wrap max-h-64 overflow-y-auto">
                          {message.reasoning}
                          {message.isStreaming && !message.content && (
                            <span className="inline-block w-2 h-4 bg-[#4b5563]/50 animate-pulse ml-1" />
                          )}
                        </div>
                      </div>
                    )}

                    {/* Main content */}
                    {(message.content || !message.reasoning) && (
                      <div className="bg-white rounded-2xl rounded-tl-md px-5 py-4 shadow-sm">
                        <div className="prose prose-sm max-w-none">
                          <ReactMarkdown
                            remarkPlugins={[remarkMath]}
                            rehypePlugins={[rehypeKatex]}
                          >
                            {message.content || (message.isStreaming ? "" : "...")}
                          </ReactMarkdown>
                          {message.isStreaming && message.content && (
                            <span className="inline-block w-2 h-4 bg-[#2d2d2d]/50 animate-pulse ml-1" />
                          )}
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
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M14 5l7 7m0 0l-7 7m7-7H3"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
