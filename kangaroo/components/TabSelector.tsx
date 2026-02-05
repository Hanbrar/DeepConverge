"use client";

import { useState } from "react";

const tabs = [
  { id: "general", label: "General", icon: "🔮" },
  { id: "debate", label: "Debate", icon: "⚡" },
  { id: "productivity", label: "Productivity", icon: "📊" },
];

interface TabSelectorProps {
  activeTab?: string;
  onTabChange?: (tab: string) => void;
}

export default function TabSelector({ activeTab = "debate", onTabChange }: TabSelectorProps) {
  const [selected, setSelected] = useState(activeTab);

  const handleTabClick = (tabId: string) => {
    setSelected(tabId);
    onTabChange?.(tabId);
  };

  return (
    <div className="flex items-center gap-1 p-1 bg-white/50 rounded-full">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => handleTabClick(tab.id)}
          className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${
            selected === tab.id
              ? "bg-white shadow-sm text-charcoal"
              : "text-muted hover:text-charcoal"
          }`}
        >
          <span>{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
