"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, BarChart3, ChevronDown, ChevronRight, Database, Layers, PieChart, ShieldCheck, TrendingUp, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { localizedAssetSector } from "@/lib/asset-display";
import { formatNumber, formatOptionalCurrency, formatOptionalPercent } from "@/lib/formatters";
import { t, type Language } from "@/lib/i18n";
import { readReturnToState } from "@/lib/navigation-state";
import type { MarketId } from "@/lib/types";
import { Section, StatusBanner } from "../shared/feature-shell";
import { SecondaryButton, WorkbenchPanel } from "../shared/calculation-workbench";
import { readInsightsResultCache, type InsightStrategy, type InsightsResultCache } from "./insights-result-store";

export function InsightsResultPage({ marketId, language = "en" }: { marketId: MarketId; language?: Language }) {
  const location = useLocation();
  const navigate = useNavigate();
  const result = useMemo(() => readInsightsResultCache(marketId), [marketId]);
  const [openStrategyId, setOpenStrategyId] = useState<string | null>(null);
  const backHref = readReturnToState(location.state, `/insights?market=${marketId}&lang=${language}`);

  function returnToInsights() {
    navigate(backHref);
  }

  useEffect(() => {
    window.scrollTo({ left: 0, top: 0 });
  }, []);

  if (!result) {
    return (
      <div className="space-y-5">
        <ResultHeader title={t(language, "insights.results")} language={language} backHref={backHref} />
        <StatusBanner
          title={t(language, "portfolio.noResultTitle")}
          body={t(language, "insights.noResultBody")}
          action={<SecondaryButton onClick={returnToInsights}>{t(language, "nav.insights")}</SecondaryButton>}
        />
      </div>
    );
  }

  const summary = result.result.simulationSummary;
  const strategies = result.result.strategies ?? [];
  const topStrategy = strategies[0];
  const openStrategy = strategies.find((strategy) => strategy.id === openStrategyId) ?? null;
  const recommendedHoldingCount = topStrategy?.recommendedHoldings.length ?? summary.holdingsCount;

  return (
    <div className="space-y-5">
      <ResultHeader
        title={result.result.savedRecommendation?.title || t(language, "insights.results")}
        language={language}
        savedAt={result.savedAt}
        backHref={backHref}
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryMetric icon={<Database size={17} />} label={t(language, "insights.databaseAssets")} value={formatNumber(summary.universeCount)} detail={`${formatNumber(summary.candidatePoolSize)} ${t(language, "insights.shortlistedAssets")}`} />
        <SummaryMetric icon={<BarChart3 size={17} />} label={t(language, "insights.simulationCount")} value={formatNumber(summary.completedSimulations)} detail={`${formatNumber(recommendedHoldingCount)} ${t(language, "insights.holdings")}`} />
        <SummaryMetric icon={<ShieldCheck size={17} />} label={t(language, "insights.riskProfile")} value={t(language, `insights.profile.${summary.riskProfile}`)} detail={`${formatPlainPercent(summary.maxPosition)} ${t(language, "insights.maxPosition")}`} />
        <SummaryMetric icon={<Layers size={17} />} label={t(language, "insights.historyBacked")} value={formatNumber(summary.historyBackedAssets)} detail={`${formatPlainPercent(summary.percentiles?.historyCoverage?.p50)} ${t(language, "insights.historyWeight")}`} />
      </div>

      {topStrategy ? (
        <WorkbenchPanel title={planName(topStrategy, language)} subtitle={planSummary(topStrategy, result, language)}>
          <StrategyBody strategy={topStrategy} cache={result} language={language} marketId={marketId} emphasis />
        </WorkbenchPanel>
      ) : null}

      {strategies.length > 1 ? (
        <Section title={t(language, "insights.otherPlans")}>
          <div className="grid gap-4 lg:grid-cols-2">
            {strategies.slice(1).map((strategy) => (
              <StrategySnapshotCard
                key={strategy.id}
                strategy={strategy}
                cache={result}
                language={language}
                onOpen={() => setOpenStrategyId(strategy.id)}
              />
            ))}
          </div>
        </Section>
      ) : null}

      <MethodologyDisclosure cache={result} language={language} />

      {openStrategy ? (
        <StrategyDetailModal
          strategy={openStrategy}
          cache={result}
          language={language}
          marketId={marketId}
          onClose={() => setOpenStrategyId(null)}
        />
      ) : null}
    </div>
  );
}

