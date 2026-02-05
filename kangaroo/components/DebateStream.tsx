"use client";

import { useRef, useEffect } from "react";
import { Message } from "@/lib/types";
import AgentMessage from "./AgentMessage";

interface DebateStreamProps {
  messages: Message[];
  currentAgent?: string;
}

export default function DebateStream({ messages, currentAgent }: DebateStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) return null;

  return (
    <div className="w-full max-w-2xl space-y-4">
      {messages.map((message) => (
        <AgentMessage
          key={message.id}
          agent={message.agent}
          content={message.content}
          reasoning={message.reasoning}
          isStreaming={message.isStreaming}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
