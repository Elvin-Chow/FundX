"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Download, FileText, RefreshCw } from "lucide-react";
import { CustomSelect } from "@/components/custom-select";
import { normalizeMarket, type Market } from "../../components/types";
import { useApiResource } from "@/hooks/use-api-resource";
import { useCustomFunds } from "@/hooks/use-custom-funds";
import { useResolvedLanguage } from "@/hooks/use-language";
import { assetDisplayName, localizedAssetSector } from "@/lib/asset-display";
import type { PortfolioResponse } from "@/lib/api-contracts";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/formatters";
import { getMarketCopy, localeForLanguage, t, type Language } from "@/lib/i18n";
import { buildLocalPortfolioResponse } from "@/lib/local-user-data";
import { useMarketStore } from "@/stores/market-store";
import type { CustomFundRecord, CustomFundUniverseItem, MarketId, Portfolio, PortfolioSummary } from "@/lib/types";
import { LoadingRows, PageHeader, Section, StatusBanner } from "../shared/feature-shell";
import { buildCustomFundPdf, buildPortfolioPdf, reportPdfFilename } from "./portfolio-pdf";

type ReportKind = "portfolio" | "customFund";

type ReportSelection = {
  kind: ReportKind;
  id: string;
};

type GeneratedPdf = {
  url: string;
  filename: string;
  createdAt: string;
  title: string;
  kind: ReportKind;
};