function ResultHeader({ title, language, savedAt, backHref }: { title: string; language: Language; savedAt?: string; backHref: string }) {
  const navigate = useNavigate();
  return (
    <div className="border-b border-zinc-200 pb-5 dark:border-white/10">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <SecondaryButton onClick={() => navigate(backHref)}>
          <span className="inline-flex items-center gap-2"><ArrowLeft size={16} /> {t(language, "dca.back")}</span>
        </SecondaryButton>
        {savedAt ? <div className="text-sm text-zinc-500 dark:text-zinc-400">{formatDateTime(savedAt)}</div> : null}
      </div>
      <div className="max-w-3xl">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">{t(language, "nav.insights")}</div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white sm:text-4xl">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-500 dark:text-zinc-400 sm:text-base">{t(language, "insights.resultSubtitle")}</p>
      </div>
    </div>
  );
}

function SummaryMetric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        <span className="text-emerald-600">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 truncate text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">{value}</div>
      <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{detail}</div>
    </div>
  );
}

function StrategySnapshotCard({
  strategy,
  cache,
  language,
  onOpen,
}: {
  strategy: InsightStrategy;
  cache: InsightsResultCache;
  language: Language;
  onOpen: () => void;
}) {
  const metrics = strategy.metrics ?? {};
  const topHoldings = (strategy.recommendedHoldings ?? []).slice(0, 3);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full min-h-64 w-full flex-col rounded-lg border border-zinc-200 bg-white p-4 text-left transition hover:border-emerald-300 hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-emerald-400/40 dark:hover:bg-white/[0.06]"
      aria-label={`${t(language, "insights.viewPlanDetails")} ${planName(strategy, language)}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold tracking-tight text-zinc-950 dark:text-white">{planName(strategy, language)}</h3>
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{planSummary(strategy, cache, language)}</p>
        </div>
        <span className="shrink-0 rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
          {formatPlainPercent(strategy.confidence)}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <SnapshotMetric label={t(language, "insights.expectedReturn")} value={formatSignedPercent(metrics.expectedReturn)} />
        <SnapshotMetric label={t(language, "insights.volatility")} value={formatPlainPercent(metrics.volatility)} />
        <SnapshotMetric label={t(language, "insights.maxDrawdown")} value={formatPlainPercent(metrics.maxDrawdown)} />
        <SnapshotMetric label={t(language, "insights.topHolding")} value={formatPlainPercent(metrics.topWeight)} />
      </div>

      <div className="mt-4 min-w-0 flex-1">
        <div className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">{t(language, "insights.topHoldings")}</div>
        <div className="flex flex-wrap gap-2">
          {topHoldings.map((holding) => (
            <span key={`${strategy.id}-snapshot-${holding.asset.id}`} className="max-w-full truncate rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
              {holding.asset.symbol} {formatPlainPercent(holding.weight)}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-zinc-100 pt-3 text-sm font-medium text-emerald-700 dark:border-white/10 dark:text-emerald-300">
        <span>{t(language, "insights.viewPlanDetails")}</span>
        <ChevronRight size={17} className="transition group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}

function SnapshotMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border border-zinc-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="truncate text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-zinc-950 dark:text-white">{value}</div>
    </div>
  );
}

function StrategyDetailModal({
  strategy,
  cache,
  language,
  marketId,
  onClose,
}: {
  strategy: InsightStrategy;
  cache: InsightsResultCache;
  language: Language;
  marketId: MarketId;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 px-4 py-8 dark:bg-black/60" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label={t(language, "insights.closePlanDetails")} />
      <div className="relative flex max-h-[84vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-white/10 dark:bg-[#080d0c] dark:shadow-black/40">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-100 px-4 py-3 dark:border-white/10">
          <div className="min-w-0">
            <h3 className="text-base font-semibold tracking-tight text-zinc-950 dark:text-white">{planName(strategy, language)}</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{planSummary(strategy, cache, language)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t(language, "insights.closePlanDetails")}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-zinc-200 text-zinc-500 transition hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4">
          <StrategyBody strategy={strategy} cache={cache} language={language} marketId={marketId} emphasis />
        </div>
      </div>
    </div>
  );
}

function MethodologyDisclosure({ cache, language }: { cache: InsightsResultCache; language: Language }) {
  return (
    <details className="group rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-950 dark:text-white">{t(language, "insights.methodology")}</h2>
        <ChevronDown size={18} className="shrink-0 text-zinc-400 transition group-open:rotate-180" />
      </summary>
      <div className="grid gap-3 border-t border-zinc-100 p-4 dark:border-white/10 md:grid-cols-2">
        {methodologyItems(cache, language).map((item) => (
          <div key={item} className="rounded-lg border border-zinc-200 bg-zinc-50/70 p-4 text-sm leading-6 text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300">{item}</div>
        ))}
      </div>
    </details>
  );
}

function StrategyBody({
  strategy,
  cache,
  language,
  marketId,
  emphasis = false,
}: {
  strategy: InsightStrategy;
  cache: InsightsResultCache;
  language: Language;
  marketId: MarketId;
  emphasis?: boolean;
}) {
  const metrics = strategy.metrics ?? {};
  const holdings = strategy.recommendedHoldings ?? [];
  const reasons = planReasons(strategy, cache, language);
  const gridClass = emphasis ? "grid items-start gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]" : "grid items-start gap-4";
  const tableGridClass = "grid grid-cols-[minmax(0,1fr)_minmax(5.5rem,7rem)_minmax(5.5rem,6.5rem)] gap-3";

  return (
    <div className="h-full">
      <div className={gridClass}>
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              {!emphasis ? <h3 className="text-lg font-semibold tracking-tight text-zinc-950 dark:text-white">{planName(strategy, language)}</h3> : null}
              {!emphasis ? <div className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{planSummary(strategy, cache, language)}</div> : null}
            </div>
            <span className="shrink-0 rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
              {t(language, "insights.confidence")} {formatPlainPercent(strategy.confidence)}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniMetric label={t(language, "insights.expectedReturn")} value={formatSignedPercent(metrics.expectedReturn)} />
            <MiniMetric label={t(language, "insights.volatility")} value={formatPlainPercent(metrics.volatility)} />
            <MiniMetric label={t(language, "insights.maxDrawdown")} value={formatPlainPercent(metrics.maxDrawdown)} />
            <MiniMetric label={t(language, "insights.dividendYield")} value={formatPlainPercent(metrics.dividendYield)} />
          </div>
          <div className="mt-4 overflow-hidden rounded-lg border border-zinc-200 dark:border-white/10">
            <div className={`${tableGridClass} border-b border-zinc-100 bg-zinc-50 px-3 py-2 text-xs font-medium text-zinc-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400`}>
              <span>{t(language, "common.asset")}</span>
              <span>{t(language, "common.targetWeight")}</span>
              <span className="text-right">{t(language, "common.risk")}</span>
            </div>
            <div>
              {holdings.map((holding) => (
                <div key={`${strategy.id}-${holding.asset.id}`} className={`${tableGridClass} border-b border-zinc-100 px-3 py-2 last:border-b-0 dark:border-white/10`}>
                  <div className="min-w-0">
                    <div className="break-words text-sm font-semibold text-zinc-950 dark:text-white">{holding.asset.symbol}</div>
                    <div className="mt-0.5 break-words text-xs leading-5 text-zinc-500 dark:text-zinc-400">{holding.asset.name}</div>
                    <div className="mt-0.5 break-words text-xs leading-5 text-zinc-500 dark:text-zinc-400">{holdingRole(holding.asset.kind, language)} · {localizedAssetSector(holding.asset.sector, language)}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-zinc-950 dark:text-white">{formatPlainPercent(holding.weight)}</div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/10">
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, Math.max(0, holding.weight))}%` }} />
                    </div>
                  </div>
                  <div className="min-w-0 text-right text-xs text-zinc-500 dark:text-zinc-400">
                    <div>{formatPlainPercent(holding.asset.volatility)}</div>
                    <div>{formatOptionalCurrency(holding.asset.latestPrice, marketId)}</div>
                    <div>{formatOptionalPercent(holding.asset.dailyChange)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <StrategyAnalysisRail
          reasons={reasons}
          holdings={holdings}
          language={language}
        />
      </div>
    </div>
  );
}

