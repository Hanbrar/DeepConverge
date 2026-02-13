"use client";

import { useState, KeyboardEvent } from "react";

interface DebateInputProps {
  onSubmit: (question: string) => void;
  isLoading?: boolean;
}

export default function DebateInput({ onSubmit, isLoading }: DebateInputProps) {
  const [question, setQuestion] = useState("");

  const handleSubmit = () => {
    if (question.trim() && !isLoading) {
      onSubmit(question.trim());
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="w-full max-w-2xl">
      <div className="glass-card flex items-center gap-3 p-2 pl-4">
        <svg
          className="w-5 h-5 text-muted flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask DeepConverge anything... code, decisions, ideas"
          className="flex-1 bg-transparent outline-none text-charcoal placeholder-muted"
          disabled={isLoading}
        />
        <button
          onClick={handleSubmit}
          disabled={!question.trim() || isLoading}
          className="px-5 py-2.5 bg-coral text-white rounded-full font-medium text-sm hover:bg-coral-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isLoading ? (
            <>
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
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
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>Debating...</span>
            </>
          ) : (
            <>
              <span>Start Debate</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M14 5l7 7m0 0l-7 7m7-7H3"
                />
              </svg>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
