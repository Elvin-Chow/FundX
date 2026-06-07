"use client";

import { useState } from "react";
import { getMarketCopy, t, type Language } from "@/lib/i18n";
import { normalizeMarket, type Market, type MarketCode } from "./types";

type MarketSwitcherProps = {
  market: Market;
  language?: Language;
  onMarketChange?: (market: Market) => void;
};

const marketMeta: Record<MarketCode, { label: string; currency: string; hint: string }> = {
  us: { label: "US Market", currency: "USD", hint: "ETFs, index funds, US stocks" },
};

export function MarketSwitcher({ market, language = "en", onMarketChange }: MarketSwitcherProps) {
  const [selected, setSelected] = useState<MarketCode>(normalizeMarket(market));

  function selectMarket(nextMarket: MarketCode) {
    setSelected(nextMarket);
    onMarketChange?.(nextMarket);
  }

  return (
    <div className="inline-flex items-center rounded-full border border-zinc-200 bg-white p-1 shadow-sm shadow-zinc-950/[0.03] dark:border-white/10 dark:bg-white/[0.04] dark:shadow-black/20">
      {(Object.keys(marketMeta) as MarketCode[]).map((item) => {
        const isActive = selected === item;

        return (
          <button
            key={item}
            type="button"
            aria-pressed={isActive}
            onClick={() => selectMarket(item)}
            className={[
              "group relative min-w-24 rounded-full px-3 py-2 text-left text-xs transition",
              isActive
                ? "bg-zinc-950 text-white shadow-sm dark:bg-white dark:text-zinc-950"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white",
            ].join(" ")}
          >
            <span className="block font-medium leading-none">{getMarketCopy(language, item).name}</span>
            <span className={isActive ? "mt-1 block text-[10px] text-zinc-300 dark:text-zinc-600" : "mt-1 block text-[10px] text-zinc-400"}>
              {marketMeta[item].currency}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function MarketSummary({ market, language = "en" }: { market: Market; language?: Language }) {
  const meta = marketMeta[normalizeMarket(market)];
  const copy = getMarketCopy(language, normalizeMarket(market));

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{t(language, "settings.defaultMarket")}</div>
      <div className="mt-1 flex items-end justify-between gap-3">
        <div>
          <div className="text-lg font-semibold text-zinc-950 dark:text-white">{copy.name}</div>
          <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{copy.hint}</div>
        </div>
        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
          {meta.currency}
        </span>
      </div>
    </div>
  );
}