export function ReportsPage({ market = "us", marketId, language: languageProp = "en" }: { market?: Market; marketId?: Market; language?: Language }) {
  const activeMarket = normalizeMarket(marketId ?? market);
  const language = useResolvedLanguage(languageProp);
  const darkMode = useMarketStore((state) => state.darkMode);
  const [selection, setSelection] = useState<ReportSelection | null>(null);
  const selectedPortfolioId = selection?.kind === "portfolio" ? selection.id : null;
  const loadPortfolio = useCallback(
    (_signal: AbortSignal) => Promise.resolve(buildLocalPortfolioResponse(activeMarket, selectedPortfolioId) satisfies PortfolioResponse),
    [activeMarket, selectedPortfolioId],
  );
  const portfolioResource = useApiResource(loadPortfolio, [loadPortfolio], { keepPreviousData: true });
  const customFunds = useCustomFunds(activeMarket);
  const portfolios = useMemo(() => portfolioResource.data?.portfolios ?? [], [portfolioResource.data?.portfolios]);
  const customFundRows = useMemo(() => customFunds.data?.customFunds ?? [], [customFunds.data?.customFunds]);
  const selectedPortfolio = selection?.kind === "portfolio" && portfolioResource.data?.portfolio?.id === selection.id ? portfolioResource.data.portfolio : null;
  const selectedSummary = selection?.kind === "portfolio" && portfolioResource.data?.portfolio?.id === selection.id ? portfolioResource.data.summary : null;
  const selectedCustomFund = selection?.kind === "customFund" ? customFundRows.find((fund) => fund.id === selection.id) ?? null : null;
  const [status, setStatus] = useState(t(language, "reports.localOnlyReady"));
  const [generating, setGenerating] = useState(false);
  const [generatedPdf, setGeneratedPdf] = useState<GeneratedPdf | null>(null);
  const loading = portfolioResource.loading || customFunds.loading;

  useEffect(() => {
    setSelection((current) => {
      const currentIsValid = current?.kind === "portfolio"
        ? portfolios.some((portfolio) => portfolio.id === current.id)
        : current?.kind === "customFund"
          ? customFundRows.some((fund) => fund.id === current.id)
          : false;
      if (currentIsValid) return current;
      if (portfolios.length) return { kind: "portfolio", id: portfolios[0].id };
      if (customFundRows.length) return { kind: "customFund", id: customFundRows[0].id };
      return null;
    });
  }, [customFundRows, portfolios]);

  useEffect(() => {
    setGeneratedPdf(null);
    setStatus(t(language, "reports.localOnlyReady"));
  }, [language, selection?.id, selection?.kind]);

  useEffect(() => {
    return () => {
      if (generatedPdf) URL.revokeObjectURL(generatedPdf.url);
    };
  }, [generatedPdf]);

  const selectedTitle = useMemo(() => {
    if (selection?.kind === "portfolio") return selectedPortfolio?.name ?? portfolios.find((portfolio) => portfolio.id === selection.id)?.name ?? "";
    if (selection?.kind === "customFund") return selectedCustomFund?.name ?? "";
    return "";
  }, [portfolios, selectedCustomFund, selectedPortfolio, selection]);

  const canGenerate = selection?.kind === "portfolio" ? Boolean(selectedPortfolio && selectedSummary) : Boolean(selectedCustomFund);

  function selectKind(kind: ReportKind) {
    const nextId = kind === "portfolio" ? portfolios[0]?.id : customFundRows[0]?.id;
    setSelection(nextId ? { kind, id: nextId } : null);
  }

  function selectPlan(kind: ReportKind, id: string) {
    setSelection({ kind, id });
  }

  function generatePdf() {
    if (!selection || !canGenerate) {
      setStatus(t(language, "reports.selectPlanFirst"));
      return;
    }
    setGenerating(true);
    setStatus(t(language, "reports.generatingPdf"));
    try {
      const generatedAt = new Date();
      const filename = reportPdfFilename(selectedTitle, selection.kind, generatedAt);
      const theme = darkMode ? "dark" : "light";
      const blob = selection.kind === "portfolio"
        ? buildPortfolioPdf({
            marketId: activeMarket,
            language,
            portfolio: selectedPortfolio as NonNullable<typeof selectedPortfolio>,
            summary: selectedSummary as NonNullable<typeof selectedSummary>,
            generatedAt,
            theme,
            source: portfolioResource.data?.source,
            updatedAt: portfolioResource.data?.updatedAt,
          })
        : buildCustomFundPdf({
            marketId: activeMarket,
            language,
            fund: selectedCustomFund as CustomFundRecord,
            universe: customFunds.data?.universe ?? [],
            universeCount: customFunds.data?.universeCount,
            generatedAt,
            theme,
          });
      const url = URL.createObjectURL(blob);
      setGeneratedPdf({
        url,
        filename,
        createdAt: new Intl.DateTimeFormat(localeForLanguage(language), { dateStyle: "medium", timeStyle: "short" }).format(generatedAt),
        title: selectedTitle,
        kind: selection.kind,
      });
      setStatus(t(language, "reports.pdfGenerated"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t(language, "reports.generationFailed"));
    } finally {
      setGenerating(false);
    }
  }

  function downloadPdf() {
    if (!generatedPdf) return;
    const anchor = document.createElement("a");
    anchor.href = generatedPdf.url;
    anchor.download = generatedPdf.filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setStatus(t(language, "reports.downloaded", { format: "PDF" }));
  }

  return (
    <div>
      <PageHeader
        eyebrow={t(language, "nav.reports")}
        title={t(language, "reports.title")}
        description={t(language, "reports.subtitle")}
        showDivider={false}
        action={generatedPdf ? (
          <button
            type="button"
            onClick={downloadPdf}
            className="inline-flex h-10 items-center gap-2 rounded border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-950 hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-white dark:hover:bg-white/10"
          >
            <Download size={16} />
            {t(language, "reports.downloadPdf")}
          </button>
        ) : null}
      />

      <Section title={t(language, "reports.chooseSource")} subtitle={t(language, "reports.chooseSourceSubtitle")} flushTop>
        {portfolioResource.error || customFunds.error ? (
          <div className="mb-4">
            <StatusBanner title={portfolioResource.error ?? customFunds.error ?? ""} tone="negative" />
          </div>
        ) : null}

        {loading ? <LoadingRows rows={2} /> : null}
        {!loading && !portfolios.length && !customFundRows.length ? (
          <StatusBanner title={t(language, "reports.noSavedPlansTitle")} body={t(language, "reports.noSavedPlansBody")} />
        ) : null}

        {!loading && (portfolios.length || customFundRows.length) ? (
          <div className="grid gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.03] md:grid-cols-[12rem_minmax(0,1fr)_auto] md:items-end">
            <label className="block min-w-0">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t(language, "common.type")}</span>
              <CustomSelect
                ariaLabel={t(language, "common.type")}
                className="mt-1"
                value={selection?.kind ?? "portfolio"}
                options={[
                  { value: "portfolio", label: `${t(language, "portfolio.savedPortfolios")} (${portfolios.length})`, disabled: !portfolios.length },
                  { value: "customFund", label: `${t(language, "custom.savedFunds")} (${customFundRows.length})`, disabled: !customFundRows.length },
                ]}
                onChange={selectKind}
              />
            </label>
            <label className="block min-w-0">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t(language, "reports.chooseSource")}</span>
              <CustomSelect
                ariaLabel={t(language, "reports.chooseSource")}
                className="mt-1"
                value={selection?.id ?? ""}
                options={(selection?.kind === "customFund" ? customFundRows : portfolios).map((item) => ({ value: item.id, label: item.name }))}
                onChange={(id) => selection ? selectPlan(selection.kind, id) : undefined}
              />
            </label>
            <button
              type="button"
              disabled={!canGenerate || generating}
              onClick={generatePdf}
              className="inline-flex h-10 items-center justify-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
            >
              {generating ? <RefreshCw size={16} className="animate-spin" /> : <FileText size={16} />}
              {generatedPdf ? t(language, "reports.regeneratePdf") : t(language, "reports.generateSelectedPdf")}
            </button>
          </div>
        ) : null}

        {selectedTitle ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
            <span>{t(language, "reports.selectedPlan", { name: selectedTitle })}</span>
            {selection?.kind === "portfolio" && selectedPortfolio ? <span>{t(language, "reports.holdingsCount")}: {formatNumber(selectedPortfolio.holdings.length)}</span> : null}
            {selection?.kind === "customFund" && selectedCustomFund ? <span>{t(language, "custom.style")}: {selectedCustomFund.style}</span> : null}
          </div>
        ) : null}

        {/* The report itself intentionally appears only after generation. */}
      </Section>

      <Section>
        <StatusBanner
          title={status}
          body={t(language, "reports.localOnlyNote")}
          tone={generatedPdf ? "positive" : "neutral"}
        />
      </Section>

      {generatedPdf ? (
        <Section
          title={t(language, "reports.pdfPreview")}
          subtitle={t(language, "reports.pdfPreviewBody", { filename: generatedPdf.filename })}
          action={
            <button type="button" onClick={downloadPdf} className="inline-flex h-10 items-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200">
              <Download size={16} />
              {t(language, "reports.downloadPdf")}
            </button>
          }
        >
          <ReportPaperPreview
            generatedPdf={generatedPdf}
            marketId={activeMarket}
            language={language}
            portfolio={selectedPortfolio}
            summary={selectedSummary}
            customFund={selectedCustomFund}
            universe={customFunds.data?.universe ?? []}
          />
        </Section>
      ) : null}
    </div>
  );
}

