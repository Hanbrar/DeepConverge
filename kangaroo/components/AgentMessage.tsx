"use client";

import { agents } from "@/lib/agents";
import { AgentRole } from "@/lib/types";
import ReasoningBlock from "./ReasoningBlock";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

interface AgentMessageProps {
  agent: AgentRole;
  content: string;
  reasoning?: string;
  isStreaming?: boolean;
}

export default function AgentMessage({
  agent,
  content,
  reasoning,
  isStreaming,
}: AgentMessageProps) {
  const agentInfo = agents[agent];
  const isAdvocate = agent === "advocate";
  const isJudge = agent === "judge";

  return (
    <div
      className={`glass-card p-5 ${isJudge ? "border-2 border-amber-200 bg-amber-50/50" : ""}`}
    >
      {/* Agent header */}
      <div className="flex items-center gap-3 mb-4">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{
            backgroundColor: isAdvocate ? "#fef2f0" : isJudge ? "#fef9c3" : "#f3f4f6",
          }}
        >
          <span className="text-xl">{agentInfo.icon}</span>
        </div>
        <div>
          <h3
            className="font-semibold"
            style={{ color: isAdvocate ? agentInfo.color : isJudge ? "#b45309" : "#374151" }}
          >
            {agentInfo.name}
          </h3>
          <p className="text-xs text-muted">{agentInfo.description}</p>
        </div>
        {isStreaming && (
          <div className="ml-auto flex items-center gap-1">
            <div className="w-2 h-2 bg-coral rounded-full animate-pulse" />
            <span className="text-xs text-muted">typing...</span>
          </div>
        )}
      </div>

      {/* Reasoning block */}
      {reasoning && <ReasoningBlock reasoning={reasoning} agentName={agentInfo.name} />}

      {/* Content */}
      <div className="prose prose-sm max-w-none prose-table:border-collapse prose-th:border prose-th:border-gray-300 prose-th:bg-gray-50 prose-th:px-3 prose-th:py-2 prose-td:border prose-td:border-gray-300 prose-td:px-3 prose-td:py-2">
        <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
          {content || (isStreaming ? "Thinking..." : "")}
        </ReactMarkdown>
        {isStreaming && !content && (
          <span className="inline-block w-2 h-5 bg-charcoal/50 animate-pulse ml-1" />
        )}
      </div>
    </div>
  );
}
