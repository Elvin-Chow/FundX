"use client";

import { Check } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { LANGUAGE_OPTIONS, t, type Language } from "@/lib/i18n";
import type { MarketId } from "@/lib/types";
import { useMarketStore } from "@/stores/market-store";

type LanguageSettingsProps = {
  language: Language;
  marketId: MarketId;
};

export function LanguageSettings({ language, marketId }: LanguageSettingsProps) {
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const [searchParams] = useSearchParams();
  const setLanguage = useMarketStore((state) => state.setLanguage);

  function selectLanguage(nextLanguage: Language) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("market", marketId);
    params.set("lang", nextLanguage);
    setLanguage(nextLanguage);
    navigate(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm shadow-zinc-950/[0.02] dark:border-white/10 dark:bg-white/[0.04]">
      <div className="divide-y divide-zinc-100 dark:divide-white/10">
      {LANGUAGE_OPTIONS.map((option) => {
        const active = option.value === language;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => selectLanguage(option.value)}
            className="flex min-h-[4.25rem] w-full items-center justify-between gap-4 px-4 py-3 text-left transition hover:bg-zinc-50 dark:hover:bg-white/[0.06]"
            aria-pressed={active}
          >
            <div className="min-w-0">
              <div className="truncate text-[15px] font-medium text-zinc-950 dark:text-white">{option.label}</div>
              <div className="mt-1 text-sm text-zinc-500 dark:text-slate-400">
                {option.value === "zh-CN" ? t(language, "language.simplified") : option.value === "zh-TW" ? t(language, "language.traditional") : t(language, "language.english")}
              </div>
            </div>
            {active ? (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                <Check size={16} />
              </span>
            ) : null}
          </button>
        );
      })}
      </div>
    </div>
  );
}