function ReportPaperPreview({
  generatedPdf,
  marketId,
  language,
  portfolio,
  summary,
  customFund,
  universe,
}: {
  generatedPdf: GeneratedPdf;
  marketId: MarketId;
  language: Language;
  portfolio: Portfolio | null;
  summary: PortfolioSummary | null;
  customFund: CustomFundRecord | null;
  universe: CustomFundUniverseItem[];
}) {
  if (generatedPdf.kind === "portfolio" && portfolio && summary) {
    return <PortfolioPaperPreview portfolio={portfolio} summary={summary} marketId={marketId} language={language} generatedAt={generatedPdf.createdAt} />;
  }
  if (generatedPdf.kind === "customFund" && customFund) {
    return <CustomFundPaperPreview fund={customFund} universe={universe} marketId={marketId} language={language} generatedAt={generatedPdf.createdAt} />;
  }
  return <StatusBanner title={t(language, "reports.selectPlanFirst")} />;
}

function PortfolioPaperPreview({ portfolio, summary, marketId, language, generatedAt }: { portfolio: Portfolio; summary: PortfolioSummary; marketId: MarketId; language: Language; generatedAt: string }) {
  const reportRange = formatPortfolioReportRange(summary, language);
  const marketName = getMarketCopy(language, marketId).name;
  const weights = summary.holdings.slice(0, 5).map((holding) => ({
    label: holding.symbol,
    name: holding.name,
    weight: holding.currentWeight,
    detail: formatCurrency(holding.marketValue, marketId),
  }));
  const metrics: ReportMetric[] = [
    { label: t(language, "common.totalValue"), value: formatCurrency(summary.totalValue, marketId) },
    { label: t(language, "common.totalGain"), value: formatCurrency(summary.totalGain, marketId), detail: formatPercent(summary.totalGainPercent), tone: toneFromNumber(summary.totalGain) },
    { label: t(language, "common.annualizedReturn"), value: formatPercent(summary.annualizedReturn), tone: toneFromNumber(summary.annualizedReturn) },
    { label: t(language, "compare.maxDrawdown"), value: formatPercent(summary.maxDrawdown), tone: "negative" },
    { label: t(language, "compare.volatility"), value: formatPercent(summary.volatility) },
    { label: t(language, "reports.sharpeRatio"), value: formatNumber(summary.sharpeRatio, 2) },
    { label: t(language, "reports.topHolding"), value: formatWeightValue(summary.topHoldingConcentration) },
  ];

  return (
    <DarkReportShell
      language={language}
      title={reportPreviewTitle(portfolio.name, t(language, "reports.portfolioReport"))}
      generatedAt={generatedAt}
      overview={buildPortfolioOverview(portfolio, summary, marketId, language)}
      metaRows={[
        [t(language, "common.market"), marketName],
        [t(language, "reports.reportRange"), reportRange],
        [t(language, "portfolio.capital"), formatMaybeCurrency(portfolio.capital, marketId)],
        [t(language, "common.totalValue"), formatCurrency(summary.totalValue, marketId)],
        [t(language, "common.risk"), portfolio.riskPreference || t(language, "common.no")],
        [t(language, "common.updated"), portfolio.updatedAt],
      ]}
      weightTitle={t(language, "custom.weight")}
      weights={weights}
      executiveSummary={buildPortfolioExecutiveSummary(portfolio, summary, marketId, language, reportRange)}
    >
      <DarkReportSection title={t(language, "reports.keyMetrics")}>
        <DarkMetricGrid metrics={metrics} />
      </DarkReportSection>
    </DarkReportShell>
  );
}

