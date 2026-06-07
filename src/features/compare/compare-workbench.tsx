"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart, LineChart } from "../../components/charts";
import { useResolvedLanguage } from "@/hooks/use-language";
import { t, type Language } from "@/lib/i18n";

type CompareTab = "Performance" | "Risk" | "Allocation" | "Holdings";

type CompareCandidate = {
  id: string;
  name: string;
  symbol: string;
  performance: Array<{ date: string; value: number }>;
  holdings: Array<{ name: string; symbol: string; weight: number; sector: string }>;
  allocation: Array<{ name: string; weight: number }>;
  metrics: {
    return: number;
    volatility: number;
    maxDrawdown: number;
    riskScore: number;
    dividendYield: number;
    expenseRatio: number;
  };
};

type CompareWorkbenchProps = {
  candidates: CompareCandidate[];
  initialIds?: string[];
  language?: Language;
};

const tabs: CompareTab[] = ["Performance", "Risk", "Allocation", "Holdings"];
const lineColors = ["#00c805", "#18181b", "#0ea5e9", "#f59e0b"];

function formatPercent(value: number, digits = 1) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function formatPlainPercent(value: number, digits = 1) {
  return `${value.toFixed(digits)}%`;
}

function isBestMetric(metric: keyof CompareCandidate["metrics"], value: number, selected: CompareCandidate[]) {
  const values = selected.map((candidate) => candidate.metrics[metric]);
  const best = metric === "volatility" || metric === "maxDrawdown" || metric === "riskScore" || metric === "expenseRatio"
    ? Math.min(...values)
    : Math.max(...values);

  return Math.abs(value - best) < 0.001;
}

function strongestClass(isStrongest: boolean) {
  return isStrongest
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300"
    : "border-zinc-200 bg-white text-zinc-950 dark:border-white/10 dark:bg-white/[0.03] dark:text-white";
}

function defaultSelectedIds(candidates: CompareCandidate[], initialIds: string[]) {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const validInitialIds = initialIds.filter((id) => candidateIds.has(id)).slice(0, 4);
  return validInitialIds.length ? validInitialIds : candidates.slice(0, Math.min(3, candidates.length)).map((candidate) => candidate.id);
}

