"use client";

import { FormEvent, useState } from "react";
import type { MarketId } from "@/lib/types";
import { formatCurrency } from "@/lib/formatters";
import { t, type Language } from "@/lib/i18n";
import { saveLocalPortfolioSnapshot } from "@/lib/local-user-data";

type SnapshotPanelProps = {
  marketId: MarketId;
  portfolioId: string;
  totalValue: number;
  language?: Language;
};

export function SnapshotPanel({ marketId, portfolioId, totalValue, language = "en" }: SnapshotPanelProps) {
  const [result, setResult] = useState(t(language, "snapshot.ready"));
  const [pending, setPending] = useState(false);
  const snapshotBody = t(language, "snapshot.body", { value: formatCurrency(totalValue, marketId) });

  async function saveSnapshot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setPending(true);
    try {
      saveLocalPortfolioSnapshot(marketId, portfolioId, String(formData.get("notes") ?? formData.get("name") ?? ""));
      setResult(t(language, "snapshot.ready"));
    } catch (error) {
      setResult(error instanceof Error ? error.message : t(language, "snapshot.ready"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={saveSnapshot} className="border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.03]">
      <input type="hidden" name="market" value={marketId} />
      <input type="hidden" name="portfolioId" value={portfolioId} />
      <input type="hidden" name="totalValue" value={totalValue} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">{t(language, "snapshot.eyebrow")}</div>
          <h3 className="mt-2 text-xl font-semibold tracking-tight text-zinc-950 dark:text-white">{t(language, "snapshot.title")}</h3>
          {snapshotBody ? <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{snapshotBody}</p> : null}
        </div>
        <button disabled={pending} type="submit" className="h-10 rounded bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400">
          {pending ? t(language, "snapshot.saving") : t(language, "snapshot.save")}
        </button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-[14rem_1fr]">
        <label className="block">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t(language, "common.name")}</span>
          <input
            name="name"
            defaultValue={t(language, "snapshot.defaultName")}
            className="mt-1 h-10 w-full rounded border border-zinc-200 bg-white px-3 text-sm text-zinc-950 outline-none focus:border-emerald-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-white"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t(language, "common.note")}</span>
          <input
            name="notes"
            placeholder={t(language, "snapshot.notePlaceholder")}
            className="mt-1 h-10 w-full rounded border border-zinc-200 bg-white px-3 text-sm text-zinc-950 outline-none focus:border-emerald-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-white"
          />
        </label>
      </div>
      <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{result}</p>
    </form>
  );
}