function CustomFundPaperPreview({ fund, universe, marketId, language, generatedAt }: { fund: CustomFundRecord; universe: CustomFundUniverseItem[]; marketId: MarketId; language: Language; generatedAt: string }) {
  const assetById = new Map(universe.map((asset) => [asset.id, asset]));
  const score = fund.score;
  const backtest = score.backtestHistory ?? [];
  const firstPoint = backtest[0];
  const lastPoint = backtest[backtest.length - 1];
  const backtestReturn = firstPoint && lastPoint && firstPoint.value ? ((lastPoint.value - firstPoint.value) / firstPoint.value) * 100 : 0;
  const reportRange = firstPoint && lastPoint ? `${firstPoint.date} - ${lastPoint.date}` : t(language, "custom.backtestSubtitle");
  const weights = fund.holdings.slice(0, 6).map((holding) => {
    const asset = assetById.get(holding.stockId);
    return {
      label: asset?.symbol ?? holding.stockId,
      name: asset ? assetDisplayName(asset, language) : holding.stockId,
      weight: holding.weight,
      detail: asset ? localizedAssetSector(asset.sector, language) : undefined,
    };
  });
  const metrics: ReportMetric[] = [
    { label: t(language, "common.targetWeight"), value: formatWeightValue(score.totalWeight) },
    { label: t(language, "reports.backtestReturn"), value: formatPercent(backtestReturn, 1), tone: toneFromNumber(backtestReturn) },
    { label: t(language, "compare.dividendYield"), value: formatPercent(score.dividendYield) },
    { label: t(language, "reports.roe"), value: formatPercent(score.roe), tone: toneFromNumber(score.roe) },
    { label: t(language, "compare.volatility"), value: formatPercent(score.volatility) },
    { label: t(language, "compare.maxDrawdown"), value: formatPercent(score.maxDrawdown), tone: "negative" },
    { label: t(language, "custom.valueScore"), value: formatNumber(score.valueScore, 1) },
    { label: t(language, "custom.quality"), value: formatNumber(score.qualityScore, 1) },
    { label: t(language, "custom.dividendScore"), value: formatNumber(score.dividendScore, 1) },
    { label: t(language, "common.riskScore"), value: formatNumber(score.riskScore, 1) },
  ];

  return (
    <DarkReportShell
      language={language}
      title={reportPreviewTitle(fund.name, t(language, "reports.customFundReport"))}
      generatedAt={generatedAt}
      overview={buildCustomFundOverview(fund, backtestReturn, language)}
      metaRows={[
        [t(language, "common.market"), getMarketCopy(language, marketId).name],
        [t(language, "reports.reportRange"), reportRange],
        [t(language, "custom.style"), fund.style],
        [t(language, "reports.version"), formatNumber(fund.version)],
        [t(language, "reports.holdingsCount"), formatNumber(fund.holdings.length)],
        [t(language, "common.updated"), fund.updatedAt],
      ]}
      weightTitle={t(language, "custom.weight")}
      weights={weights}
      executiveSummary={buildCustomFundExecutiveSummary(fund, score, backtestReturn, language, reportRange)}
    >
      <DarkReportSection title={t(language, "reports.scoringBreakdown")}>
        <DarkMetricGrid metrics={metrics} />
      </DarkReportSection>
    </DarkReportShell>
  );
}

