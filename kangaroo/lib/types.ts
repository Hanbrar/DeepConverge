export type AgentRole = "advocate" | "critic" | "judge";

export interface Agent {
  id: AgentRole;
  name: string;
  description: string;
  color: string;
  icon: string;
  systemPrompt: string;
}

export interface Message {
  id: string;
  agent: AgentRole;
  content: string;
  reasoning?: string;
  timestamp: Date;
  isStreaming?: boolean;
}

export interface DebateState {
  question: string;
  messages: Message[];
  status: "idle" | "debating" | "complete";
  currentAgent?: AgentRole;
}

export interface StreamChunk {
  agent: AgentRole;
  content: string;
  reasoning?: string;
  done: boolean;
}