function StrategyAnalysisRail({
  reasons,
  holdings,
  language,
}: {
  reasons: string[];
  holdings: InsightStrategy["recommendedHoldings"];
  language: Language;
}) {
  const holdingSegments = allocationSegments(holdings.slice(0, 8).map((holding) => ({ name: holding.asset.symbol, weight: holding.weight })), holdings.slice(8).reduce((total, holding) => total + holding.weight, 0), t(language, "common.other"));

  return (
    <div className="min-w-0 space-y-3">
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-white/10 dark:bg-white/[0.04]">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-white">
          <TrendingUp size={16} className="text-emerald-600" />
          {t(language, "insights.whyThisPlan")}
        </div>
        <div className="mt-3 space-y-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
          {reasons.slice(0, 5).map((item) => <p key={item}>{item}</p>)}
        </div>
      </div>

      <AllocationDonut title={t(language, "insights.assetAllocation")} segments={holdingSegments} />

      <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-zinc-950 dark:text-white">{t(language, "insights.topHoldings")}</div>
          <span className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-500 dark:bg-white/10 dark:text-zinc-300">{formatNumber(holdings.length)}</span>
        </div>
        <div className="grid gap-2">
          {holdings.slice(0, 8).map((holding) => (
            <div key={`compact-${holding.asset.id}`} className="grid grid-cols-[minmax(0,1fr)_3.75rem] items-center gap-3 rounded border border-zinc-100 bg-zinc-50/70 px-2.5 py-2 dark:border-white/10 dark:bg-white/[0.04]">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{holding.asset.symbol}</span>
                  <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{localizedAssetSector(holding.asset.sector, language)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white dark:bg-white/10">
                  <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, Math.max(0, holding.weight))}%` }} />
                </div>
              </div>
              <div className="text-right text-sm font-semibold text-zinc-950 dark:text-white">{formatPlainPercent(holding.weight)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const allocationColors = ["#10b981", "#0f172a", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#64748b", "#d4d4d8"];

function AllocationDonut({ title, segments }: { title: string; segments: Array<{ name: string; weight: number }> }) {
  const largest = segments[0];
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-white">
        <PieChart size={16} className="text-emerald-600" />
        {title}
      </div>
      <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
        <div className="relative h-36 w-36">
          <div className="h-full w-full rounded-full" style={{ background: `conic-gradient(${allocationGradient(segments)})` }} />
          <div className="absolute inset-5 flex flex-col items-center justify-center rounded-full bg-white text-center dark:bg-[#080d0c]">
            <div className="max-w-20 truncate text-sm font-semibold text-zinc-950 dark:text-white">{largest?.name ?? "-"}</div>
            <div className="mt-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">{formatPlainPercent(largest?.weight)}</div>
          </div>
        </div>
        <div className="grid min-w-0 gap-2">
          {segments.slice(0, 6).map((segment, index) => (
            <div key={`${segment.name}-${index}`} className="flex min-w-0 items-center justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: allocationColors[index % allocationColors.length] }} />
                <span className="truncate text-zinc-600 dark:text-zinc-300">{segment.name}</span>
              </span>
              <span className="font-semibold text-zinc-950 dark:text-white">{formatPlainPercent(segment.weight)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function allocationSegments(segments: Array<{ name: string; weight: number }>, otherWeight: number, otherLabel: string) {
  const normalized = segments.filter((segment) => segment.weight > 0).map((segment) => ({ ...segment, weight: roundDisplay(segment.weight) }));
  if (otherWeight > 0.05) normalized.push({ name: otherLabel, weight: roundDisplay(otherWeight) });
  return normalized;
}

function roundDisplay(value: number) {
  return Math.round(value * 10) / 10;
}

function allocationGradient(segments: Array<{ name: string; weight: number }>) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.weight), 0);
  if (total <= 0) return "#e4e4e7 0% 100%";
  let cursor = 0;
  return segments.map((segment, index) => {
    const start = cursor;
    const width = Math.max(0, segment.weight) / total * 100;
    cursor += width;
    return `${allocationColors[index % allocationColors.length]} ${start}% ${cursor}%`;
  }).join(", ");
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border border-zinc-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="text-xs font-medium leading-5 text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 break-words text-sm font-semibold text-zinc-950 dark:text-white">{value}</div>
    </div>
  );
}

function planName(strategy: InsightStrategy, language: Language) {
  const key = `insights.plan.${strategy.objective}`;
  const translated = t(language, key);
  return translated === key ? strategy.name : translated;
}

function planSummary(strategy: InsightStrategy, cache: InsightsResultCache, language: Language) {
  const metrics = strategy.metrics ?? {};
  return t(language, "insights.planSummary", {
    holdings: formatNumber(metrics.holdingCount ?? strategy.recommendedHoldings.length),
    simulations: formatNumber(cache.result.simulationSummary.completedSimulations),
    returnValue: formatSignedPercent(metrics.expectedReturn),
    volatility: formatPlainPercent(metrics.volatility),
    topHolding: formatPlainPercent(metrics.topWeight),
    topSector: formatPlainPercent(metrics.topSectorWeight),
  });
}

function planReasons(strategy: InsightStrategy, cache: InsightsResultCache, language: Language) {
  const metrics = strategy.metrics ?? {};
  const summary = cache.result.simulationSummary;
  const topSector = metrics.sectorExposure?.[0];
  const topAssets = (strategy.recommendedHoldings ?? []).slice(0, 3).map((holding) => holding.asset.symbol).filter(Boolean).join(", ");
  return [
    t(language, `insights.planReason.objective.${strategy.objective}`),
    t(language, "insights.planReason.universe", {
      universe: formatNumber(summary.universeCount),
      shortlist: formatNumber(summary.candidatePoolSize),
    }),
    t(language, "insights.planReason.holdingPolicy", {
      holdings: formatNumber(metrics.holdingCount ?? strategy.recommendedHoldings.length),
      maxPosition: formatPlainPercent(summary.maxPosition),
      sectors: formatNumber(summary.allocationPolicy?.sectorCount ?? metrics.sectorCount ?? 0),
    }),
    t(language, "insights.planReason.metrics", {
      returnValue: formatSignedPercent(metrics.expectedReturn),
      volatility: formatPlainPercent(metrics.volatility),
      drawdown: formatPlainPercent(metrics.maxDrawdown),
    }),
    t(language, "insights.planReason.risk", {
      topHolding: formatPlainPercent(metrics.topWeight),
      topSector: formatPlainPercent(metrics.topSectorWeight),
    }),
    topAssets ? t(language, "insights.planReason.assets", { assets: topAssets }) : "",
    t(language, "insights.planReason.coverage", {
      historyWeight: formatPlainPercent(metrics.historyCoverage),
    }),
    topSector ? t(language, "insights.planReason.sector", {
      sector: localizedAssetSector(topSector.name, language),
      weight: formatPlainPercent(topSector.weight),
    }) : "",
  ].filter(Boolean);
}

function methodologyItems(cache: InsightsResultCache, language: Language) {
  const summary = cache.result.simulationSummary;
  return [
    t(language, "insights.methodology.assets", { count: formatNumber(summary.universeCount) }),
    t(language, "insights.methodology.simulation", { count: formatNumber(summary.completedSimulations) }),
    t(language, "insights.methodology.allocation", {
      holdings: formatNumber(summary.holdingsCount),
      maxPosition: formatPlainPercent(summary.maxPosition),
    }),
    t(language, "insights.methodology.logic"),
    t(language, "insights.methodology.storage"),
  ];
}

function holdingRole(kind: string | undefined, language: Language) {
  return t(language, kind === "fund" ? "assetType.fund" : "assetType.stock");
}

function formatPlainPercent(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? "-" : `${value.toFixed(digits)}%`;
}

function formatSignedPercent(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? "-" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
