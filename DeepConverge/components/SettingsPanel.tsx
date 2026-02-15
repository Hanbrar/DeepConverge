"use client";

import { useState } from "react";
import Image from "next/image";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { updateProfile } from "@/lib/supabase/profile";

interface SettingsPanelProps {
  onClose: () => void;
  user: User;
  apiKey: string | null;
  onApiKeyChange: (key: string | null) => void;
  displayName: string | null;
  onDisplayNameChange: (name: string) => void;
}

type KeyStatus = "idle" | "verifying" | "valid" | "invalid";

export default function SettingsPanel({
  onClose,
  user,
  apiKey,
  onApiKeyChange,
  displayName,
  onDisplayNameChange,
}: SettingsPanelProps) {
  const [keyInput, setKeyInput] = useState(apiKey || "");
  const [showKey, setShowKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>(apiKey ? "valid" : "idle");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState(displayName || "");
  const [nameSaved, setNameSaved] = useState(false);

  const handleVerifyKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) {
      setKeyError("Please enter an API key");
      return;
    }

    setKeyStatus("verifying");
    setKeyError(null);

    try {
      const res = await fetch("/api/verify-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
      });

      const data = await res.json();

      if (data.valid) {
        setKeyStatus("valid");
        const supabase = createClient();
        await updateProfile(supabase, user.id, { openrouter_api_key: trimmed });
        onApiKeyChange(trimmed);
      } else {
        setKeyStatus("invalid");
        setKeyError(data.error || "Invalid API key");
      }
    } catch {
      setKeyStatus("invalid");
      setKeyError("Could not verify key. Please try again.");
    }
  };

  const handleSaveName = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) return;

    const supabase = createClient();
    const ok = await updateProfile(supabase, user.id, { display_name: trimmed });
    if (ok) {
      onDisplayNameChange(trimmed);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    }
  };

  const handleRemoveKey = async () => {
    const supabase = createClient();
    await updateProfile(supabase, user.id, { openrouter_api_key: null });
    onApiKeyChange(null);
    setKeyInput("");
    setKeyStatus("idle");
    setKeyError(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-full max-w-md mx-4 bg-[#fffaf2] rounded-2xl border border-[#e5e7eb] shadow-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#e5e7eb]">
          <h2 className="text-lg font-semibold text-[#2d2d2d]">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-[#f3f4f6] transition-colors"
          >
            <svg className="w-5 h-5 text-[#6b7280]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-6 max-h-[70vh] overflow-y-auto">
          {/* Profile section */}
          <div className="flex items-center gap-3">
            {user.user_metadata?.avatar_url ? (
              <Image
                src={user.user_metadata.avatar_url}
                alt="Avatar"
                width={48}
                height={48}
                className="rounded-full"
                unoptimized
              />
            ) : (
              <div className="w-12 h-12 rounded-full bg-[#7c6bf5] flex items-center justify-center text-white text-lg font-bold">
                {(user.user_metadata?.full_name || user.email || "U")[0].toUpperCase()}
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-[#2d2d2d]">
                {user.user_metadata?.full_name || user.email || "User"}
              </p>
              <p className="text-xs text-[#9ca3af]">{user.email}</p>
            </div>
          </div>

          {/* Name field (read-only from Google) */}
          <div>
            <label className="block text-xs font-medium text-[#4b5563] mb-1">
              Name
            </label>
            <input
              type="text"
              value={user.user_metadata?.full_name || user.email || ""}
              readOnly
              className="w-full px-4 py-2.5 rounded-xl border border-[#e5e7eb] bg-[#f9fafb] text-sm text-[#6b7280] cursor-not-allowed"
            />
            <p className="text-[10px] text-[#9ca3af] mt-1">From your Google account</p>
          </div>

          {/* Display Name */}
          <div>
            <label className="block text-xs font-medium text-[#4b5563] mb-1">
              Display Name
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="How should we call you?"
                className="flex-1 px-4 py-2.5 rounded-xl border border-[#e5e7eb] bg-white outline-none focus:ring-2 focus:ring-[#7c6bf5]/30 focus:border-[#7c6bf5] text-sm text-[#2d2d2d] placeholder-[#9ca3af]"
              />
              <button
                onClick={handleSaveName}
                className="px-4 py-2.5 rounded-xl bg-[#2d2d2d] text-white text-sm font-medium hover:bg-[#1f2937] transition-colors"
              >
                {nameSaved ? "Saved!" : "Save"}
              </button>
            </div>
          </div>

          {/* OpenRouter API Key */}
          <div>
            <label className="block text-xs font-medium text-[#4b5563] mb-1">
              OpenRouter API Key
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    if (keyStatus !== "idle") setKeyStatus("idle");
                    setKeyError(null);
                  }}
                  placeholder="sk-or-v1-..."
                  className="w-full px-4 py-2.5 pr-10 rounded-xl border border-[#e5e7eb] bg-white outline-none focus:ring-2 focus:ring-[#7c6bf5]/30 focus:border-[#7c6bf5] text-sm text-[#2d2d2d] placeholder-[#9ca3af]"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9ca3af] hover:text-[#6b7280]"
                >
                  {showKey ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
              <button
                onClick={handleVerifyKey}
                disabled={keyStatus === "verifying" || !keyInput.trim()}
                className="px-4 py-2.5 rounded-xl bg-[#2d2d2d] text-white text-sm font-medium hover:bg-[#1f2937] transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {keyStatus === "verifying" ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Verifying
                  </>
                ) : keyStatus === "valid" ? (
                  <>
                    <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Verified
                  </>
                ) : (
                  "Verify"
                )}
              </button>
            </div>

            {/* Status messages */}
            {keyStatus === "valid" && (
              <p className="text-xs text-green-600 mt-1.5 flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                API key is valid and saved
              </p>
            )}
            {keyStatus === "invalid" && keyError && (
              <p className="text-xs text-red-600 mt-1.5 flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                {keyError}
              </p>
            )}

            {/* Remove key button */}
            {apiKey && (
              <button
                onClick={handleRemoveKey}
                className="text-xs text-red-500 hover:text-red-700 mt-2 hover:underline"
              >
                Remove API key
              </button>
            )}

            <p className="text-[10px] text-[#9ca3af] mt-2">
              Get your API key from{" "}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#7c6bf5] hover:underline"
              >
                openrouter.ai/keys
              </a>
            </p>
          </div>

          {/* Tutorial placeholder */}
          <div className="border border-dashed border-[#e5e7eb] rounded-xl p-4">
            <h3 className="text-sm font-medium text-[#4b5563] mb-1">Tutorial</h3>
            <p className="text-xs text-[#9ca3af]">
              Tutorial coming soon. We&apos;ll walk you through getting your API key and using DeepConverge.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
