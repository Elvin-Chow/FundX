"use client";

import { useCallback } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCalculationRun } from "@/hooks/use-calculation-run";
import { apiGet } from "@/lib/api-client";
import { formatOptionalCompactCurrency, formatOptionalPercent } from "@/lib/formatters";
import { t, type Language } from "@/lib/i18n";
import { readReturnToState } from "@/lib/navigation-state";
import type { Fund, MarketId } from "@/lib/types";
import { AllocationDonut, LineChart } from "../../components/charts";
import { normalizeMarket, type Market } from "../../components/types";
import { LoadingRows, MetricStrip, PageHeader, Section, StatusBanner } from "../shared/feature-shell";
import { SecondaryButton } from "../shared/calculation-workbench";
import { FundActionPanel } from "./fund-action-panel";
import { useApiResource } from "@/hooks/use-api-resource";

type FundDetailResponse = {
  marketId: MarketId;
  source: string;
  updatedAt?: string;
  fund: Fund;
  calculated?: {
    volatility?: number;
    drawdown?: unknown;
  };
};

export function FundDetailPage({ market = "us", marketId, fundId, language = "en" }: { market?: Market; marketId?: Market; fundId: string; language?: Language }) {
  const activeMarket = normalizeMarket(marketId ?? market);
  const location = useLocation();
  const navigate = useNavigate();
  const calculation = useCalculationRun(activeMarket);
  const load = useCallback(
    (signal: AbortSignal) => apiGet<FundDetailResponse>(`/api/funds/${fundId}`, { market: activeMarket }, signal),
    [activeMarket, fundId],
  );
  const resource = useApiResource(load, [load], { keepPreviousData: false });
  const fund = resource.data?.fund;
  const backHref = readReturnToState(location.state, `/discover?market=${activeMarket}&lang=${language}`);
  const backButton = (
    <div className="mb-5">
      <SecondaryButton onClick={() => navigate(backHref)}>
        <span className="inline-flex items-center gap-2"><ArrowLeft size={16} /> {t(language, "dca.back")}</span>
      </SecondaryButton>
    </div>
  );

  if (resource.loading) {
    return (
      <div>
        {backButton}
        <PageHeader eyebrow={t(language, "common.loading")} title={t(language, "fund.detailLoadingTitle")} description={t(language, "fund.detailLoadingBody")} />
        <Section>
          <LoadingRows rows={4} />
        </Section>
      </div>
    );
  }

  if (!fund || resource.error) {
    return (
      <div>
        {backButton}
        <PageHeader
          eyebrow={t(language, "fund.unavailableEyebrow")}
          title={t(language, "fund.unavailableTitle")}
          description={t(language, "fund.unavailableBody")}
        />
        <Section>
          <StatusBanner title={resource.error ?? "Fund was not found."} tone="negative" />
          <Link to={`/discover?market=${activeMarket}&lang=${language}`} className="mt-4 inline-flex h-10 items-center rounded bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200">
            {t(language, "fund.openDiscover")}
          </Link>
        </Section>
      </div>
    );
  }

  const drawdown = resource.data?.calculated?.drawdown as { maxDrawdown?: number } | undefined;
  const metrics = [
    { label: t(language, "fund.nav"), value: formatOptionalCompactCurrency(fund.nav, activeMarket), delta: formatOptionalPercent(fund.dailyChange), tone: fund.dailyChange >= 0 ? "positive" as const : "negative" as const },
    { label: t(language, "fund.maxDrawdown"), value: drawdown?.maxDrawdown == null ? "—" : `${drawdown.maxDrawdown}%`, tone: "negative" as const },
  ];

  return (
    <div>
      {backButton}
      <PageHeader
        eyebrow={`${fund.symbol} · ${fund.type}`}
        title={fund.name}
        description={[fund.category, fund.style].filter(Boolean).join(" · ")}
        action={
          <button
            type="button"
            onClick={() => {
              void calculation.run({
                workflow: "fund-detail",
                assets: [{ assetId: fund.id, assetType: "fund" }],
                params: {},
                refresh: true,
              }).then(() => resource.refresh("reload"));
            }}
            disabled={calculation.running}
            className="inline-flex h-10 items-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
          >
            <RefreshCw size={16} className={calculation.running ? "animate-spin" : ""} />
            {t(language, "common.refreshPublicData")}
          </button>
        }
      />
      {calculation.error || calculation.warnings.length ? (
        <Section>
          <StatusBanner title={calculation.error ?? "Fund calculation completed with warnings."} body={calculation.warnings.map((warning) => warning.message).join(" ")} tone={calculation.error ? "negative" : "neutral"} />
        </Section>
      ) : null}
      <Section>
        {fund.navHistory.length ? <LineChart data={fund.navHistory} /> : <StatusBanner title={t(language, "asset.noHistoryTitle")} body={t(language, "asset.noHistoryBody")} />}
      </Section>
      <MetricStrip metrics={metrics} />
      {fund.sectorExposure.length ? (
        <Section title={t(language, "fund.allocation")}>
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.03]">
            <AllocationDonut data={fund.sectorExposure.map((item) => ({ label: item.name, value: item.weight * 100 }))} />
          </div>
        </Section>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {fund.holdings.length ? <Section title={t(language, "fund.topHoldings")}>
          <div className="divide-y divide-zinc-100 border border-zinc-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.03]">
            {fund.holdings.map((holding) => (
              <div key={holding.symbol} className="grid grid-cols-[1fr_5rem_5rem] items-center gap-3 p-4 text-sm">
                <div>
                  <div className="font-medium text-zinc-950 dark:text-white">{holding.name}</div>
                  <div className="mt-1 text-zinc-500 dark:text-zinc-400">{holding.symbol} · {holding.sector}</div>
                </div>
                <div className="text-right text-zinc-500 dark:text-zinc-400">{t(language, "custom.weight")}</div>
                <div className="text-right font-semibold tabular-nums text-zinc-950 dark:text-white">{(holding.weight * 100).toFixed(1)}%</div>
              </div>
            ))}
          </div>
        </Section> : null}
        <Section title={t(language, "fund.nextStep")}>
          <FundActionPanel marketId={activeMarket} fund={{ id: fund.id, symbol: fund.symbol }} language={language} />
        </Section>
      </div>
    </div>
  );
}
