"use client";

import { useMemo, useState } from "react";
import type { MarketId, PortfolioSummary } from "@/lib/types";
import { formatCurrency } from "@/lib/formatters";
import { assetTypeLabel, t, type Language } from "@/lib/i18n";

type EditableHolding = PortfolioSummary["holdings"][number];

type HoldingsEditorProps = {
  holdings: EditableHolding[];
  marketId: MarketId;
  totalValue: number;
  language?: Language;
};

type ViewMode = "compact" | "visual";

function targetToPercent(targetWeight: number) {
  return targetWeight <= 1 ? targetWeight * 100 : targetWeight;
}

function toneForGap(gap: number) {
  if (Math.abs(gap) < 1) return "text-zinc-500 dark:text-zinc-400";
  return gap > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400";
}

function actionForGap(gap: number, language: Language) {
  if (Math.abs(gap) < 1) return t(language, "holdingsEditor.hold");
  return gap > 0 ? t(language, "common.add") : t(language, "holdingsEditor.trim");
}

export function HoldingsEditor({ holdings, marketId, totalValue, language = "en" }: HoldingsEditorProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("compact");
  const [status, setStatus] = useState(t(language, "common.ready"));
  const [targets, setTargets] = useState(() =>
    Object.fromEntries(holdings.map((holding) => [holding.id, targetToPercent(holding.targetWeight)]))
  );

  const rows = useMemo(
    () =>
      holdings.map((holding) => {
        const targetWeight = targets[holding.id] ?? targetToPercent(holding.targetWeight);
        const gap = targetWeight - holding.currentWeight;
        const tradeValue = (gap / 100) * totalValue;

        return {
          ...holding,
          targetWeight,
          gap,
          tradeValue,
        };
      }),
    [holdings, targets, totalValue]
  );

  const totalTarget = rows.reduce((sum, row) => sum + row.targetWeight, 0);
  const largestGap = rows.reduce((largest, row) => (Math.abs(row.gap) > Math.abs(largest.gap) ? row : largest), rows[0]);

  function normalizeTargets() {
    if (totalTarget <= 0) return;
    setTargets(Object.fromEntries(rows.map((row) => [row.id, Math.round((row.targetWeight / totalTarget) * 1000) / 10])));
    setStatus(t(language, "holdingsEditor.normalized"));
  }

  async function copyPlan() {
    const payload = {
      marketId,
      totalValue,
      totalTarget: Math.round(totalTarget * 10) / 10,
      trades: rows.map((row) => ({
        assetId: row.assetId,
        symbol: row.symbol,
        action: actionForGap(row.gap, language),
        currentWeight: Math.round(row.currentWeight * 10) / 10,
        targetWeight: Math.round(row.targetWeight * 10) / 10,
        gap: Math.round(row.gap * 10) / 10,
        tradeValue: Math.round(row.tradeValue * 100) / 100,
      })),
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setStatus(t(language, "holdingsEditor.copied"));
    } catch {
      setStatus(t(language, "holdingsEditor.clipboardUnavailable"));
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]">
      <div className="flex flex-col gap-3 border-b border-zinc-100 p-4 dark:border-white/10 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-zinc-950 dark:text-white">{t(language, "holdingsEditor.title")}</div>
          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t(language, "holdingsEditor.summary", { total: totalTarget.toFixed(1), gap: largestGap ? `${largestGap.symbol} ${largestGap.gap >= 0 ? "+" : ""}${largestGap.gap.toFixed(1)}%` : "0.0%" })}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={normalizeTargets} className="h-9 rounded border border-zinc-200 px-3 text-xs font-medium text-zinc-950 hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/10">
            {t(language, "holdingsEditor.normalize")}
          </button>
          <button type="button" onClick={copyPlan} className="h-9 rounded bg-zinc-950 px-3 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200">
            {t(language, "holdingsEditor.copyPlan")}
          </button>
          <div className="inline-flex w-fit rounded-md border border-zinc-200 bg-zinc-50 p-1 dark:border-white/10 dark:bg-white/[0.04]">
            {(["compact", "visual"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`h-8 rounded px-3 text-xs font-medium capitalize transition ${
                  viewMode === mode ? "bg-white text-zinc-950 shadow-sm dark:bg-white dark:text-zinc-950" : "text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
                }`}
              >
                {t(language, `holdingsEditor.${mode}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="border-b border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">{status}</div>

      {viewMode === "compact" ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-3 text-left font-medium">{t(language, "common.asset")}</th>
                <th className="px-4 py-3 text-right font-medium">{t(language, "common.value")}</th>
                <th className="px-4 py-3 text-right font-medium">{t(language, "holdingsEditor.current")}</th>
                <th className="px-4 py-3 text-right font-medium">{t(language, "common.target")}</th>
                <th className="px-4 py-3 text-right font-medium">{t(language, "holdingsEditor.gap")}</th>
                <th className="px-4 py-3 text-right font-medium">{t(language, "holdingsEditor.rebalance")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-white/10">
              {rows.map((row) => (
                <tr key={row.id} className="transition hover:bg-zinc-50 dark:hover:bg-white/[0.04]">
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-950 dark:text-white">{row.name}</div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">{row.symbol} · {assetTypeLabel(language, row.assetType)}</div>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-zinc-950 dark:text-white">{formatCurrency(row.marketValue, marketId)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{row.currentWeight.toFixed(1)}%</td>
                  <td className="px-4 py-3 text-right">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.5"
                      value={row.targetWeight}
                      onChange={(event) => {
                        const nextValue = Number(event.target.value);
                        setTargets((current) => ({ ...current, [row.id]: Number.isFinite(nextValue) ? nextValue : 0 }));
                      }}
                      className="h-9 w-20 rounded border border-zinc-200 bg-white px-2 text-right text-sm tabular-nums text-zinc-950 outline-none focus:border-emerald-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-white"
                    />
                  </td>
                  <td className={`px-4 py-3 text-right font-medium tabular-nums ${toneForGap(row.gap)}`}>
                    {row.gap >= 0 ? "+" : ""}
                    {row.gap.toFixed(1)}%
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="font-medium text-zinc-950 dark:text-white">{actionForGap(row.gap, language)}</div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">{formatCurrency(Math.abs(row.tradeValue), marketId)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-4 p-4">
          {rows.map((row) => {
            const currentWidth = Math.min(Math.max(row.currentWeight, 0), 100);
            const targetWidth = Math.min(Math.max(row.targetWeight, 0), 100);

            return (
              <div key={row.id} className="space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-zinc-950 dark:text-white">{row.name}</div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">{row.symbol}</div>
                  </div>
                  <div className={`shrink-0 text-right text-sm font-medium tabular-nums ${toneForGap(row.gap)}`}>
                    {row.gap >= 0 ? "+" : ""}
                    {row.gap.toFixed(1)}%
                  </div>
                </div>
                <div className="space-y-1.5">
                  <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/10">
                    <div className="h-full rounded-full bg-zinc-950" style={{ width: `${currentWidth}%` }} />
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/10">
                    <div className="h-full rounded-full bg-emerald-500" style={{ width: `${targetWidth}%` }} />
                  </div>
                </div>
                <div className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400">
                  <span>{t(language, "holdingsEditor.current")} {row.currentWeight.toFixed(1)}%</span>
                  <span>{t(language, "common.target")} {row.targetWeight.toFixed(1)}%</span>
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-4 border-t border-zinc-100 pt-4 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            <span className="inline-flex items-center gap-2"><span className="h-2 w-5 rounded-full bg-zinc-950" />{t(language, "holdingsEditor.current")}</span>
            <span className="inline-flex items-center gap-2"><span className="h-2 w-5 rounded-full bg-emerald-500" />{t(language, "common.target")}</span>
          </div>
        </div>
      )}
    </div>
  );
}
