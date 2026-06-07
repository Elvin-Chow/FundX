"use client";

import { ArrowLeft, Loader2, RefreshCw, Star } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useCalculationRun } from "@/hooks/use-calculation-run";
import { useResolvedLanguage } from "@/hooks/use-language";
import { apiErrorMessage, apiGet } from "@/lib/api-client";
import type { AssetDetailResponse } from "@/lib/api-contracts";
import { formatCompactCurrency, formatNumber, formatOptionalCompactCurrency, formatOptionalPercent } from "@/lib/formatters";
import { assetTypeLabel, localeForLanguage, t, type Language } from "@/lib/i18n";
import { upsertLocalWatchlistItem } from "@/lib/local-user-data";
import { marketToneBadgeClass, marketToneColor, marketToneTextClass, type MarketColorStyle } from "@/lib/market-color-style";
import { readReturnToState } from "@/lib/navigation-state";
import type { AssetRecord, AssetType, Fund, Stock, TimePoint, Tone } from "@/lib/types";
import { useMarketStore } from "@/stores/market-store";
import { AllocationBars, LineChart } from "../../components/charts";
import { normalizeMarket, type Market } from "../../components/types";
import { SecondaryButton } from "../shared/calculation-workbench";
import { LoadingRows, MetricStrip, PageHeader, Section, StatusBanner, ToneText } from "../shared/feature-shell";
import { useApiResource } from "@/hooks/use-api-resource";

type ChartRange = "1W" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "3Y" | "5Y" | "10Y" | "ALL";
type ChartGranularity = "daily" | "weekly" | "monthly";

type AssetRichDetail = {
  description?: string;
  rawFund?: Fund;
  rawStock?: Stock;
};

type DetailRow = {
  label: string;
  value: string;
  tone?: Tone;
};

type DetailCard = {
  title: string;
  rows: DetailRow[];
};

