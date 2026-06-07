"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, CalendarClock, List, Save, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useCustomFunds } from "@/hooks/use-custom-funds";
import { apiErrorMessage } from "@/lib/api-client";
import { assetDisplayName, localizedAssetSector, quoteStatusLabel } from "@/lib/asset-display";
import { formatCompactCurrency, formatCurrency, formatNumber, formatPercent } from "@/lib/formatters";
import { frequencyLabel, strategyLabel, t, type Language } from "@/lib/i18n";
import { readReturnToState } from "@/lib/navigation-state";
import type { AssetRecord, CustomFundScore, Exposure, MarketId, Metric, PortfolioDcaPlan, PortfolioSummary } from "@/lib/types";
import { LineChart } from "../../components/charts";
import { Section, StatusBanner, ToneText } from "../shared/feature-shell";
import { SecondaryButton, WorkbenchPanel } from "../shared/calculation-workbench";
import { readCustomFundResultCache } from "./custom-fund-result-store";

type PieSlice = {
  label: string;
  value: number;
  detail?: string;
};

type DcaPlanRow = {
  asset: AssetRecord;
  plan: PortfolioDcaPlan;
};

const pieColors = ["#10b981", "#18181b", "#0ea5e9", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6"];

export function CustomFundResultPage({ marketId, language = "en" }: { marketId: MarketId; language?: Language }) {
  const location = useLocation();
  const navigate = useNavigate();
  const customFunds = useCustomFunds(marketId);
  const [result] = useState(() => readCustomFundResultCache(marketId));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [showStockList, setShowStockList] = useState(false);
  const [showDcaPlanDetails, setShowDcaPlanDetails] = useState(false);

  useEffect(() => {
    window.scrollTo({ left: 0, top: 0 });
  }, []);

  const score = result?.result.score ?? null;
  const summary = result?.result.summary ?? null;
  const metrics = useMemo(() => (summary && score ? buildMetrics(summary, score, marketId, language) : []), [language, marketId, score, summary]);
  const stockSlices = useMemo(() => (summary ? buildStockSlices(summary.holdings, language) : []), [language, summary]);
  const sectorSlices = useMemo(() => (summary ? buildSectorSlices(summary.sectorExposure, language) : []), [language, summary]);
  const dcaPlanRows = useMemo(() => result ? buildDcaPlanRows(result.selectedAssets, result.input.dcaPlans ?? {}) : [], [result]);
  const backHref = readReturnToState(location.state, `/custom-fund?market=${marketId}&lang=${language}`);

  function returnToCustomFund() {
    navigate(backHref);
  }

  async function saveCalculatedFund() {
    if (!result) {
      setStatus(t(language, "portfolio.noResultTitle"));
      return;
    }
    setSaving(true);
    setStatus(t(language, result.editingId ? "custom.status.updating" : "custom.status.saving"));
    try {
      if (result.editingId) {
        await customFunds.updateCustomFund(result.editingId, {
          name: result.input.name,
          style: result.input.style,
          holdings: result.input.holdings,
          score: result.result.score,
          capital: result.input.capital,
          cashBalance: result.input.cashBalance,
          startDate: result.input.startDate,
          endDate: result.input.endDate,
          dcaPlans: result.input.dcaPlans ?? {},
          portfolio: result.result.portfolio,
          summary: result.result.summary,
        });
        setStatus(t(language, "custom.status.updated"));
      } else {
        await customFunds.saveCustomFund({
          name: result.input.name,
          style: result.input.style,
          holdings: result.input.holdings,
          score: result.result.score,
          capital: result.input.capital,
          cashBalance: result.input.cashBalance,
          startDate: result.input.startDate,
          endDate: result.input.endDate,
          dcaPlans: result.input.dcaPlans ?? {},
          portfolio: result.result.portfolio,
          summary: result.result.summary,
        });
        setStatus(t(language, "custom.status.saved"));
      }
      setSaved(true);
    } catch (error) {
      setStatus(apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="border-b border-zinc-200 pb-6 dark:border-white/10">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <SecondaryButton onClick={returnToCustomFund}>
            <span className="inline-flex items-center gap-2"><ArrowLeft size={16} /> {t(language, "dca.back")}</span>
          </SecondaryButton>
          {result ? (
            <button
              type="button"
              disabled={saving || saved}
              onClick={saveCalculatedFund}
              className="inline-flex h-10 items-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
            >
              <Save size={16} />
              {saved ? t(language, "dca.savedAction") : result.editingId ? t(language, "custom.updateCustomFund") : t(language, "custom.saveDraft")}
            </button>
          ) : null}
        </div>
        <div className="max-w-3xl">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">{t(language, "nav.customFund")}</div>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white sm:text-4xl">{result?.input.name || t(language, "custom.title")}</h1>
          <p className="mt-3 text-sm leading-6 text-zinc-500 dark:text-zinc-400 sm:text-base">
            {result ? t(language, "custom.resultSubtitle") : t(language, "custom.noCachedResult")}
          </p>
        </div>
      </div>

      {!result || !score || !summary ? (
        <StatusBanner
          title={t(language, "portfolio.noResultTitle")}
          body={t(language, "custom.noResultBody")}
          action={<SecondaryButton onClick={returnToCustomFund}>{t(language, "nav.customFund")}</SecondaryButton>}
        />
      ) : (
        <>
          <div className="grid w-full items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
            <ResultMetricGrid metrics={metrics} />
            <div className="min-w-0">
              <section className="h-full rounded-lg border border-zinc-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
                  <h2 className="text-base font-semibold tracking-tight text-zinc-950 dark:text-white">{t(language, "portfolio.planSnapshot")}</h2>
                  <button
                    type="button"
                    onClick={() => setShowStockList(true)}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-zinc-200 bg-zinc-50 px-2.5 text-xs font-medium text-zinc-700 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300 dark:hover:border-emerald-400/40 dark:hover:bg-emerald-400/10 dark:hover:text-emerald-300"
                  >
                    <List size={14} />
                    {t(language, "custom.viewStocks")}
                  </button>
                </div>
                <div className="space-y-2 text-sm">
                  <SnapshotRow label={t(language, "custom.selectedAssets")} value={formatNumber(result.selectedAssets.length)} />
                  <SnapshotRow label={t(language, "common.targetWeight")} value={formatWeight(score.totalWeight)} />
                  <SnapshotRow label={t(language, "dca.startDate")} value={result.input.startDate} />
                  <SnapshotRow label={t(language, "dca.endDate")} value={result.input.endDate} />
                  <SnapshotRow label={t(language, "portfolio.capital")} value={formatCurrency(result.input.capital, marketId)} />
                  <SnapshotRow label={t(language, "custom.style")} value={result.input.style} />
                  <SnapshotRow label={t(language, "portfolio.enabledDcaPlans")} value={formatNumber(dcaPlanRows.filter((row) => row.plan.enabled).length)} />
                </div>
                {status ? (
                  <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-white/10">
                    <ToneText tone={saved ? "positive" : "neutral"}>{status}</ToneText>
                  </div>
                ) : null}
              </section>
            </div>
          </div>

          <WorkbenchPanel title={t(language, "portfolio.valueCurve")} subtitle={t(language, "custom.valueCurveSubtitle")} className="overflow-hidden">
            {summary.valueHistory.length ? (
              <LineChart
                data={summary.valueHistory}
                height={320}
                showAxes
                xAxisLabel={t(language, "common.date")}
                yAxisLabel={t(language, "common.value")}
                yValueFormatter={(value) => formatCompactCurrency(value, marketId)}
              />
            ) : (
              <StatusBanner title={t(language, "portfolio.noCurve")} />
            )}
          </WorkbenchPanel>

          <div className="grid items-stretch gap-5 lg:grid-cols-2">
            <CustomFundPie
              title={t(language, "custom.stockAllocation")}
              subtitle={t(language, "custom.stockAllocationSubtitle")}
              data={stockSlices}
              centerLabel={t(language, "assetType.stock")}
              centerValue={formatNumber(summary.holdings.length)}
              emptyTitle={t(language, "custom.selectStocksEmpty")}
            />
            <CustomFundPie
              title={t(language, "portfolio.sectorAllocation")}
              subtitle={t(language, "portfolio.allocationResultSource")}
              data={sectorSlices}
              centerLabel={t(language, "portfolio.exposure")}
              centerValue={sectorSlices.length ? formatWeight(sectorSlices[0].value) : "0.0%"}
              emptyTitle={t(language, "custom.noSectorAllocation")}
              footer={<CompactDcaPlanPanel rows={dcaPlanRows} marketId={marketId} language={language} onViewDetails={() => setShowDcaPlanDetails(true)} />}
            />
          </div>

          <Section title={t(language, "portfolio.holdings")} subtitle={t(language, "custom.holdingsSubtitle")}>
            <CustomFundHoldingsTable holdings={summary.holdings} assets={result.selectedAssets} marketId={marketId} language={language} />
          </Section>
          {showStockList ? <StockListModal assets={result.selectedAssets} language={language} onClose={() => setShowStockList(false)} /> : null}
          {showDcaPlanDetails ? <DcaPlanDetailsModal rows={dcaPlanRows} marketId={marketId} language={language} onClose={() => setShowDcaPlanDetails(false)} /> : null}
        </>
      )}
    </div>
  );
}

function buildMetrics(summary: PortfolioSummary, score: CustomFundScore, marketId: MarketId, language: Language): Metric[] {
  return [
    { label: t(language, "common.totalValue"), value: formatCurrency(summary.totalValue, marketId) },
    { label: t(language, "common.totalGain"), value: formatCurrency(summary.totalGain, marketId), delta: formatPercent(summary.totalGainPercent), tone: summary.totalGain >= 0 ? "positive" : "negative" },
    { label: t(language, "common.annualizedReturn"), value: formatPercent(summary.annualizedReturn), tone: summary.annualizedReturn >= 0 ? "positive" : "negative" },
    { label: t(language, "compare.maxDrawdown"), value: formatPercent(summary.maxDrawdown), tone: "negative" },
    { label: t(language, "compare.dividendYield"), value: formatPercent(score.dividendYield), delta: formatCurrency(estimatedDividend(summary.totalValue, score), marketId) },
    { label: t(language, "common.riskScore"), value: formatNumber(score.riskScore, 1), tone: score.riskScore > 65 ? "negative" : "neutral" },
    { label: t(language, "custom.valueScore"), value: formatNumber(score.valueScore, 1) },
    { label: t(language, "custom.quality"), value: formatNumber(score.qualityScore, 1) },
  ];
}

function ResultMetricGrid({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="grid h-full gap-2.5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-rows-2">
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

function SnapshotRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-zinc-100 pb-1.5 last:border-b-0 dark:border-white/10">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="max-w-40 truncate font-medium text-zinc-950 dark:text-white">{value}</span>
    </div>
  );
}

function StockListModal({ assets, language, onClose }: { assets: AssetRecord[]; language: Language; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 px-4 py-8 dark:bg-black/60" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label={t(language, "portfolio.closeFundList")} />
      <div className="relative flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-white/10 dark:bg-[#080d0c] dark:shadow-black/40">
        <div className="flex items-center justify-between gap-4 border-b border-zinc-100 px-4 py-3 dark:border-white/10">
          <div className="min-w-0">
            <h3 className="text-base font-semibold tracking-tight text-zinc-950 dark:text-white">{t(language, "custom.selectedStockList")}</h3>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t(language, "custom.selectedStockCount", { count: formatNumber(assets.length) })}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t(language, "portfolio.closeFundList")}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-zinc-200 text-zinc-500 transition hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-3">
          <div className="grid gap-2">
            {assets.map((asset) => (
              <div key={asset.id} className="flex min-w-0 items-center justify-between gap-4 rounded border border-zinc-200 bg-zinc-50/70 px-3 py-2.5 dark:border-white/10 dark:bg-white/[0.04]">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{asset.symbol}</div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{assetDisplayName(asset, language)}</div>
                </div>
                <div className="shrink-0 rounded bg-white px-2 py-1 text-xs font-medium text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
                  {localizedAssetSector(asset.sector, language)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function CompactDcaPlanPanel({
  rows,
  marketId,
  language,
  onViewDetails,
}: {
  rows: DcaPlanRow[];
  marketId: MarketId;
  language: Language;
  onViewDetails: () => void;
}) {
  const enabledRows = rows.filter((row) => row.plan.enabled);
  const totalInitial = enabledRows.reduce((total, row) => total + row.plan.initialAmount, 0);
  const totalRecurring = enabledRows.reduce((total, row) => total + row.plan.recurringAmount, 0);

  return (
    <div className="mt-4 border-t border-white/80 pt-4 dark:border-white/10">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-white">
            <CalendarClock size={15} className="text-emerald-600" />
            {t(language, "portfolio.enabledDcaPlans")}
          </div>
          <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{t(language, "custom.dcaPlanResultSubtitle")}</div>
        </div>
        <span className="shrink-0 rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
          {t(language, "portfolio.dcaEnabledShort", { count: formatNumber(enabledRows.length) })}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 rounded border border-white/80 bg-white/72 p-3 dark:border-white/10 dark:bg-white/[0.04]">
        <DcaPlanMetric label={t(language, "portfolio.enabledDcaPlans")} value={formatNumber(enabledRows.length)} compact />
        <DcaPlanMetric label={t(language, "portfolio.totalInitialDca")} value={formatCurrency(totalInitial, marketId)} compact />
        <DcaPlanMetric label={t(language, "portfolio.totalRecurringDca")} value={formatCurrency(totalRecurring, marketId)} compact />
      </div>
      {enabledRows.length ? (
        <button
          type="button"
          onClick={onViewDetails}
          className="mt-3 inline-flex h-9 w-full items-center justify-center rounded border border-emerald-200 bg-white/80 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50 dark:border-emerald-400/30 dark:bg-white/[0.04] dark:text-emerald-300 dark:hover:bg-emerald-400/10"
        >
          {t(language, "portfolio.viewDcaPlanDetails")}
        </button>
      ) : (
        <div className="mt-3 rounded border border-dashed border-zinc-200 bg-white p-3 text-sm text-zinc-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400">
          {t(language, "portfolio.noEnabledDcaPlans")}
        </div>
      )}
    </div>
  );
}

function DcaPlanDetailsModal({ rows, marketId, language, onClose }: { rows: DcaPlanRow[]; marketId: MarketId; language: Language; onClose: () => void }) {
  const enabledRows = rows.filter((row) => row.plan.enabled);
  const totalInitial = enabledRows.reduce((total, row) => total + row.plan.initialAmount, 0);
  const totalRecurring = enabledRows.reduce((total, row) => total + row.plan.recurringAmount, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 px-4 py-8 dark:bg-black/60" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label={t(language, "portfolio.closeDcaPlanDetails")} />
      <div className="relative flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-white/10 dark:bg-[#080d0c] dark:shadow-black/40">
        <div className="flex items-center justify-between gap-4 border-b border-zinc-100 px-4 py-3 dark:border-white/10">
          <div className="min-w-0">
            <h3 className="text-base font-semibold tracking-tight text-zinc-950 dark:text-white">{t(language, "portfolio.dcaPlanDetails")}</h3>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t(language, "custom.dcaPlanResultSubtitle")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t(language, "portfolio.closeDcaPlanDetails")}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-zinc-200 text-zinc-500 transition hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-3">
          <div className="mb-3 grid grid-cols-3 gap-2 rounded border border-zinc-200 bg-zinc-50/80 p-3 dark:border-white/10 dark:bg-white/[0.04]">
            <DcaPlanMetric label={t(language, "portfolio.enabledDcaPlans")} value={formatNumber(enabledRows.length)} compact />
            <DcaPlanMetric label={t(language, "portfolio.totalInitialDca")} value={formatCurrency(totalInitial, marketId)} compact />
            <DcaPlanMetric label={t(language, "portfolio.totalRecurringDca")} value={formatCurrency(totalRecurring, marketId)} compact />
          </div>
          {enabledRows.length ? (
            <div className="grid gap-2">
              {enabledRows.map((row) => (
                <section key={row.asset.id} className="rounded border border-emerald-100 bg-emerald-50/45 p-3 dark:border-emerald-400/30 dark:bg-emerald-400/10">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <CalendarClock size={15} className="shrink-0 text-emerald-600" />
                        <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{row.asset.symbol}</div>
                      </div>
                      <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{assetDisplayName(row.asset, language)}</div>
                    </div>
                    <span className="shrink-0 rounded bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
                      {t(language, "portfolio.dcaEnabled")}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
                    <DcaPlanMetric label={t(language, "dca.initialAmount")} value={formatCurrency(row.plan.initialAmount, marketId)} compact />
                    <DcaPlanMetric label={t(language, "dca.recurringAmount")} value={formatCurrency(row.plan.recurringAmount, marketId)} compact />
                    <DcaPlanMetric label={t(language, "dca.frequency")} value={frequencyLabel(language, row.plan.frequency)} compact />
                    <DcaPlanMetric label={t(language, "dca.strategy")} value={strategyLabel(language, row.plan.strategy ?? "standard")} compact />
                    <DcaPlanMetric label={t(language, "dca.transactionCost")} value={formatCurrency(row.plan.transactionCost, marketId)} compact />
                    <DcaPlanMetric label={t(language, "dca.reinvestDividends")} value={row.plan.reinvestDividends ? t(language, "common.yes") : t(language, "common.no")} compact />
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="rounded border border-dashed border-zinc-200 bg-white p-3 text-sm text-zinc-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400">
              {t(language, "portfolio.noEnabledDcaPlans")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DcaPlanMetric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`${compact ? "text-sm" : "text-base"} mt-1 truncate font-semibold text-zinc-950 dark:text-white`}>{value}</div>
    </div>
  );
}

function CustomFundHoldingsTable({ holdings, assets, marketId, language }: { holdings: PortfolioSummary["holdings"]; assets: AssetRecord[]; marketId: MarketId; language: Language }) {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
          <tr>
            <th className="px-4 py-3 text-left">{t(language, "common.asset")}</th>
            <th className="px-4 py-3 text-right">{t(language, "common.value")}</th>
            <th className="px-4 py-3 text-right">{t(language, "common.gain")}</th>
            <th className="px-4 py-3 text-right">{t(language, "common.price")}</th>
            <th className="px-4 py-3 text-right">{t(language, "compare.dividendYield")}</th>
            <th className="px-4 py-3 text-right">{t(language, "common.targetWeight")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-white/10">
          {holdings.map((holding) => {
            const asset = assetById.get(holding.assetId);
            return (
              <tr key={holding.id}>
                <td className="px-4 py-3">
                  <div className="font-medium text-zinc-950 dark:text-white">{asset ? assetDisplayName(asset, language) : holding.name}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">{holding.symbol} · {localizedAssetSector(holding.sector, language)}{asset ? ` · ${quoteStatusLabel(asset, language)}` : ""}</div>
                </td>
                <td className="px-4 py-3 text-right font-medium">{formatCurrency(holding.marketValue, marketId)}</td>
                <td className="px-4 py-3 text-right">
                  <ToneText tone={holding.gain >= 0 ? "positive" : "negative"} marketTone>{formatCurrency(holding.gain, marketId)} · {formatPercent(holding.gainPercent)}</ToneText>
                </td>
                <td className="px-4 py-3 text-right font-medium">{formatCurrency(holding.currentPrice, marketId)}</td>
                <td className="px-4 py-3 text-right">{formatPercent(asset ? assetDividendYield(asset) : 0)}</td>
                <td className="px-4 py-3 text-right">{formatWeight(holding.targetWeight)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CustomFundPie({
  title,
  subtitle,
  data,
  centerLabel,
  centerValue,
  emptyTitle,
  footer,
}: {
  title: string;
  subtitle: string;
  data: PieSlice[];
  centerLabel: string;
  centerValue: string;
  emptyTitle: string;
  footer?: ReactNode;
}) {
  const slices = compactSlices(data);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const circumference = 2 * Math.PI * 42;
  let offset = 0;

  return (
    <section className="flex h-full flex-col rounded-lg border border-zinc-200 bg-[radial-gradient(circle_at_35%_25%,rgba(16,185,129,0.12),transparent_34%),linear-gradient(135deg,#ffffff,rgba(244,244,245,0.75))] p-4 dark:border-white/10 dark:bg-[radial-gradient(circle_at_35%_25%,rgba(16,185,129,0.16),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.06),rgba(255,255,255,0.025))]">
      <div>
        <h3 className="text-base font-semibold tracking-tight text-zinc-950 dark:text-white">{title}</h3>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>
      </div>
      {slices.length ? (
        <>
          <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row">
            <div className="relative h-[190px] w-[190px] shrink-0">
              <svg viewBox="0 0 120 120" className="-rotate-90 drop-shadow-sm">
                <circle cx="60" cy="60" r="42" fill="transparent" stroke="#e4e4e7" strokeWidth="12" />
                {slices.map((slice, index) => {
                  const dash = (slice.value / total) * circumference;
                  const currentOffset = offset;
                  offset += dash;
                  return (
                    <circle
                      key={slice.label}
                      cx="60"
                      cy="60"
                      r="42"
                      fill="transparent"
                      stroke={pieColors[index % pieColors.length]}
                      strokeWidth="12"
                      strokeDasharray={`${dash} ${circumference - dash}`}
                      strokeDashoffset={-currentOffset}
                      strokeLinecap="round"
                    />
                  );
                })}
              </svg>
              <div className="absolute inset-8 flex flex-col items-center justify-center rounded-full bg-white text-center shadow-inner dark:bg-[#080d0c] dark:shadow-black/40">
                <div className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">{centerValue}</div>
                <div className="mt-1 max-w-20 text-xs font-medium text-zinc-500 dark:text-zinc-400">{centerLabel}</div>
              </div>
            </div>
            <div className="w-full min-w-0 flex-1 space-y-2">
              {slices.map((slice, index) => (
                <div key={slice.label} className="min-w-0 rounded border border-white/80 bg-white/72 p-2 dark:border-white/10 dark:bg-white/[0.04]">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: pieColors[index % pieColors.length] }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100">{slice.label}</div>
                      {slice.detail ? <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{slice.detail}</div> : null}
                    </div>
                    <div className="shrink-0 text-xs font-semibold text-zinc-950 dark:text-white">{formatWeight(slice.value)}</div>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/10">
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, slice.value))}%`, backgroundColor: pieColors[index % pieColors.length] }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          {footer}
        </>
      ) : (
        <div className="mt-4">
          <StatusBanner title={emptyTitle} />
        </div>
      )}
    </section>
  );
}

function buildStockSlices(holdings: PortfolioSummary["holdings"], language: Language): PieSlice[] {
  return holdings.map((holding) => ({
    label: holding.symbol,
    value: holding.currentWeight,
    detail: localizedAssetSector(holding.sector, language) || holding.name,
  }));
}

function buildSectorSlices(exposures: Exposure[], language: Language): PieSlice[] {
  return exposures.map((exposure) => ({
    label: localizedAssetSector(exposure.name, language) || exposure.name,
    value: exposure.weight,
    detail: t(language, "portfolio.allocationResultSource"),
  }));
}

function buildDcaPlanRows(assets: AssetRecord[], plans: Record<string, PortfolioDcaPlan>): DcaPlanRow[] {
  return assets.map((asset) => ({
    asset,
    plan: normalizeDcaPlan(plans[asset.id]),
  }));
}

function normalizeDcaPlan(plan?: PortfolioDcaPlan): PortfolioDcaPlan {
  return {
    enabled: Boolean(plan?.enabled),
    initialAmount: numericPlanValue(plan?.initialAmount, 0),
    recurringAmount: numericPlanValue(plan?.recurringAmount, 0),
    frequency: plan?.frequency ?? "monthly",
    transactionCost: numericPlanValue(plan?.transactionCost, 0),
    reinvestDividends: plan?.reinvestDividends ?? true,
    strategy: plan?.strategy ?? "standard",
  };
}

function numericPlanValue(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function compactSlices(data: PieSlice[]) {
  const slices = data
    .filter((slice) => slice.value > 0)
    .sort((left, right) => right.value - left.value);
  if (slices.length <= 6) return slices;
  const visible = slices.slice(0, 5);
  const rest = slices.slice(5);
  const otherWeight = rest.reduce((total, slice) => total + slice.value, 0);
  return [...visible, { label: "Other", value: otherWeight, detail: `${rest.length} items` }];
}

function estimatedDividend(capital: number, score: CustomFundScore) {
  return capital * (score.dividendYield / 100);
}

function assetDividendYield(asset: AssetRecord) {
  const value = (asset as AssetRecord & { dividendYield?: number }).dividendYield;
  return Number.isFinite(value) ? Number(value) : 0;
}

function formatWeight(value: number, digits = 1) {
  return `${value.toFixed(digits)}%`;
}
