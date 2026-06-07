"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, Save } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDca } from "@/hooks/use-dca";
import { apiErrorMessage } from "@/lib/api-client";
import { simulateDcaPlan } from "@/lib/calculations";
import { formatCompactCurrency, formatCurrency, formatNumber, formatPercent } from "@/lib/formatters";
import { frequencyLabel, strategyLabel, t, type Language } from "@/lib/i18n";
import { readReturnToState } from "@/lib/navigation-state";
import type { DcaCashFlow, DcaInput, MarketId, Metric } from "@/lib/types";
import { LineChart } from "../../components/charts";
import { Section, StatusBanner, ToneText } from "../shared/feature-shell";
import { SecondaryButton, WorkbenchPanel } from "../shared/calculation-workbench";
import { readDcaResultCache, type DcaResultCache } from "./dca-result-store";

export function DCAResultPage({ marketId, language = "en" }: { marketId: MarketId; language?: Language }) {
  const location = useLocation();
  const navigate = useNavigate();
  const dca = useDca(marketId);
  const [result, setResult] = useState<DcaResultCache | null>(() => sanitizeCachedDcaResult(readDcaResultCache(marketId)));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const metrics = useMemo(() => result ? buildMetrics(result, marketId, language) : [], [language, marketId, result]);
  const cashFlowEvents = useMemo(() => result ? eventCashFlows(result) : [], [result]);
  const backHref = readReturnToState(location.state, `/dca?market=${marketId}&lang=${language}`);

  function backToParent() {
    navigate(backHref);
  }

  async function savePlan() {
    if (!result) return;
    setSaving(true);
    setStatus(result.editingPlanId ? t(language, "dca.updating") : t(language, "dca.saving"));
    try {
      const input = saveInput(result);
      if (result.editingPlanId) {
        await dca.updatePlan(result.editingPlanId, input);
        setStatus(t(language, "dca.updated"));
      } else {
        await dca.savePlan(input);
        setStatus(t(language, "dca.saved"));
      }
      setSaved(true);
      setResult({ ...result, input });
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
          <SecondaryButton onClick={backToParent}>
            <span className="inline-flex items-center gap-2"><ArrowLeft size={16} /> {t(language, "dca.back")}</span>
          </SecondaryButton>
          {result ? (
            <button
              type="button"
              disabled={saving || saved}
              onClick={savePlan}
              className="inline-flex h-10 items-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
            >
              <Save size={16} />
              {saved ? t(language, "dca.savedAction") : result.editingPlanId ? t(language, "dca.updatePlan") : t(language, "dca.savePlan")}
            </button>
          ) : null}
        </div>
        <div className="max-w-3xl">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">{t(language, "nav.dca")}</div>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white sm:text-4xl">{result?.simulation.name ?? t(language, "dca.resultTitle")}</h1>
          <p className="mt-3 text-sm leading-6 text-zinc-500 dark:text-zinc-400 sm:text-base">
            {result ? `${result.asset.symbol} · ${strategyLabel(language, result.input.strategy)}` : t(language, "dca.resultUnavailableBody")}
          </p>
        </div>
      </div>

      {!result ? (
        <StatusBanner
          title={t(language, "dca.noSimulationTitle")}
          body={t(language, "dca.noCachedResult")}
          action={<SecondaryButton onClick={backToParent}>{t(language, "dca.returnToLab")}</SecondaryButton>}
        />
      ) : (
        <>
          <div className="grid w-full items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
            <ResultMetricGrid metrics={metrics} />
            <div className="min-w-0">
              <section className="h-full rounded-lg border border-zinc-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="mb-3 min-w-0">
                  <h2 className="text-base font-semibold tracking-tight text-zinc-950 dark:text-white">{t(language, "dca.planSnapshot")}</h2>
                  <p className="mt-1 truncate text-sm text-zinc-500 dark:text-zinc-400">{result.asset.name}</p>
                </div>
                <div className="space-y-2 text-sm">
                  <SnapshotRow label={t(language, "dca.startDate")} value={result.input.startDate} />
                  <SnapshotRow label={t(language, "dca.endDate")} value={result.input.endDate} />
                  <SnapshotRow label={t(language, "dca.frequency")} value={frequencyLabel(language, result.input.frequency)} />
                  <SnapshotRow label={t(language, "dca.strategy")} value={strategyLabel(language, result.input.strategy)} />
                  <SnapshotRow label={t(language, "dca.transactionCost")} value={formatCurrency(result.input.transactionCost, marketId)} />
                  <SnapshotRow label={t(language, "dca.reinvestDividends")} value={result.input.reinvestDividends ? t(language, "common.yes") : t(language, "common.no")} />
                </div>
                {status ? (
                  <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-white/10">
                    <ToneText tone={status === t(language, "dca.saved") || status === t(language, "dca.updated") ? "positive" : "neutral"}>{status}</ToneText>
                  </div>
                ) : null}
              </section>
            </div>
          </div>

          <div className="w-full space-y-5">
            <WorkbenchPanel title={t(language, "dca.projectedCurve")} subtitle={t(language, "dca.projectedCurveSubtitle")} className="overflow-hidden">
              <LineChart
                data={result.simulation.valueHistory}
                height={320}
                showAxes
                xAxisLabel={t(language, "common.date")}
                yAxisLabel={t(language, "common.value")}
                yValueFormatter={(value) => formatCompactCurrency(value, marketId)}
              />
            </WorkbenchPanel>

            <div className="grid gap-5 md:grid-cols-2">
              <WorkbenchPanel title={t(language, "dca.contributionBase")} className="overflow-hidden">
                <LineChart
                  data={result.simulation.contributionHistory}
                  height={180}
                  color="#71717a"
                  muted
                  showAxes
                  xAxisLabel={t(language, "common.date")}
                  yAxisLabel={t(language, "dca.contribution")}
                  yValueFormatter={(value) => formatCompactCurrency(value, marketId)}
                />
              </WorkbenchPanel>
              <WorkbenchPanel title={t(language, "dca.drawdownPath")} className="overflow-hidden">
                <LineChart
                  data={result.simulation.drawdownHistory}
                  height={180}
                  color="#ef4444"
                  muted
                  showArea={false}
                  showAxes
                  xAxisLabel={t(language, "common.date")}
                  yAxisLabel={t(language, "dca.drawdownPath")}
                  yValueFormatter={(value) => `${value.toFixed(1)}%`}
                />
              </WorkbenchPanel>
            </div>
          </div>

          <Section title={t(language, "dca.cashFlowRows")} subtitle={t(language, "dca.cashFlowDetailSubtitle")}>
            <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]">
              {cashFlowEvents.length === 0 ? (
                <StatusBanner title={t(language, "dca.noCashFlowEvents")} />
              ) : (
              <div className="max-h-[34rem] overflow-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="sticky top-0 z-10 bg-zinc-50 text-xs uppercase text-zinc-500 shadow-[0_1px_0_rgba(228,228,231,1)] dark:bg-zinc-950 dark:text-zinc-400 dark:shadow-[0_1px_0_rgba(255,255,255,0.1)]">
                    <tr>
                      <th className="px-4 py-3 text-left">{t(language, "common.date")}</th>
                      <th className="px-4 py-3 text-right">{t(language, "dca.contribution")}</th>
                      <th className="px-4 py-3 text-right">{t(language, "common.fee")}</th>
                      <th className="px-4 py-3 text-right">{t(language, "cash.dividend")}</th>
                      <th className="px-4 py-3 text-right">{t(language, "dca.shares")}</th>
                      <th className="px-4 py-3 text-right">{t(language, "dca.sharesAccumulated")}</th>
                      <th className="px-4 py-3 text-right">{t(language, "common.value")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-white/10">
                    {cashFlowEvents.slice(-24).map((row) => <CashFlowRow key={`${row.date}-${row.accumulatedShares}-${row.contribution}-${row.dividend}`} row={row} marketId={marketId} />)}
                  </tbody>
                </table>
              </div>
              )}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function buildMetrics(result: DcaResultCache, marketId: MarketId, language: Language): Metric[] {
  const simulation = result.simulation;
  return [
    { label: t(language, "dca.finalValue"), value: formatCurrency(simulation.finalValue, marketId), tone: simulation.totalReturnPercent >= 0 ? "positive" : "negative" },
    { label: t(language, "dca.totalInvested"), value: formatCurrency(simulation.totalInvested, marketId) },
    { label: t(language, "common.totalReturn"), value: formatCurrency(simulation.totalReturn, marketId), delta: formatPercent(simulation.totalReturnPercent), tone: simulation.totalReturnPercent >= 0 ? "positive" : "negative" },
    { label: t(language, "dca.annualized"), value: formatPercent(simulation.annualizedReturn), tone: simulation.annualizedReturn >= 0 ? "positive" : "negative" },
    { label: t(language, "dca.maxDrawdown"), value: formatPercent(simulation.maxDrawdown), tone: "negative" },
    { label: t(language, "dca.totalDividends"), value: formatCurrency(simulation.totalDividends ?? 0, marketId) },
    { label: t(language, "dca.totalFees"), value: formatCurrency(simulation.totalFees ?? 0, marketId) },
    { label: t(language, "dca.avgCost"), value: formatCurrency(simulation.averageCost, marketId) },
  ];
}

function sanitizeCachedDcaResult(result: DcaResultCache | null): DcaResultCache | null {
  if (!result) return null;
  const hasExplicitDividends = Boolean(result.asset.dividends?.length);
  if (hasExplicitDividends || (result.simulation.totalDividends ?? 0) <= 0) return result;
  return {
    ...result,
    simulation: simulateDcaPlan(result.asset, result.input),
  };
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

function saveInput(result: DcaResultCache): DcaInput & { name: string } {
  return {
    ...result.input,
    fundId: result.asset.id,
    name: result.input.name || result.simulation.name,
  };
}

function eventCashFlows(result: DcaResultCache) {
  const explicitDividendDates = new Set((result.asset.dividends ?? []).map((dividend) => dividend.date));
  return result.simulation.cashFlowHistory.filter((row) => {
    if (Math.abs(row.contribution ?? 0) >= 0.005 || Math.abs(row.fee ?? 0) >= 0.005) return true;
    return Math.abs(row.dividend ?? 0) >= 0.005 && explicitDividendDates.has(row.date);
  });
}

function SnapshotRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-zinc-100 pb-1.5 last:border-b-0 dark:border-white/10">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="max-w-40 truncate font-medium text-zinc-950 dark:text-white">{value}</span>
    </div>
  );
}

function CashFlowRow({ row, marketId }: { row: DcaCashFlow; marketId: MarketId }) {
  return (
    <tr>
      <td className="px-4 py-3">{row.date}</td>
      <td className="px-4 py-3 text-right">{formatCashFlowCurrency(row.contribution, marketId)}</td>
      <td className="px-4 py-3 text-right">{formatCashFlowCurrency(row.fee ?? 0, marketId)}</td>
      <td className="px-4 py-3 text-right">{formatCashFlowCurrency(row.dividend ?? 0, marketId)}</td>
      <td className="px-4 py-3 text-right">{formatNumber(row.sharesPurchased, 4)}</td>
      <td className="px-4 py-3 text-right">{formatNumber(row.accumulatedShares, 4)}</td>
      <td className="px-4 py-3 text-right">{formatCurrency(row.portfolioValue, marketId)}</td>
    </tr>
  );
}

function formatCashFlowCurrency(value: number, marketId: MarketId) {
  if (marketId === "us") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }
  return formatCurrency(value, marketId);
}
