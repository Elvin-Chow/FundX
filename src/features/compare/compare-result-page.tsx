"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useCalculationRun } from "@/hooks/use-calculation-run";
import { assetDisplayName, assetKindLabel, assetPrimaryCategory, quoteStatusLabel } from "@/lib/asset-display";
import { formatNumber, formatOptionalPercent, formatPercent } from "@/lib/formatters";
import { t, type Language } from "@/lib/i18n";
import { readReturnToState } from "@/lib/navigation-state";
import type { MarketId, Metric } from "@/lib/types";
import { LoadingRows, Section, StatusBanner, ToneText } from "../shared/feature-shell";
import { SecondaryButton } from "../shared/calculation-workbench";
import { CompareWorkbench } from "./compare-workbench";
import {
  readCompareResultCache,
  writeCompareResultCache,
  type CompareResultCache,
  type FundCompareItem,
  type FundCompareResult,
} from "./compare-result-store";

const MAX_COMPARE_FUNDS = 4;

export function CompareResultPage({
  marketId,
  initialIds = [],
  language = "en",
}: {
  marketId: MarketId;
  initialIds?: string[];
  language?: Language;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const calculation = useCalculationRun<FundCompareResult>(marketId);
  const resetCalculation = calculation.reset;
  const runCalculation = calculation.run;
  const initialIdsKey = initialIds.slice(0, MAX_COMPARE_FUNDS).join("|");
  const requestedIds = useMemo(() => (initialIdsKey ? initialIdsKey.split("|") : []), [initialIdsKey]);
  const [cache, setCache] = useState<CompareResultCache | null>(() => matchingCache(readCompareResultCache(marketId), requestedIds));
  const attemptedKey = useRef("");

  useEffect(() => {
    attemptedKey.current = "";
    setCache(matchingCache(readCompareResultCache(marketId), requestedIds));
    resetCalculation();
  }, [initialIdsKey, marketId, requestedIds, resetCalculation]);

  useEffect(() => {
    if (cache || !requestedIds.length || attemptedKey.current === initialIdsKey) return;
    attemptedKey.current = initialIdsKey;
    let cancelled = false;

    void (async () => {
      const response = await runCalculation({
        workflow: "compare",
        assets: requestedIds.map((assetId) => ({ assetId, assetType: "fund" })),
        params: {},
        refresh: true,
      });
      if (cancelled || !response?.result) return;
      const nextCache: CompareResultCache = {
        marketId,
        language,
        selectedIds: requestedIds,
        selectedAssets: response.result.items.map((item) => item.asset),
        result: response.result,
        savedAt: new Date().toISOString(),
      };
      writeCompareResultCache(nextCache);
      setCache(nextCache);
    })();

    return () => {
      cancelled = true;
    };
  }, [cache, initialIdsKey, language, marketId, requestedIds, runCalculation]);

  const result = cache?.result ?? calculation.result;
  const items = useMemo(() => result?.items ?? [], [result?.items]);
  const resultIds = requestedIds.length ? requestedIds : items.map((item) => item.asset.id);
  const resultIdsParam = resultIds.join(",");
  const metrics = useMemo(() => buildOverviewMetrics(items, language), [items, language]);
  const candidates = useMemo(
    () =>
      items.map((item) => ({
        id: item.asset.id,
        name: assetDisplayName(item.asset, language),
        symbol: item.asset.symbol,
        performance: item.history ?? [],
        holdings: item.holdings ?? [],
        allocation: item.allocation ?? [],
        metrics: item.metrics,
      })),
    [items, language],
  );
  const backHref = readReturnToState(location.state, `/compare?market=${marketId}${resultIdsParam ? `&ids=${resultIdsParam}` : ""}&lang=${language}`);

  function backToCompare() {
    navigate(backHref);
  }

  return (
    <div className="space-y-5">
      <div className="border-b border-zinc-200 pb-6 dark:border-white/10">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <SecondaryButton onClick={backToCompare}>
            <span className="inline-flex items-center gap-2"><ArrowLeft size={16} /> {t(language, "dca.back")}</span>
          </SecondaryButton>
          {requestedIds.length ? (
            <button
              type="button"
              disabled={calculation.running}
              onClick={() => {
                setCache(null);
                attemptedKey.current = "";
              }}
              className="inline-flex h-10 items-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
            >
              <RefreshCw size={16} />
              {t(language, "common.reload")}
            </button>
          ) : null}
        </div>
        <div className="max-w-3xl">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">{t(language, "nav.compare")}</div>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white sm:text-4xl">{t(language, "compare.resultTitle")}</h1>
          <p className="mt-3 text-sm leading-6 text-zinc-500 dark:text-zinc-400 sm:text-base">
            {items.length ? t(language, "compare.resultSubtitle") : t(language, "compare.noCachedResult")}
          </p>
        </div>
      </div>

      {calculation.running ? <LoadingRows rows={4} /> : null}
      {calculation.error ? <StatusBanner title={calculation.error} tone="negative" /> : null}

      {!calculation.running && !items.length ? (
        <StatusBanner
          title={t(language, "compare.resultUnavailableTitle")}
          body={t(language, "compare.resultUnavailableBody")}
          action={<SecondaryButton onClick={backToCompare}>{t(language, "compare.returnToCompare")}</SecondaryButton>}
        />
      ) : null}

      {items.length ? (
        <>
          <ResultMetricGrid metrics={metrics} />
          <Section title={t(language, "compare.fundComparison")} subtitle={t(language, "compare.fundComparisonSubtitle")}>
            <FundComparisonTable items={items} language={language} />
          </Section>
          <CompareWorkbench candidates={candidates} initialIds={resultIds} language={language} />
        </>
      ) : null}
    </div>
  );
}

function buildOverviewMetrics(items: FundCompareItem[], language: Language): Metric[] {
  if (!items.length) return [];
  const bestReturn = Math.max(...items.map((item) => item.metrics.return));
  const averageDividend = average(items.map((item) => item.metrics.dividendYield));
  const averageExpense = average(items.map((item) => item.metrics.expenseRatio));
  const averageRisk = average(items.map((item) => item.metrics.riskScore));
  const averageDailyChange = average(items.map((item) => item.asset.dailyChange).filter((value): value is number => value != null));

  return [
    { label: t(language, "compare.selectedFunds"), value: formatNumber(items.length) },
    { label: t(language, "compare.bestReturn"), value: formatPercent(bestReturn), tone: bestReturn >= 0 ? "positive" : "negative" },
    { label: t(language, "compare.averageDailyChange"), value: formatOptionalPercent(averageDailyChange), tone: averageDailyChange >= 0 ? "positive" : "negative" },
    { label: t(language, "compare.averageDividend"), value: formatPlainPercent(averageDividend) },
    { label: t(language, "compare.averageExpense"), value: formatPlainPercent(averageExpense) },
    { label: t(language, "compare.averageRisk"), value: formatNumber(averageRisk, 1) },
  ];
}

function ResultMetricGrid({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="grid h-full gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {metrics.map((metric) => (
        <div key={metric.label} className="flex min-h-24 min-w-0 flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white p-3 text-center dark:border-white/10 dark:bg-white/[0.03]">
          <div className="truncate text-sm text-zinc-500 dark:text-zinc-400">{metric.label}</div>
          <div className="mt-2 max-w-full truncate text-xl font-semibold tracking-tight text-zinc-950 dark:text-white">{metric.value}</div>
          {metric.delta ? <ToneText tone={metric.tone} marketTone>{metric.delta}</ToneText> : null}
        </div>
      ))}
    </div>
  );
}