const chartRanges: ChartRange[] = ["1W", "1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "ALL"];
const chartGranularities: ChartGranularity[] = ["daily", "weekly", "monthly"];

export function AssetDetailPage({
  market = "us",
  marketId,
  assetId,
  assetType,
  language: languageProp = "en",
}: {
  market?: Market;
  marketId?: Market;
  assetId: string;
  assetType?: AssetType;
  language?: Language;
}) {
  const activeMarket = normalizeMarket(marketId ?? market);
  const language = useResolvedLanguage(languageProp);
  const location = useLocation();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [chartRange, setChartRange] = useState<ChartRange>("1Y");
  const [chartGranularity, setChartGranularity] = useState<ChartGranularity>("daily");
  const autoRefreshAttempts = useRef<Set<string>>(new Set());
  const marketColorStyle = useMarketStore((state) => state.marketColorStyle);
  const calculation = useCalculationRun<AssetDetailResponse>(activeMarket);
  const { run: runCalculation, running: calculationRunning } = calculation;
  const load = useCallback(
    (signal: AbortSignal) => apiGet<AssetDetailResponse>(`/api/assets/${assetId}`, {
      market: activeMarket,
      type: assetType,
    }, signal),
    [activeMarket, assetId, assetType],
  );
  const resource = useApiResource(load, [load], { keepPreviousData: true });
  const detailData = calculation.result ?? resource.data;
  const asset = detailData?.asset;
  const history = detailData?.history ?? [];
  const sortedHistory = sortValidHistory(history);
  const historyAutoRefreshReason = asset ? historyRefreshReason(sortedHistory, chartRange) : null;
  const backHref = readReturnToState(location.state, `/discover?market=${activeMarket}&lang=${language}`);

  function backToParent() {
    navigate(backHref);
  }

  async function addToWatchlist() {
    if (!asset) return;
    if (asset.latestPrice == null) {
      setStatus(t(language, "asset.noQuoteBody"));
      return;
    }
    setStatus(t(language, "discover.savingWatch", { symbol: asset.symbol }));
    try {
      upsertLocalWatchlistItem(activeMarket, {
        assetId: asset.id,
        assetType: asset.assetType,
        note: t(language, "asset.addedFrom"),
        target: Number((asset.latestPrice * 0.95).toFixed(2)),
      }, asset, detailData?.history ?? []);
      setStatus(t(language, "discover.watchSaved", { symbol: asset.symbol }));
    } catch (error) {
      setStatus(apiErrorMessage(error));
    }
  }

  const refreshPublicData = useCallback((range = chartRange) => {
    setStatus(t(language, "asset.refreshing"));
    void runCalculation({
      workflow: "asset-detail",
      assets: [{ assetId, assetType: assetType ?? asset?.assetType ?? "stock" }],
      params: { range },
      refresh: true,
    }).then((response) => {
      if (response) setStatus(t(language, "asset.detailLoaded"));
    });
  }, [asset?.assetType, assetId, assetType, chartRange, language, runCalculation]);

  useEffect(() => {
    if (!asset || !historyAutoRefreshReason || calculationRunning) return;
    const attemptKey = `${asset.id}:${asset.assetType}:${chartRange}:${historyAutoRefreshReason}`;
    if (autoRefreshAttempts.current.has(attemptKey)) return;
    autoRefreshAttempts.current.add(attemptKey);
    refreshPublicData(chartRange);
  }, [asset, calculationRunning, chartRange, historyAutoRefreshReason, refreshPublicData]);

  function handleChartRangeChange(range: ChartRange) {
    setChartRange(range);
    refreshPublicData(range);
  }

  if (resource.loading && !asset) {
    return (
      <div>
        <div className="mb-5">
          <SecondaryButton onClick={backToParent}>
            <span className="inline-flex items-center gap-2"><ArrowLeft size={16} /> {t(language, "dca.back")}</span>
          </SecondaryButton>
        </div>
        <PageHeader eyebrow={t(language, "asset.loadingTitle")} title={t(language, "asset.loadingTitle")} description={t(language, "asset.loadingBody")} showDivider={false} />
        <Section>
          <LoadingRows rows={4} />
        </Section>
      </div>
    );
  }

  if (!asset || resource.error) {
    return (
      <div>
        <div className="mb-5">
          <SecondaryButton onClick={backToParent}>
            <span className="inline-flex items-center gap-2"><ArrowLeft size={16} /> {t(language, "dca.back")}</span>
          </SecondaryButton>
        </div>
        <PageHeader eyebrow={t(language, "asset.unavailableTitle")} title={t(language, "asset.unavailableTitle")} description={t(language, "asset.unavailableBody")} showDivider={false} />
        <Section>
          <StatusBanner title={resource.error ?? t(language, "asset.notFound")} tone="negative" />
        </Section>
      </div>
    );
  }

  const richDetail = readRichDetail(detailData?.detail);
  const stock = detailData?.stock ?? richDetail.rawStock;
  const fund = detailData?.fund ?? richDetail.rawFund;
  const rangedHistory = filterHistoryByChartRange(sortedHistory, chartRange);
  const chartData = resampleHistory(rangedHistory, chartGranularity);
  const historyStats = summarizeHistory(rangedHistory);
  const showingHistoryRefresh = calculationRunning && !chartData.length;
  const chartTone = toneFromValue(historyStats?.returnPercent);
  const chartColor = marketToneColor(chartTone, marketColorStyle);
  const quoteStatus = quoteLabel(asset, language);
  const metrics = [
    { label: t(language, "common.price"), value: formatOptionalCompactCurrency(asset.latestPrice, activeMarket), delta: formatOptionalPercent(asset.dailyChange), tone: (asset.dailyChange ?? 0) >= 0 ? "positive" as const : "negative" as const },
    { label: t(language, "asset.quote"), value: quoteStatus },
    { label: t(language, "asset.volume"), value: formatOptionalNumber(asset.latestVolume) },
    { label: t(language, "common.type"), value: asset.kind === "fund" ? assetTypeLabel(language, "fund") : assetTypeLabel(language, "stock") },
  ];
  const profileRows = buildProfileRows(asset, stock, fund, activeMarket, language);
  const detailCards = buildDetailCards(asset, stock, fund, activeMarket, language);
  const signalRows = buildSignalRows(asset, historyStats, activeMarket, language);
  const historySubtitle = historyStats
    ? t(language, "asset.klineSubtitle", {
      start: formatDateLabel(historyStats.startDate, language),
      end: formatDateLabel(historyStats.endDate, language),
      points: chartData.length,
      interval: chartGranularityLabel(language, chartGranularity),
    })
    : t(language, "asset.historySubtitle");

  return (
    <div>
      <div className="mb-5">
        <SecondaryButton onClick={backToParent}>
          <span className="inline-flex items-center gap-2"><ArrowLeft size={16} /> {t(language, "dca.back")}</span>
        </SecondaryButton>
      </div>
      <PageHeader
        eyebrow={`${asset.symbol} · ${asset.kind ?? asset.assetType}`}
        title={asset.name}
        description={[asset.symbol, asset.exchange, asset.sector ?? asset.industry].filter(Boolean).join(" · ")}
        showDivider={false}
        action={
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={addToWatchlist} className="inline-flex h-10 items-center gap-2 rounded border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-950 hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03] dark:text-white dark:hover:bg-white/10">
              <Star size={16} />
              {t(language, "discover.watch")}
            </button>
            <button type="button" onClick={() => refreshPublicData()} className="inline-flex h-10 items-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200">
              <RefreshCw size={16} className={calculationRunning ? "animate-spin" : undefined} />
              {t(language, "common.refreshPublicData")}
            </button>
          </div>
        }
      />
      {resource.error || calculation.error || status || calculation.warnings.length || asset.quoteStatus !== "fresh" ? (
        <Section>
          <StatusBanner
            title={resource.error ?? calculation.error ?? (status || quoteStatus)}
            body={calculation.warnings.map((warning) => warning.message).join(" ")}
            tone={resource.error || calculation.error ? "negative" : "neutral"}
          />
        </Section>
      ) : null}
      <MetricStrip metrics={metrics} />
      <Section
        title={t(language, "asset.klineTitle")}
        subtitle={historySubtitle}
        action={
          <ChartControls
            language={language}
            range={chartRange}
            granularity={chartGranularity}
            onRangeChange={handleChartRangeChange}
            onGranularityChange={setChartGranularity}
          />
        }
      >
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.03]">
          {chartData.length ? (
            <>
              <LineChart
                data={chartData}
                height={360}
                color={chartColor}
                showAxes
                xAxisLabel={t(language, "common.date")}
                yAxisLabel={asset.kind === "fund" ? t(language, "fund.nav") : t(language, "common.price")}
                yValueFormatter={(value) => formatCompactCurrency(value, activeMarket)}
              />
              {historyStats ? (
                <div className="mt-4 grid gap-0 border-t border-zinc-100 pt-4 dark:border-white/10 sm:grid-cols-2 lg:grid-cols-6">
                  <ChartStat label={t(language, "asset.rangeReturn")} value={formatOptionalPercent(historyStats.returnPercent)} tone={chartTone} marketColorStyle={marketColorStyle} />
                  <ChartStat label={t(language, "asset.rangeHigh")} value={formatOptionalCompactCurrency(historyStats.high, activeMarket)} marketColorStyle={marketColorStyle} />
                  <ChartStat label={t(language, "asset.rangeLow")} value={formatOptionalCompactCurrency(historyStats.low, activeMarket)} marketColorStyle={marketColorStyle} />
                  <ChartStat label={t(language, "asset.rangeStart")} value={formatOptionalCompactCurrency(historyStats.startValue, activeMarket)} marketColorStyle={marketColorStyle} />
                  <ChartStat label={t(language, "asset.rangeEnd")} value={formatOptionalCompactCurrency(historyStats.endValue, activeMarket)} marketColorStyle={marketColorStyle} />
                  <ChartStat label={t(language, "asset.dataPoints")} value={formatNumber(chartData.length)} marketColorStyle={marketColorStyle} />
                </div>
              ) : null}
            </>
          ) : showingHistoryRefresh ? (
            <HistoryRefreshEmptyState language={language} />
          ) : (
            <StatusBanner title={t(language, "asset.noHistoryTitle")} body={t(language, "asset.noHistoryBody")} />
          )}
        </div>
      </Section>
      {detailCards.length ? (
        <Section title={t(language, "asset.keyMetrics")}>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {detailCards.map((card) => (
              <div key={card.title} className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.03]">
                <h3 className="text-sm font-semibold text-zinc-950 dark:text-white">{card.title}</h3>
                <div className="mt-4 space-y-3">
                  {card.rows.map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-4 text-sm">
                      <span className="min-w-0 truncate text-zinc-500 dark:text-zinc-400">{row.label}</span>
                      <span className={`shrink-0 font-medium tabular-nums ${row.tone ? marketToneTextClass(row.tone, marketColorStyle) : "text-zinc-950 dark:text-white"}`}>{row.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
      <div className="grid items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <section className="flex min-w-0 flex-col py-6">
          <div className="mb-4 flex min-h-7 items-end">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-950 dark:text-white">{t(language, "common.profile")}</h2>
          </div>
          <div className="grid flex-1 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03] md:grid-cols-2">
            {profileRows.map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between gap-4 border-b border-zinc-100 p-4 text-sm dark:border-white/10 md:odd:border-r md:odd:border-zinc-100 md:odd:dark:border-white/10">
                <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
                <span className="min-w-0 truncate text-right font-medium text-zinc-950 dark:text-white">{value}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="flex min-w-0 flex-col py-6">
          <div className="mb-4 flex min-h-7 items-end">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-950 dark:text-white">{t(language, "asset.signal")}</h2>
          </div>
          <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]">
            {signalRows.map((row) => (
              <div key={row.label} className="flex flex-1 flex-col justify-center border-b border-zinc-100 px-4 py-3 last:border-0 dark:border-white/10">
                <div className="text-sm text-zinc-500 dark:text-zinc-400">{row.label}</div>
                {row.tone ? (
                  <ToneText tone={row.tone} marketTone>{row.value}</ToneText>
                ) : (
                  <div className="mt-1 text-sm font-medium text-zinc-950 dark:text-white">{row.value}</div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
      {fund?.sectorExposure?.length ? (
        <Section title={t(language, "fund.allocation")}>
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.03]">
            <AllocationBars data={fund.sectorExposure.slice(0, 8)} />
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function HistoryRefreshEmptyState({ language }: { language: Language }) {
  return (
    <div className="flex min-h-[360px] flex-col items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-6 text-center dark:border-white/10 dark:bg-white/[0.02]">
      <Loader2 className="h-8 w-8 animate-spin text-zinc-500 dark:text-zinc-300" />
      <div className="mt-4 text-sm font-semibold text-zinc-950 dark:text-white">{t(language, "asset.refreshingHistoryTitle")}</div>
      <p className="mt-2 max-w-sm text-sm leading-6 text-zinc-500 dark:text-zinc-400">{t(language, "asset.refreshingHistoryBody")}</p>
    </div>
  );
}

function quoteLabel(asset: AssetDetailResponse["asset"], language: Language) {
  if (asset.quoteStatus === "fresh" && asset.latestPrice != null) return t(language, "asset.quoteLive");
  if (asset.quoteStatus === "stale") return t(language, "asset.quoteStale");
  return t(language, "asset.noQuoteTitle");
}

function formatOptionalNumber(value: number | null | undefined) {
  if (value == null) return "—";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function readRichDetail(detail: unknown): AssetRichDetail {
  return detail && typeof detail === "object" ? detail as AssetRichDetail : {};
}

function ChartControls({
  language,
  range,
  granularity,
  onRangeChange,
  onGranularityChange,
}: {
  language: Language;
  range: ChartRange;
  granularity: ChartGranularity;
  onRangeChange: (range: ChartRange) => void;
  onGranularityChange: (granularity: ChartGranularity) => void;
}) {
  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
      <div className="flex max-w-full overflow-x-auto rounded-lg border border-zinc-200 bg-white p-1 dark:border-white/10 dark:bg-white/[0.03]">
        {chartRanges.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onRangeChange(option)}
            aria-pressed={range === option}
            className={chartControlClass(range === option)}
          >
            {chartRangeLabel(language, option)}
          </button>
        ))}
      </div>
      <div className="flex shrink-0 rounded-lg border border-zinc-200 bg-white p-1 dark:border-white/10 dark:bg-white/[0.03]">
        {chartGranularities.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onGranularityChange(option)}
            aria-pressed={granularity === option}
            className={chartControlClass(granularity === option)}
          >
            {chartGranularityLabel(language, option)}
          </button>
        ))}
      </div>
    </div>
  );
}

function chartControlClass(active: boolean) {
  return [
    "h-8 shrink-0 rounded px-3 text-xs font-medium transition",
    active
      ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
      : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white",
  ].join(" ");
}

function ChartStat({
  label,
  value,
  tone,
  marketColorStyle,
}: {
  label: string;
  value: string;
  tone?: Tone;
  marketColorStyle: MarketColorStyle;
}) {
  return (
    <div className="min-w-0 px-0 py-2 sm:px-3">
      <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`mt-1 inline-flex max-w-full rounded px-2 py-1 text-sm font-semibold tabular-nums ${tone ? marketToneBadgeClass(tone, marketColorStyle) : "bg-zinc-100 text-zinc-950 dark:bg-white/10 dark:text-white"}`}>
        <span className="truncate">{value}</span>
      </div>
    </div>
  );
}

function chartRangeLabel(language: Language, range: ChartRange) {
  return t(language, `asset.range.${range}`);
}

function chartGranularityLabel(language: Language, granularity: ChartGranularity) {
  return t(language, `asset.interval.${granularity}`);
}

function sortValidHistory(history: TimePoint[]) {
  return [...history]
    .filter((point) => point.date && Number.isFinite(point.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function historyRefreshReason(history: TimePoint[], range: ChartRange) {
  if (history.length < 2) return "missing";
  const firstDate = history[0]?.date;
  const lastDate = history.at(-1)?.date;
  if (!firstDate || !lastDate) return "missing";
  if (daysBetweenIso(lastDate, isoDate(new Date())) > 7) return "stale";
  if (range === "ALL") return historySpanDays(history) < 500 ? "short-all" : null;
  const requestedStart = chartRangeStartDate(range, isoDate(new Date()));
  if (!requestedStart) return null;
  return daysBetweenIso(requestedStart, firstDate) > 14 ? "short-range" : null;
}

function filterHistoryByChartRange(history: TimePoint[], range: ChartRange) {
  if (range === "ALL" || history.length < 2) return history;
  const endDate = history.at(-1)?.date;
  if (!endDate) return history;
  const startDate = chartRangeStartDate(range, endDate);
  if (!startDate) return history;
  const filtered = history.filter((point) => point.date >= startDate);
  return filtered.length >= 2 ? filtered : history.slice(-2);
}

function chartRangeStartDate(range: ChartRange, endDate: string) {
  const end = parseUtcDate(endDate);
  if (!end) return null;
  if (range === "YTD") return `${end.getUTCFullYear()}-01-01`;
  const monthsByRange: Partial<Record<ChartRange, number>> = {
    "1M": -1,
    "3M": -3,
    "6M": -6,
    "1Y": -12,
    "3Y": -36,
    "5Y": -60,
    "10Y": -120,
  };
  if (range === "1W") return isoDate(addUtcDays(end, -7));
  const months = monthsByRange[range];
  return months == null ? null : isoDate(addUtcMonths(end, months));
}

function resampleHistory(history: TimePoint[], granularity: ChartGranularity) {
  if (granularity === "daily") return history;
  const buckets = new Map<string, TimePoint>();
  history.forEach((point) => {
    buckets.set(bucketKey(point.date, granularity), point);
  });
  return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function bucketKey(date: string, granularity: ChartGranularity) {
  if (granularity === "monthly") return date.slice(0, 7);
  if (granularity === "weekly") {
    const parsed = parseUtcDate(date);
    if (!parsed) return date;
    const day = parsed.getUTCDay();
    const daysFromMonday = day === 0 ? 6 : day - 1;
    return isoDate(addUtcDays(parsed, -daysFromMonday));
  }
  return date;
}

function summarizeHistory(history: TimePoint[]) {
  if (!history.length) return null;
  const start = history[0];
  const end = history.at(-1) ?? start;
  const high = history.reduce((max, point) => Math.max(max, point.value), start.value);
  const low = history.reduce((min, point) => Math.min(min, point.value), start.value);
  const returnPercent = start.value === 0 ? null : ((end.value - start.value) / start.value) * 100;
  return {
    startDate: start.date,
    endDate: end.date,
    startValue: start.value,
    endValue: end.value,
    high,
    low,
    returnPercent,
  };
}

function buildProfileRows(asset: AssetRecord, stock: Stock | undefined, fund: Fund | undefined, marketId: "us", language: Language): DetailRow[] {
  return compactRows([
    { label: t(language, "common.market"), value: asset.marketId.toUpperCase() },
    { label: t(language, "common.symbol"), value: asset.symbol },
    { label: t(language, "asset.exchange"), value: valueOrDash(asset.exchange) },
    { label: t(language, "discover.sector"), value: valueOrDash(asset.sector ?? stock?.sector) },
    { label: t(language, "discover.industry"), value: valueOrDash(asset.industry ?? stock?.industry ?? fund?.category) },
    { label: t(language, "common.type"), value: asset.fundSubtype ?? asset.fundType ?? fund?.type ?? assetTypeLabel(language, asset.assetType) },
    { label: t(language, "asset.source"), value: valueOrDash(asset.sourceName ?? asset.source) },
    { label: t(language, "asset.quoteSource"), value: valueOrDash(asset.quoteSource) },
    { label: t(language, "asset.tradable"), value: asset.isTradable == null ? "—" : t(language, asset.isTradable ? "common.yes" : "common.no") },
    { label: t(language, "common.updated"), value: formatDateLabel(asset.quoteFetchedAt ?? asset.updatedAt, language) },
    { label: "AUM", value: formatOptionalCompactCurrency(fund?.aum ?? asset.aum, marketId) },
    { label: t(language, "common.expense"), value: formatPlainPercent(fund?.expenseRatio ?? asset.expenseRatio, 2) },
  ]);
}

function buildDetailCards(asset: AssetRecord, stock: Stock | undefined, fund: Fund | undefined, marketId: "us", language: Language): DetailCard[] {
  if (stock) {
    return [
      {
        title: t(language, "asset.valuation"),
        rows: [
          { label: t(language, "asset.marketCap"), value: formatOptionalCompactCurrency(stock.marketCap, marketId) },
          { label: t(language, "asset.peRatio"), value: formatOptionalMetricNumber(stock.peRatio, 1) },
          { label: t(language, "asset.pbRatio"), value: formatOptionalMetricNumber(stock.pbRatio, 1) },
          { label: t(language, "asset.valueScore"), value: formatScore(stock.valueScore) },
        ],
      },
      {
        title: t(language, "asset.quality"),
        rows: [
          { label: t(language, "asset.roe"), value: formatPlainPercent(stock.roe), tone: toneFromValue(stock.roe) },
          { label: t(language, "asset.grossMargin"), value: formatPlainPercent(stock.grossMargin), tone: toneFromValue(stock.grossMargin) },
          { label: t(language, "asset.revenueGrowth"), value: formatOptionalPercent(stock.revenueGrowth), tone: toneFromValue(stock.revenueGrowth) },
          { label: t(language, "asset.qualityScore"), value: formatScore(stock.qualityScore) },
        ],
      },
      {
        title: t(language, "asset.riskProfile"),
        rows: [
          { label: t(language, "asset.volatility"), value: formatPlainPercent(stock.volatility) },
          { label: t(language, "asset.riskScore"), value: formatScore(stock.riskScore), tone: riskTone(stock.riskScore) },
          { label: t(language, "asset.debtRatio"), value: formatPlainPercent(stock.debtRatio), tone: riskTone(stock.debtRatio) },
          { label: t(language, "asset.profitGrowth"), value: formatOptionalPercent(stock.profitGrowth), tone: toneFromValue(stock.profitGrowth) },
        ],
      },
      {
        title: t(language, "asset.income"),
        rows: [
          { label: t(language, "asset.dividendYield"), value: formatPlainPercent(stock.dividendYield), tone: stock.dividendYield > 0 ? "positive" : "neutral" },
          { label: t(language, "asset.fcfYield"), value: formatPlainPercent(stock.freeCashFlowYield), tone: toneFromValue(stock.freeCashFlowYield) },
          { label: t(language, "asset.volume"), value: formatOptionalNumber(asset.latestVolume) },
          { label: t(language, "asset.turnover"), value: formatOptionalCompactCurrency(asset.latestTurnover, marketId) },
        ],
      },
    ];
  }

  if (fund) {
    return [
      {
        title: t(language, "asset.performance"),
        rows: [
          { label: t(language, "asset.oneYearReturn"), value: formatOptionalPercent(fund.oneYearReturn), tone: toneFromValue(fund.oneYearReturn) },
          { label: t(language, "asset.threeYearReturn"), value: formatOptionalPercent(fund.threeYearAnnualizedReturn), tone: toneFromValue(fund.threeYearAnnualizedReturn) },
          { label: t(language, "asset.fiveYearReturn"), value: formatOptionalPercent(fund.fiveYearAnnualizedReturn), tone: toneFromValue(fund.fiveYearAnnualizedReturn) },
          { label: t(language, "common.totalReturn"), value: formatOptionalPercent(fund.totalReturn), tone: toneFromValue(fund.totalReturn) },
        ],
      },
      {
        title: t(language, "asset.riskProfile"),
        rows: [
          { label: t(language, "asset.maxDrawdown"), value: formatOptionalPercent(fund.maxDrawdown), tone: "negative" },
          { label: t(language, "asset.volatility"), value: formatPlainPercent(fund.volatility) },
          { label: t(language, "asset.sharpeRatio"), value: formatOptionalMetricNumber(fund.sharpeRatio, 2) },
          { label: t(language, "asset.riskLevel"), value: riskLevelLabel(fund.riskLevel, language) },
        ],
      },
      {
        title: t(language, "asset.scaleAndCost"),
        rows: [
          { label: "AUM", value: formatOptionalCompactCurrency(fund.aum, marketId) },
          { label: t(language, "common.expense"), value: formatPlainPercent(fund.expenseRatio, 2) },
          { label: t(language, "asset.dividendYield"), value: formatPlainPercent(fund.dividendYield), tone: fund.dividendYield > 0 ? "positive" : "neutral" },
          { label: t(language, "asset.inceptionDate"), value: formatDateLabel(fund.inceptionDate, language) },
        ],
      },
      {
        title: t(language, "asset.styleAndProfile"),
        rows: [
          { label: t(language, "asset.fundCompany"), value: valueOrDash(fund.fundCompany) },
          { label: t(language, "asset.category"), value: valueOrDash(fund.category) },
          { label: t(language, "asset.style"), value: valueOrDash(fund.style) },
          { label: t(language, "fund.topHoldings"), value: fund.holdings?.length ? formatNumber(fund.holdings.length) : "—" },
        ],
      },
    ];
  }

  return [
    {
      title: t(language, "asset.dataCoverage"),
      rows: [
        { label: t(language, "common.price"), value: formatOptionalCompactCurrency(asset.latestPrice, marketId), tone: toneFromValue(asset.dailyChange) },
        { label: t(language, "asset.volume"), value: formatOptionalNumber(asset.latestVolume) },
        { label: t(language, "asset.turnover"), value: formatOptionalCompactCurrency(asset.latestTurnover, marketId) },
        { label: t(language, "common.popularity"), value: formatOptionalMetricNumber(asset.popularity, 0) },
      ],
    },
  ];
}

function buildSignalRows(asset: AssetRecord, historyStats: ReturnType<typeof summarizeHistory>, marketId: "us", language: Language): DetailRow[] {
  const rangeTone = toneFromValue(historyStats?.returnPercent);
  return [
    {
      label: t(language, "asset.latestMove"),
      value: asset.dailyChange == null ? t(language, "asset.noQuoteTitle") : t(language, "asset.today", { change: formatOptionalPercent(asset.dailyChange) }),
      tone: asset.dailyChange == null ? "neutral" : toneFromValue(asset.dailyChange),
    },
    {
      label: t(language, "asset.rangeReturn"),
      value: historyStats?.returnPercent == null ? "—" : formatOptionalPercent(historyStats.returnPercent),
      tone: rangeTone,
    },
    {
      label: t(language, "asset.liquidity"),
      value: formatOptionalNumber(asset.latestVolume),
    },
    {
      label: t(language, "asset.rangeHigh"),
      value: historyStats ? formatOptionalCompactCurrency(historyStats.high, marketId) : "—",
      tone: historyStats ? "positive" : "neutral",
    },
  ];
}

function compactRows(rows: DetailRow[]) {
  return rows.filter((row) => row.value !== "");
}

function toneFromValue(value: number | null | undefined): Tone {
  if (value == null || !Number.isFinite(value)) return "neutral";
  return value >= 0 ? "positive" : "negative";
}

function riskTone(value: number | null | undefined): Tone {
  if (value == null || !Number.isFinite(value)) return "neutral";
  if (value >= 65) return "negative";
  if (value <= 35) return "positive";
  return "neutral";
}

function valueOrDash(value: string | null | undefined) {
  return value?.trim() ? value : "—";
}

function formatPlainPercent(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

function formatOptionalMetricNumber(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatNumber(value, digits);
}

function formatScore(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatNumber(value, 0)}/100`;
}

function riskLevelLabel(value: Fund["riskLevel"] | undefined, language: Language) {
  return value ? t(language, `asset.riskLevel.${value}`) : "—";
}

function formatDateLabel(value: string | null | undefined, language: Language) {
  if (!value) return "—";
  const parsed = new Date(value.includes("T") ? value : `${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(localeForLanguage(language), {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function parseUtcDate(value: string) {
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addUtcMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function historySpanDays(history: TimePoint[]) {
  const firstDate = history[0]?.date;
  const lastDate = history.at(-1)?.date;
  if (!firstDate || !lastDate) return 0;
  return daysBetweenIso(firstDate, lastDate);
}

function daysBetweenIso(startDate: string, endDate: string) {
  const start = parseUtcDate(startDate);
  const end = parseUtcDate(endDate);
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}