type ReportMetric = {
  label: string;
  value: string;
  detail?: string;
  tone?: "positive" | "negative" | "neutral";
};

type ReportWeightRow = {
  label: string;
  name?: string;
  weight: number;
  detail?: string;
};

function DarkReportShell({
  language,
  title,
  generatedAt,
  overview,
  metaRows,
  weightTitle,
  weights,
  executiveSummary,
  children,
}: {
  language: Language;
  title: string;
  generatedAt: string;
  overview: string;
  metaRows: Array<[string, string]>;
  weightTitle: string;
  weights: ReportWeightRow[];
  executiveSummary: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-2 shadow-inner dark:border-zinc-900 dark:bg-[#020807] sm:p-3">
      <article className="mx-auto w-full min-w-[560px] max-w-3xl rounded-lg border border-zinc-200 bg-white px-5 py-5 text-zinc-950 shadow-lg dark:border-zinc-500/70 dark:bg-[#0b1012] dark:text-zinc-100 dark:shadow-2xl">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="inline-flex rounded-full border border-teal-100 bg-teal-50 px-2.5 py-1 text-[11px] font-semibold text-teal-700 dark:border-zinc-700 dark:bg-zinc-900/70 dark:text-teal-200">FUNDX</div>
            <h2 className="mt-3 max-w-2xl break-words text-2xl font-semibold text-zinc-950 dark:text-white md:text-3xl">{title}</h2>
          </div>
          <div className="w-40 shrink-0 rounded-lg border border-zinc-200 bg-white p-3 text-xs shadow-sm dark:border-zinc-700 dark:bg-white/[0.04] dark:shadow-lg">
            <div className="font-semibold text-zinc-950 dark:text-zinc-100">{t(language, "reports.generatedAt")}</div>
            <div className="mt-1.5 leading-5 text-zinc-600 dark:text-zinc-300">{generatedAt}</div>
          </div>
        </header>

        <div className="my-5 h-px bg-zinc-200 dark:bg-zinc-700" />

        <DarkReportSection title={t(language, "reports.reportOverview")}>
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm leading-6 text-zinc-700 dark:border-zinc-700 dark:bg-white/[0.04] dark:text-zinc-300">{overview}</div>
          <DarkMetaGrid rows={metaRows} />
        </DarkReportSection>

        <DarkReportSection title={weightTitle}>
          <DarkWeightRows rows={weights} />
        </DarkReportSection>

        <DarkReportSection title={t(language, "reports.executiveSummary")}>
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm leading-6 text-zinc-700 dark:border-zinc-700 dark:bg-white/[0.04] dark:text-zinc-300">{executiveSummary}</div>
        </DarkReportSection>

        {children}

        <div className="mt-8 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800">{t(language, "reports.localOnlyNote")}</div>
      </article>
    </div>
  );
}

function DarkReportSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="text-base font-semibold text-zinc-950 dark:text-white">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function DarkMetaGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="border-l border-zinc-200 pl-3 dark:border-zinc-700">
          <div className="text-xs font-medium text-teal-700 dark:text-teal-200/70">{label}</div>
          <div className="mt-1 break-words text-sm font-semibold text-zinc-950 dark:text-zinc-100">{value}</div>
        </div>
      ))}
    </div>
  );
}