function FundComparisonTable({ items, language }: { items: FundCompareItem[]; language: Language }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]">
      <div className="max-h-[34rem] overflow-auto">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="sticky top-0 z-10 bg-zinc-50 text-xs uppercase text-zinc-500 shadow-[0_1px_0_rgba(228,228,231,1)] dark:bg-zinc-950 dark:text-zinc-400 dark:shadow-[0_1px_0_rgba(255,255,255,0.1)]">
            <tr>
              <th className="px-4 py-3 text-left">{t(language, "common.name")}</th>
              <th className="px-4 py-3 text-left">{t(language, "compare.profile")}</th>
              <th className="px-4 py-3 text-right">{t(language, "compare.dailyChange")}</th>
              <th className="px-4 py-3 text-right">{t(language, "compare.return")}</th>
              <th className="px-4 py-3 text-right">{t(language, "compare.dividendYield")}</th>
              <th className="px-4 py-3 text-right">{t(language, "compare.expenseRatio")}</th>
              <th className="px-4 py-3 text-right">{t(language, "compare.maxDrawdown")}</th>
              <th className="px-4 py-3 text-right">{t(language, "compare.volatility")}</th>
              <th className="px-4 py-3 text-right">{t(language, "common.riskScore")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-white/10">
            {items.map((item) => (
              <tr key={item.asset.id} className="align-top">
                <td className="px-4 py-3">
                  <div className="font-semibold text-zinc-950 dark:text-white">{assetDisplayName(item.asset, language)}</div>
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{item.asset.symbol}</div>
                </td>
                <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                  <div>{[assetKindLabel(item.asset, language), assetPrimaryCategory(item.asset, language)].filter(Boolean).join(" · ")}</div>
                  <div className="mt-1 text-xs">{quoteStatusLabel(item.asset, language)}</div>
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">{formatOptionalPercent(item.asset.dailyChange)}</td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">{formatPercent(item.metrics.return)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatPlainPercent(item.metrics.dividendYield)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatPlainPercent(item.metrics.expenseRatio)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatPercent(item.metrics.maxDrawdown)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatPlainPercent(item.metrics.volatility)}</td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">{formatNumber(item.metrics.riskScore, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function matchingCache(cache: CompareResultCache | null, requestedIds: string[]) {
  if (!cache) return null;
  if (!requestedIds.length) return cache;
  return sameIds(cache.selectedIds, requestedIds) ? cache : null;
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function average(values: number[]) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return 0;
  return valid.reduce((total, value) => total + value, 0) / valid.length;
}

function formatPlainPercent(value: number, digits = 1) {
  return `${value.toFixed(digits)}%`;
}
