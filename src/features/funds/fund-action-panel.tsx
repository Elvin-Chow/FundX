"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiErrorMessage, apiGet, apiPost } from "@/lib/api-client";
import type { AssetDetailResponse } from "@/lib/api-contracts";
import { t, type Language } from "@/lib/i18n";
import { upsertLocalWatchlistItem } from "@/lib/local-user-data";
import type { Fund, MarketId } from "@/lib/types";

type FundActionPanelProps = {
  marketId: MarketId;
  fund: Pick<Fund, "id" | "symbol">;
  language?: Language;
};

export function FundActionPanel({ marketId, fund, language = "en" }: FundActionPanelProps) {
  const [result, setResult] = useState(t(language, "common.ready"));
  const [pending, setPending] = useState(false);
  const panelBody = t(language, "fund.panelBody", { symbol: fund.symbol });

  async function addToWatchlist() {
    setPending(true);
    setResult(t(language, "watchlist.adding", { symbol: fund.symbol }));
    try {
      const detail = await apiGet<AssetDetailResponse>(`/api/assets/${fund.id}`, { market: marketId, type: "fund" });
      upsertLocalWatchlistItem(marketId, {
        assetId: fund.id,
        assetType: "fund",
        note: t(language, "asset.addedFrom"),
        target: detail.asset.latestPrice == null ? undefined : Number((detail.asset.latestPrice * 0.95).toFixed(2)),
      }, detail.asset, detail.history);
      setResult(t(language, "fund.watchSaved", { symbol: fund.symbol }));
    } catch (error) {
      setResult(apiErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  async function refreshPublicData() {
    setPending(true);
    setResult(t(language, "fund.refreshing", { symbol: fund.symbol }));
    try {
      await apiPost("/api/jobs", { marketId, type: "sync-nav" }, { market: marketId });
      setResult(t(language, "fund.refreshCompleted"));
    } catch (error) {
      setResult(apiErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">{t(language, "fund.actions")}</div>
      <h3 className="mt-2 text-xl font-semibold tracking-tight text-zinc-950 dark:text-white">{t(language, "fund.panelTitle")}</h3>
      {panelBody ? <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{panelBody}</p> : null}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <button disabled={pending} type="button" onClick={addToWatchlist} className="h-10 w-full rounded bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400">
          {pending ? t(language, "fund.working") : t(language, "fund.addWatchlist")}
        </button>
        <Link
          to={`/dca?market=${marketId}&fund=${fund.id}&lang=${language}`}
          className="flex h-10 items-center justify-center rounded border border-zinc-200 px-4 text-sm font-medium text-zinc-950 transition hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/10 dark:hover:text-white"
        >
          {t(language, "fund.openDca")}
        </Link>
        <button
          type="button"
          disabled={pending}
          onClick={refreshPublicData}
          className="inline-flex h-10 items-center justify-center gap-2 rounded border border-zinc-200 px-4 text-sm font-medium text-zinc-950 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/10 dark:hover:text-white dark:disabled:text-zinc-500 sm:col-span-2"
        >
          <RefreshCw size={16} />
          {t(language, "common.refreshPublicData")}
        </button>
      </div>
      <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{result}</p>
    </div>
  );
}