function DarkWeightRows({ rows }: { rows: ReportWeightRow[] }) {
  if (!rows.length) return <div className="text-sm text-zinc-500 dark:text-zinc-500">-</div>;
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={`${row.label}-${row.name ?? ""}`} className="grid grid-cols-[6rem_minmax(0,1fr)_4.5rem] items-center gap-3 text-sm">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-200">{row.label}</div>
            {row.name ? <div className="truncate text-xs text-zinc-500">{row.name}</div> : null}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-indigo-50 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-600 via-sky-500 to-teal-500 dark:from-indigo-300 dark:via-sky-300 dark:to-teal-300"
              style={{ width: `${clampPercent(row.weight)}%` }}
            />
          </div>
          <div className="text-right">
            <div className="font-mono text-sm text-zinc-900 dark:text-zinc-200">{formatWeightValue(row.weight)}</div>
            {row.detail ? <div className="truncate text-xs text-zinc-500">{row.detail}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function DarkMetricGrid({ metrics }: { metrics: ReportMetric[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {metrics.map((metric) => (
        <div key={metric.label} className="min-w-0 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-white/[0.035]">
          <div className="text-xs font-medium text-zinc-500">{metric.label}</div>
          <div className={`mt-1.5 break-words text-base font-semibold ${metricToneClass(metric.tone)}`}>{metric.value}</div>
          {metric.detail ? <div className={`mt-1 text-sm ${metricToneClass(metric.tone)}`}>{metric.detail}</div> : null}
        </div>
      ))}
    </div>
  );
}

function reportPreviewTitle(name: string, reportType: string) {
  return `${name} ${reportType}`;
}

function buildPortfolioOverview(portfolio: Portfolio, summary: PortfolioSummary, marketId: MarketId, language: Language) {
  const allocation = summary.holdings.slice(0, 4).map((holding) => `${holding.symbol} ${formatWeightValue(holding.currentWeight)}`).join(", ");
  const allocationText = allocation || t(language, "reports.noValueHistory");
  const rangeReturn = formatPercent(summary.rangeGainPercent ?? summary.totalGainPercent);
  if (language === "en") {
    return `Current allocation is ${allocationText}. Portfolio value is ${formatCurrency(summary.totalValue, marketId)}, range return is ${rangeReturn}, and max drawdown is ${formatPercent(summary.maxDrawdown)}.`;
  }
  return `当前配置为 ${allocationText}。组合当前价值 ${formatCurrency(summary.totalValue, marketId)}，区间回报 ${rangeReturn}，最大回撤 ${formatPercent(summary.maxDrawdown)}。${portfolio.goal ? `目标为 ${portfolio.goal}。` : ""}`;
}

function buildPortfolioExecutiveSummary(portfolio: Portfolio, summary: PortfolioSummary, marketId: MarketId, language: Language, reportRange: string) {
  const symbols = summary.holdings.slice(0, 6).map((holding) => holding.symbol).join(", ");
  const topHolding = summary.holdings[0];
  if (language === "en") {
    return `This report covers ${formatNumber(summary.holdings.length)} holdings${symbols ? ` (${symbols})` : ""} over ${reportRange}. Total gain is ${formatCurrency(summary.totalGain, marketId)} (${formatPercent(summary.totalGainPercent)}), volatility is ${formatPercent(summary.volatility)}, and the largest position is ${topHolding ? `${topHolding.symbol} at ${formatWeightValue(topHolding.currentWeight)}` : "-"}.`;
  }
  return `本报告覆盖 ${formatNumber(summary.holdings.length)} 个标的${symbols ? `（${symbols}）` : ""}，分析区间为 ${reportRange}。总收益为 ${formatCurrency(summary.totalGain, marketId)}（${formatPercent(summary.totalGainPercent)}），波动率 ${formatPercent(summary.volatility)}，最大持仓为 ${topHolding ? `${topHolding.symbol} ${formatWeightValue(topHolding.currentWeight)}` : "-"}。${portfolio.riskPreference ? `风险偏好为 ${portfolio.riskPreference}。` : ""}`;
}

function buildCustomFundOverview(fund: CustomFundRecord, backtestReturn: number, language: Language) {
  const score = fund.score;
  if (language === "en") {
    return `The saved custom fund holds ${formatNumber(fund.holdings.length)} constituents with ${formatWeightValue(score.totalWeight)} target weight. Backtest return is ${formatPercent(backtestReturn, 1)}, dividend yield is ${formatPercent(score.dividendYield)}, and max drawdown is ${formatPercent(score.maxDrawdown)}.`;
  }
  return `该自定义基金持有 ${formatNumber(fund.holdings.length)} 个成分，目标权重合计 ${formatWeightValue(score.totalWeight)}。回测收益 ${formatPercent(backtestReturn, 1)}，股息率 ${formatPercent(score.dividendYield)}，最大回撤 ${formatPercent(score.maxDrawdown)}。`;
}

function buildCustomFundExecutiveSummary(fund: CustomFundRecord, score: CustomFundRecord["score"], backtestReturn: number, language: Language, reportRange: string) {
  const symbols = fund.holdings.slice(0, 6).map((holding) => holding.stockId).join(", ");
  if (language === "en") {
    return `This report covers ${formatNumber(fund.holdings.length)} selected securities${symbols ? ` (${symbols})` : ""} over ${reportRange}. The model shows ${formatPercent(backtestReturn, 1)} backtest return, ${formatNumber(score.valueScore, 1)} value score, ${formatNumber(score.qualityScore, 1)} quality score, and ${formatPercent(score.volatility)} volatility.`;
  }
  return `本报告覆盖 ${formatNumber(fund.holdings.length)} 个成分${symbols ? `（${symbols}）` : ""}，样本区间为 ${reportRange}。模型显示回测收益 ${formatPercent(backtestReturn, 1)}，价值评分 ${formatNumber(score.valueScore, 1)}，质量评分 ${formatNumber(score.qualityScore, 1)}，波动率 ${formatPercent(score.volatility)}。`;
}

function formatPortfolioReportRange(summary: PortfolioSummary, language: Language) {
  if (summary.rangeStartDate && summary.rangeEndDate) return `${summary.rangeStartDate} - ${summary.rangeEndDate}`;
  return summary.range ?? t(language, "common.history");
}

function formatMaybeCurrency(value: number | null | undefined, marketId: MarketId) {
  return value == null ? "-" : formatCurrency(value, marketId);
}

function formatWeightValue(value: number, digits = 1) {
  return `${value.toFixed(digits)}%`;
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function toneFromNumber(value: number): ReportMetric["tone"] {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

function metricToneClass(tone: ReportMetric["tone"]) {
  if (tone === "positive") return "text-emerald-600 dark:text-emerald-200";
  if (tone === "negative") return "text-rose-600 dark:text-rose-300";
  return "text-zinc-950 dark:text-zinc-100";
}
