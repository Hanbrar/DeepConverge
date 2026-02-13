"use client";

import { agents } from "@/lib/agents";
import { AgentRole } from "@/lib/types";
import ReasoningBlock from "./ReasoningBlock";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { preprocessLaTeX } from "@/lib/latex";

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

  // Determine current phase
  const isThinking = isStreaming && reasoning && !content;
  const isAnswering = isStreaming && content;

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
        {/* Phase indicator */}
        {isStreaming && (
          <div className="ml-auto flex items-center gap-2">
            {isThinking ? (
              <>
                <svg className="w-4 h-4 text-purple-500 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                <span className="text-xs text-purple-600 font-medium">Thinking...</span>
              </>
            ) : isAnswering ? (
              <>
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span className="text-xs text-green-600 font-medium">Answering...</span>
              </>
            ) : (
              <>
                <div className="w-2 h-2 bg-coral rounded-full animate-pulse" />
                <span className="text-xs text-muted">Starting...</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Reasoning block - shows FIRST while thinking */}
      {reasoning && <ReasoningBlock reasoning={reasoning} agentName={agentInfo.name} />}

      {/* Answer section */}
      {(content || !isStreaming) && (
        <>
          {/* Divider between reasoning and answer */}
          {reasoning && content && (
            <div className="flex items-center gap-2 my-4">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-xs text-gray-400 font-medium">Answer</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>
          )}

          {/* Content */}
          <div className="prose prose-sm max-w-none prose-table:border-collapse prose-th:border prose-th:border-gray-300 prose-th:bg-gray-50 prose-th:px-3 prose-th:py-2 prose-td:border prose-td:border-gray-300 prose-td:px-3 prose-td:py-2">
            <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
              {preprocessLaTeX(content || "")}
            </ReactMarkdown>
          </div>
        </>
      )}

      {/* Show waiting indicator if streaming but no content yet and no reasoning */}
      {isStreaming && !content && !reasoning && (
        <div className="flex items-center gap-2 text-gray-400">
          <div className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
          <span className="text-sm">Waiting for response...</span>
        </div>
      )}
    </div>
  );
}