export function CompareWorkbench({ candidates, initialIds = [], language: languageProp = "en" }: CompareWorkbenchProps) {
  const language = useResolvedLanguage(languageProp);
  const [activeTab, setActiveTab] = useState<CompareTab>("Performance");
  const initialIdsKey = initialIds.join("|");
  const [selectedIds, setSelectedIds] = useState(() => defaultSelectedIds(candidates, initialIds));

  useEffect(() => {
    setSelectedIds(defaultSelectedIds(candidates, initialIds));
    setActiveTab("Performance");
  }, [candidates, initialIds, initialIdsKey]);

  const selected = useMemo(
    () => candidates.filter((candidate) => selectedIds.includes(candidate.id)).slice(0, 4),
    [candidates, selectedIds]
  );

  function toggleCandidate(id: string) {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((candidateId) => candidateId !== id);
      if (current.length >= 4) return current;
      return [...current, id];
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-semibold text-zinc-950 dark:text-white">{t(language, "compare.compareSet")}</div>
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t(language, "compare.maxObjects", { count: selected.length })}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            {candidates.map((candidate) => {
              const checked = selectedIds.includes(candidate.id);
              const disabled = !checked && selectedIds.length >= 4;

              return (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => toggleCandidate(candidate.id)}
                  disabled={disabled}
                  className={`h-9 rounded border px-3 text-sm font-medium transition ${
                    checked
                      ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                      : disabled
                        ? "border-zinc-200 bg-zinc-50 text-zinc-300 dark:border-white/10 dark:bg-white/[0.02] dark:text-zinc-600"
                        : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-950 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300 dark:hover:border-white/20 dark:hover:text-white"
                  }`}
                >
                  {candidate.symbol}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto border-b border-zinc-200 dark:border-white/10">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`border-b-2 px-3 py-2 text-sm font-medium transition ${
              activeTab === tab ? "border-emerald-500 text-zinc-950 dark:text-white" : "border-transparent text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
            }`}
          >
            {t(language, `compare.${tab.toLowerCase()}`)}
          </button>
        ))}
      </div>

      {selected.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400">{t(language, "compare.selectAtLeastOne")}</div>
      ) : null}

      {selected.length > 0 && activeTab === "Performance" ? (
        <div className="space-y-4">
          <MetricGrid selected={selected} metrics={["return", "dividendYield", "expenseRatio"]} language={language} />
          <div className="grid gap-4 lg:grid-cols-2">
            {selected.map((candidate, index) => (
              <div key={candidate.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div>
                    <div className="font-semibold text-zinc-950 dark:text-white">{candidate.name}</div>
                    <div className="text-sm text-zinc-500 dark:text-zinc-400">{candidate.symbol}</div>
                  </div>
                  <div className={`rounded border px-2 py-1 text-xs font-medium ${strongestClass(isBestMetric("return", candidate.metrics.return, selected))}`}>
                    {formatPercent(candidate.metrics.return)}
                  </div>
                </div>
                <LineChart data={candidate.performance} height={180} color={lineColors[index % lineColors.length]} showTooltip={false} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {selected.length > 0 && activeTab === "Risk" ? (
        <div className="space-y-4">
          <MetricGrid selected={selected} metrics={["riskScore", "volatility", "maxDrawdown"]} language={language} />
          <div className="grid gap-4 md:grid-cols-3">
            <RiskBar title={t(language, "common.riskScore")} metric="riskScore" selected={selected} />
            <RiskBar title={t(language, "compare.volatility")} metric="volatility" selected={selected} />
            <RiskBar title={t(language, "compare.maxDrawdown")} metric="maxDrawdown" selected={selected} />
          </div>
        </div>
      ) : null}

      {selected.length > 0 && activeTab === "Allocation" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {selected.map((candidate) => (
            <div key={candidate.id} className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.03]">
              <div className="mb-4">
                <div className="font-semibold text-zinc-950 dark:text-white">{candidate.name}</div>
                <div className="text-sm text-zinc-500 dark:text-zinc-400">{candidate.symbol}</div>
              </div>
              <div className="space-y-3">
                {candidate.allocation.map((slice) => (
                  <div key={slice.name} className="grid grid-cols-[7rem_1fr_3rem] items-center gap-3 text-sm">
                    <span className="truncate text-zinc-500 dark:text-zinc-400">{slice.name}</span>
                    <div className="h-2 rounded-full bg-zinc-100 dark:bg-white/10">
                      <div className="h-2 rounded-full bg-zinc-950" style={{ width: `${Math.min(slice.weight, 100)}%` }} />
                    </div>
                    <span className="text-right font-medium tabular-nums text-zinc-950 dark:text-white">{slice.weight.toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {selected.length > 0 && activeTab === "Holdings" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {selected.map((candidate) => (
            <div key={candidate.id} className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.03]">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <div className="font-semibold text-zinc-950 dark:text-white">{candidate.name}</div>
                  <div className="text-sm text-zinc-500 dark:text-zinc-400">{candidate.symbol}</div>
                </div>
                <div className="rounded border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                  {t(language, "compare.holdingsCount", { count: candidate.holdings.length })}
                </div>
              </div>
              <div className="divide-y divide-zinc-100 dark:divide-white/10">
                {candidate.holdings.slice(0, 6).map((holding) => (
                  <div key={`${candidate.id}-${holding.symbol}`} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-zinc-950 dark:text-white">{holding.name}</div>
                      <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{holding.symbol} · {holding.sector}</div>
                    </div>
                    <div className="shrink-0 text-sm font-medium tabular-nums text-zinc-950 dark:text-white">{holding.weight.toFixed(1)}%</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MetricGrid({
  selected,
  metrics,
  language,
}: {
  selected: CompareCandidate[];
  metrics: Array<keyof CompareCandidate["metrics"]>;
  language: Language;
}) {
  const labels: Record<keyof CompareCandidate["metrics"], string> = {
    return: t(language, "compare.return"),
    volatility: t(language, "compare.volatility"),
    maxDrawdown: t(language, "compare.maxDrawdown"),
    riskScore: t(language, "common.riskScore"),
    dividendYield: t(language, "compare.dividendYield"),
    expenseRatio: t(language, "compare.expenseRatio"),
  };

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {metrics.map((metric) => (
        <div key={metric} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="mb-3 text-sm font-semibold text-zinc-950 dark:text-white">{labels[metric]}</div>
          <div className="space-y-2">
            {selected.map((candidate) => (
              <div
                key={`${metric}-${candidate.id}`}
                className={`flex items-center justify-between gap-3 rounded border px-3 py-2 text-sm ${strongestClass(isBestMetric(metric, candidate.metrics[metric], selected))}`}
              >
                <span className="truncate">{candidate.symbol}</span>
                <span className="shrink-0 font-semibold tabular-nums">
                  {metric === "return" || metric === "maxDrawdown" ? formatPercent(candidate.metrics[metric]) : formatPlainPercent(candidate.metrics[metric])}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function RiskBar({
  title,
  metric,
  selected,
}: {
  title: string;
  metric: "riskScore" | "volatility" | "maxDrawdown";
  selected: CompareCandidate[];
}) {
  const data = selected.map((candidate) => ({
    label: candidate.symbol,
    value: Math.abs(candidate.metrics[metric]),
  }));

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="mb-4 text-sm font-semibold text-zinc-950 dark:text-white">{title}</div>
      <BarChart data={data} accent="#18181b" />
    </div>
  );
}
