"use client";

import { useNavigate, useSearchParams } from "react-router-dom";
import { MARKET_CONFIGS } from "@/lib/constants";
import { LANGUAGE_OPTIONS, getMarketCopy, t, type Language } from "@/lib/i18n";
import { useMarketStore } from "@/stores/market-store";

export function MarketSelectPage({ language = "en" }: { language?: Language }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setLanguage = useMarketStore((state) => state.setLanguage);
  const selectBody = t(language, "market.selectBody");
  const markets = Object.values(MARKET_CONFIGS).map((market) => ({
    id: market.id,
    code: "US",
    name: getMarketCopy(language, market.id).name,
    currency: `${market.currency} ${market.currencySymbol}`,
    description: getMarketCopy(language, market.id).style,
    benchmarks: market.benchmarks,
    href: `/home?market=${market.id}&lang=${language}`,
  }));

  function selectLanguage(nextLanguage: Language) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("lang", nextLanguage);
    setLanguage(nextLanguage);
    navigate(`/?${params.toString()}`);
  }

  return (
    <main className="flex min-h-screen flex-col bg-white px-4 py-10 text-zinc-950 dark:bg-[#050706] dark:text-white sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full flex-1 max-w-6xl flex-col justify-center">
        <div className="mb-10 flex flex-wrap gap-2">
          {LANGUAGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => selectLanguage(option.value)}
              className={[
                "h-9 rounded border px-3 text-sm font-medium transition",
                option.value === language
                  ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                  : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/10 dark:hover:text-white",
              ].join(" ")}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="max-w-2xl">
          <div className="text-sm font-medium uppercase tracking-wide text-emerald-600">FundX</div>
          <h1 className="mt-4 text-5xl font-semibold tracking-tight sm:text-6xl">{t(language, "market.selectTitle")}</h1>
          {selectBody ? <p className="mt-5 text-lg leading-8 text-zinc-500 dark:text-zinc-400">{selectBody}</p> : null}
        </div>
        <div className="mt-12 grid gap-4">
          {markets.map((market) => (
            <a
              key={market.id}
              href={market.href}
              className="group rounded-lg border border-zinc-200 bg-white p-7 transition hover:-translate-y-1 hover:border-emerald-300 hover:shadow-2xl hover:shadow-emerald-950/10 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-emerald-400/40 dark:hover:shadow-black/30"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-3xl font-semibold tracking-tight">{market.name}</div>
                  <div className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{market.currency}</div>
                </div>
                <span className="rounded-full bg-zinc-950 px-3 py-1 text-sm font-medium text-white dark:bg-white dark:text-zinc-950">{market.code}</span>
              </div>
              {market.description ? <p className="mt-8 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{market.description}</p> : null}
              <div className="mt-8 flex flex-wrap gap-2">
                {market.benchmarks.map((benchmark: string) => (
                  <span key={benchmark} className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
                    {benchmark}
                  </span>
                ))}
              </div>
            </a>
          ))}
        </div>
      </div>
      <footer className="mx-auto w-full max-w-6xl border-t border-zinc-200 pt-4 text-center text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
        {t(language, "app.footerDeveloper")}
      </footer>
    </main>
  );
}
