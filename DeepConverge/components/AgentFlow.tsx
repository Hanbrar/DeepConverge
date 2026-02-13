"use client";

import { agents } from "@/lib/agents";

const agentCards = [
  { role: "advocate" as const, icon: "👍" },
  { role: "critic" as const, icon: "⚔️" },
  { role: "judge" as const, icon: "⚖️" },
];

export default function AgentFlow() {
  return (
    <div className="flex items-center justify-center gap-2 md:gap-4">
      {agentCards.map((card, index) => {
        const agent = agents[card.role];
        const isFirst = index === 0;

        return (
          <div key={card.role} className="flex items-center">
            {/* Connector line */}
            {index > 0 && (
              <div className="w-6 md:w-10 h-[2px] bg-gray-300 mr-2 md:mr-4" />
            )}

            {/* Agent card */}
            <div className="glass-card p-4 md:p-6 flex flex-col items-center min-w-[100px] md:min-w-[140px]">
              <div
                className="w-10 h-10 md:w-12 md:h-12 rounded-xl flex items-center justify-center mb-2 md:mb-3"
                style={{
                  backgroundColor: isFirst ? "#fef2f0" : "#f3f4f6",
                }}
              >
                <span className="text-xl md:text-2xl">{card.icon}</span>
              </div>
              <h3
                className="font-semibold text-sm md:text-base"
                style={{ color: isFirst ? agent.color : "#374151" }}
              >
                {agent.name.toUpperCase()}
              </h3>
              <p className="text-xs text-muted text-center mt-1">
                {agent.description}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
