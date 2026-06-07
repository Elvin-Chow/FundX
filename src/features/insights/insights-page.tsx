"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Brain, CheckCircle2, ChevronDown, Filter, History, Plus, Save, SlidersHorizontal } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { CustomSelect } from "@/components/custom-select";
import { useApiResource } from "@/hooks/use-api-resource";
import { useAssetsSearch } from "@/hooks/use-assets-search";
import { useCalculationRun } from "@/hooks/use-calculation-run";
import { usePortfolio } from "@/hooks/use-portfolio";
import { assetDisplayName, assetKindLabel, assetPrimaryCategory, localizedAssetSector, quoteStatusLabel } from "@/lib/asset-display";
import { formatNumber, formatOptionalCurrency, formatOptionalPercent } from "@/lib/formatters";
import { t, type Language } from "@/lib/i18n";
import { localInsightRecommendations, saveLocalInsightRecommendation } from "@/lib/local-user-data";
import { createReturnToState, locationToReturnTo } from "@/lib/navigation-state";
import type { AssetRecord, SearchSortKey } from "@/lib/types";
import { normalizeMarket, type Market } from "../../components/types";
import { PageHeader } from "../shared/feature-shell";
import {
  CalculateButton,
  CalculationStatus,
  FieldLabel,
  SecondaryButton,
  SelectedAssetList,
  WorkbenchLayout,
  WorkbenchPanel,
  inputClassName,
} from "../shared/calculation-workbench";
import {
  savedRecommendationToInsightsResult,
  writeInsightsResultCache,
  type InsightsResult,
  type RiskProfile,
  type SavedRecommendation,
  type SavedRecommendationResponse,
} from "./insights-result-store";

const sortOptions: Array<{ value: SearchSortKey; labelKey: string }> = [
  { value: "popularity", labelKey: "discover.sort.popularity" },
  { value: "relevance", labelKey: "discover.sort.relevance" },
  { value: "return", labelKey: "discover.dailyReturn" },
  { value: "size", labelKey: "discover.size" },
  { value: "risk", labelKey: "discover.lowerRisk" },
];

const riskProfiles: RiskProfile[] = ["balanced", "conservative", "growth", "income"];
const assetTypes: Array<"all" | "stock" | "fund"> = ["all", "stock", "fund"];

export function InsightsPage({ market = "us", marketId, language = "en" }: { market?: Market; marketId?: Market; language?: Language }) {
  const activeMarket = normalizeMarket(marketId ?? market);
  const location = useLocation();
  const navigate = useNavigate();
  const portfolio = usePortfolio(activeMarket);
  const search = useAssetsSearch(activeMarket, { pageSize: 12, sort: "popularity", type: "all" });
  const calculation = useCalculationRun<InsightsResult>(activeMarket);
  const loadSaved = useCallback(
    (_signal: AbortSignal) => Promise.resolve({
      marketId: activeMarket,
      recommendations: localInsightRecommendations(activeMarket, 8) as unknown as SavedRecommendation[],
    } satisfies SavedRecommendationResponse),
    [activeMarket],
  );
  const savedResource = useApiResource(loadSaved, [loadSaved], { keepPreviousData: true });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedAssetMap, setSelectedAssetMap] = useState<Record<string, AssetRecord>>({});
  const [riskProfile, setRiskProfile] = useState<RiskProfile>("balanced");
  const [simulationCount, setSimulationCount] = useState("12000");
  const [includeSelectedAssets, setIncludeSelectedAssets] = useState(true);
  const [saveRecommendation, setSaveRecommendation] = useState(true);
  const selectedAssets = selectedIds.map((id) => selectedAssetMap[id]).filter(Boolean);
  const savedRows = savedResource.data?.recommendations ?? [];
  const assetResults = search.data?.items ?? [];
  const totalAssets = search.data?.filteredStats?.total ?? search.data?.stats?.total ?? search.data?.total ?? 0;
  const sectorOptions = search.data?.facets?.sectors ?? [];
  const sectorCounts = search.data?.facetCounts?.sectors ?? {};
  const fundTypeOptions = search.data?.facets?.fundTypes ?? [];
  const fundTypeCounts = search.data?.facetCounts?.fundTypes ?? {};

  const analyzeLabel = useMemo(() => {
    if (calculation.running) return t(language, "insights.analyzing");
    return t(language, "insights.analyze");
  }, [calculation.running, language]);

  function toggleAsset(asset: AssetRecord) {
    setSelectedAssetMap((current) => ({ ...current, [asset.id]: asset }));
    setSelectedIds((current) => current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id]);
    calculation.reset();
  }

  function removeAsset(assetId: string) {
    setSelectedIds((current) => current.filter((id) => id !== assetId));
    calculation.reset();
  }

  function resetWorkbench() {
    setSelectedIds([]);
    setSelectedAssetMap({});
    calculation.reset();
  }

  async function runInsights() {
    const input = {
      riskProfile,
      simulationCount: numericInput(simulationCount, 12000),
      includeSelectedAssets,
      saveRecommendation,
      selectedAssets,
    };
    const response = await calculation.run({
      workflow: "insights",
      assets: selectedAssets.map((asset) => ({ assetId: asset.id, assetType: asset.assetType })),
      params: {
        scope: "database",
        portfolioId: portfolio.activePortfolioId,
        riskProfile: input.riskProfile,
        simulationCount: input.simulationCount,
        includeSelectedAssets: input.includeSelectedAssets,
        saveRecommendation: false,
        language,
      },
      refresh: false,
    });
    if (!response?.result) return;
    const nextResult = { ...response.result };
    if (input.saveRecommendation) {
      const saved = saveLocalInsightRecommendation(activeMarket, defaultRecommendationTitle(language), nextResult) as SavedRecommendation;
      nextResult.savedRecommendation = saved;
      nextResult.savedRecommendations = [saved, ...(savedResource.data?.recommendations ?? [])].slice(0, 8);
      await savedResource.refresh("reload");
    }
    writeInsightsResultCache({
      marketId: activeMarket,
      language,
      input,
      result: nextResult,
    });
    navigate(`/insights/result?market=${activeMarket}&lang=${language}`, { state: createReturnToState(locationToReturnTo(location)) });
  }

  function openSavedRecommendation(record: SavedRecommendation) {
    writeInsightsResultCache({
      marketId: activeMarket,
      language,
      input: {
        riskProfile: record.simulationSummary.riskProfile,
        simulationCount: record.simulationSummary.simulationCount,
        holdingsCount: record.simulationSummary.holdingsCount,
        maxPosition: record.simulationSummary.maxPosition,
        includeSelectedAssets: Boolean(record.simulationSummary.includedAnchorCount),
        saveRecommendation: true,
        selectedAssets: [],
      },
      result: savedRecommendationToInsightsResult(record),
    });
    navigate(`/insights/result?market=${activeMarket}&lang=${language}`, { state: createReturnToState(locationToReturnTo(location)) });
  }

  return (
    <div>
      <PageHeader eyebrow={t(language, "nav.insights")} title={t(language, "insights.title")} description={t(language, "insights.subtitle")} showDivider={false} />
      <WorkbenchLayout
        align="start"
        pool={
          <WorkbenchPanel
            title={t(language, "insights.assetPool")}
            subtitle={t(language, "insights.assetPoolSubtitle", { total: formatNumber(totalAssets) })}
            className="flex min-h-[38rem] flex-col xl:h-[42rem]"
          >
            <input
              className={inputClassName}
              placeholder={t(language, "discover.placeholder")}
              value={search.filters.q}
              onChange={(event) => search.setFilters({ q: event.target.value })}
            />
            <details open className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50/70 dark:border-white/10 dark:bg-white/[0.04]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-semibold text-zinc-950 dark:text-white">
                <span className="inline-flex items-center gap-2"><Filter size={15} className="text-emerald-600" /> {t(language, "common.filter")}</span>
                <ChevronDown size={16} className="text-zinc-400" />
              </summary>
              <div className="grid gap-2 border-t border-zinc-200 p-3 dark:border-white/10 sm:grid-cols-2">
                <FieldLabel label={t(language, "common.asset")}>
                  <CustomSelect
                    ariaLabel={t(language, "common.asset")}
                    value={search.filters.type}
                    options={assetTypes.map((type) => ({ value: type, label: t(language, `assetType.${type}`) }))}
                    onChange={(type) => {
                      search.setFilters({ type, page: 1, fundType: type === "stock" ? "" : search.filters.fundType });
                    }}
                  />
                </FieldLabel>
                <FieldLabel label={t(language, "dca.sort")}>
                  <CustomSelect
                    ariaLabel={t(language, "dca.sort")}
                    value={search.filters.sort}
                    options={sortOptions.map((item) => ({ value: item.value, label: t(language, item.labelKey) }))}
                    onChange={(sort) => search.setFilters({ sort })}
                  />
                </FieldLabel>
                <FieldLabel label={t(language, "dca.filterIndustry")}>
                  <CustomSelect
                    ariaLabel={t(language, "dca.filterIndustry")}
                    value={search.filters.industry}
                    options={[
                      { value: "", label: t(language, "common.allSectors") },
                      ...sectorOptions.map((item) => ({
                        value: item,
                        label: `${localizedAssetSector(item, language)}${sectorCounts[item] ? ` (${formatNumber(sectorCounts[item])})` : ""}`,
                      })),
                    ]}
                    onChange={(industry) => search.setFilters({ industry })}
                  />
                </FieldLabel>
                <FieldLabel label={t(language, "dca.filterFundType")}>
                  <CustomSelect
                    ariaLabel={t(language, "dca.filterFundType")}
                    value={search.filters.fundType}
                    options={[
                      { value: "", label: t(language, "dca.allFundTypes") },
                      ...fundTypeOptions.map((item) => ({
                        value: item,
                        label: `${item}${fundTypeCounts[item] ? ` (${formatNumber(fundTypeCounts[item])})` : ""}`,
                      })),
                    ]}
                    onChange={(fundType) => search.setFilters({ fundType })}
                  />
                </FieldLabel>
              </div>
            </details>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span>{search.loading && !search.data ? t(language, "dca.loadingAssets") : t(language, "dca.assetPoolSummary", { total: formatNumber(search.data?.total ?? totalAssets), count: formatNumber(assetResults.length) })}</span>
              {(search.filters.q || search.filters.industry || search.filters.fundType || search.filters.sort !== "popularity" || search.filters.type !== "all") ? (
                <button
                  type="button"
                  onClick={() => search.setFilters({ q: "", type: "all", industry: "", fundType: "", sort: "popularity", page: 1 })}
                  className="font-medium text-zinc-700 hover:text-emerald-600 dark:text-zinc-300 dark:hover:text-emerald-300"
                >
                  {t(language, "discover.clearFilters")}
                </button>
              ) : null}
            </div>
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="grid gap-3 md:grid-cols-2">
                {search.loading && assetResults.length === 0 ? <AssetCardSkeletons /> : null}
                {assetResults.map((asset) => {
                  const selected = selectedIds.includes(asset.id);
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() => toggleAsset(asset)}
                      className={`min-h-28 rounded-lg border p-3 text-left transition ${selected ? "border-emerald-400 bg-emerald-50 dark:border-emerald-400/50 dark:bg-emerald-400/10" : "border-zinc-200 bg-white hover:border-emerald-300 hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-emerald-400/40 dark:hover:bg-white/[0.06]"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{assetDisplayName(asset, language)}</div>
                          <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{[asset.symbol, assetKindLabel(asset, language), assetPrimaryCategory(asset, language)].filter(Boolean).join(" · ")}</div>
                        </div>
                        {selected ? <CheckCircle2 size={17} className="shrink-0 text-emerald-600" /> : <Plus size={16} className="shrink-0 text-zinc-400" />}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                        <span className="rounded bg-zinc-100 px-2 py-1 dark:bg-white/10">{quoteStatusLabel(asset, language)}</span>
                        <span className="rounded bg-zinc-100 px-2 py-1 dark:bg-white/10">{formatOptionalCurrency(asset.latestPrice, activeMarket)}</span>
                        {asset.dailyChange != null ? <span className="rounded bg-zinc-100 px-2 py-1 dark:bg-white/10">{formatOptionalPercent(asset.dailyChange)}</span> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
              {!search.loading && search.data && search.data.totalPages > 1 ? (
                <div className="mt-3 flex items-center justify-between rounded border border-zinc-200 bg-white p-2 text-xs dark:border-white/10 dark:bg-white/[0.03]">
                  <button
                    type="button"
                    disabled={search.data.page <= 1}
                    onClick={() => search.setPage(search.data?.page ? search.data.page - 1 : 1)}
                    className="h-8 rounded border border-zinc-200 px-2 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:text-zinc-200 dark:disabled:text-zinc-500"
                  >
                    {t(language, "common.previous")}
                  </button>
                  <span className="text-zinc-500 dark:text-zinc-400">{t(language, "common.pageOf", { page: search.data.page, totalPages: search.data.totalPages })}</span>
                  <button
                    type="button"
                    disabled={search.data.page >= search.data.totalPages}
                    onClick={() => search.setPage(search.data?.page ? search.data.page + 1 : 1)}
                    className="h-8 rounded border border-zinc-200 px-2 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:text-zinc-200 dark:disabled:text-zinc-500"
                  >
                    {t(language, "common.next")}
                  </button>
                </div>
              ) : null}
            </div>
          </WorkbenchPanel>
        }
        controls={
          <WorkbenchPanel
            title={t(language, "insights.console")}
            subtitle={t(language, "insights.consoleSubtitle")}
            className="flex min-h-[38rem] flex-col xl:h-[42rem]"
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
              <SelectedAssetList
                assets={selectedAssets}
                language={language}
                emptyLabel={t(language, "insights.selectedEmpty")}
                onRemove={removeAsset}
              />
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <FieldLabel label={t(language, "insights.riskProfile")}>
                  <CustomSelect
                    ariaLabel={t(language, "insights.riskProfile")}
                    value={riskProfile}
                    options={riskProfiles.map((profile) => ({ value: profile, label: t(language, `insights.profile.${profile}`) }))}
                    onChange={setRiskProfile}
                  />
                </FieldLabel>
                <FieldLabel label={t(language, "insights.simulationCount")}>
                  <input type="number" min="500" max="50000" step="500" className={inputClassName} value={simulationCount} onChange={(event) => setSimulationCount(event.target.value)} />
                </FieldLabel>
              </div>
              <div className="mt-4 grid gap-2">
                <ToggleRow
                  checked={includeSelectedAssets}
                  label={t(language, "insights.includeSelected")}
                  icon={<SlidersHorizontal size={16} />}
                  onChange={setIncludeSelectedAssets}
                />
                <ToggleRow
                  checked={saveRecommendation}
                  label={t(language, "insights.saveRecommendation")}
                  icon={<Save size={16} />}
                  onChange={setSaveRecommendation}
                />
              </div>
              <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 lg:grid-cols-4">
                <PreviewMetric label={t(language, "insights.databaseAssets")} value={formatNumber(totalAssets)} />
                <PreviewMetric label={t(language, "insights.simulationCount")} value={formatNumber(numericInput(simulationCount, 12000))} />
                <PreviewMetric label={t(language, "insights.selectedAssets")} value={formatNumber(selectedAssets.length)} />
                <PreviewMetric label={t(language, "insights.riskProfile")} value={t(language, `insights.profile.${riskProfile}`)} />
              </div>
              <div className="mt-5">
                <SavedRecommendationList rows={savedRows} loading={savedResource.loading} language={language} onSelect={openSavedRecommendation} />
              </div>
              <DecisionConsoleSnapshot
                language={language}
                totalAssets={totalAssets}
                candidatePoolSize={Math.min(totalAssets, 420)}
                selectedCount={selectedAssets.length}
                simulationCount={numericInput(simulationCount, 12000)}
                riskProfileLabel={t(language, `insights.profile.${riskProfile}`)}
                includeSelectedAssets={includeSelectedAssets}
                saveRecommendation={saveRecommendation}
              />
              <div className="pt-4">
                <CalculationStatus
                  running={calculation.running}
                  error={calculation.error ?? savedResource.error}
                  warnings={calculation.warnings}
                  idle={t(language, "insights.simulationReady")}
                  runningLabel={t(language, "insights.analyzing")}
                />
              </div>
            </div>
          </WorkbenchPanel>
        }
        actions={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-zinc-500 dark:text-zinc-400">
              {selectedAssets.length ? `${formatNumber(selectedAssets.length)} ${t(language, "insights.selectedAssets")}` : t(language, "insights.assetPool")}
            </div>
            <div className="flex flex-wrap gap-2">
              <SecondaryButton onClick={resetWorkbench}>{t(language, "common.reset")}</SecondaryButton>
              <CalculateButton running={calculation.running} onClick={runInsights}>
                <span className="inline-flex items-center gap-2"><Brain size={16} /> {analyzeLabel}</span>
              </CalculateButton>
            </div>
          </div>
        }
      />
    </div>
  );
}

function defaultRecommendationTitle(language: Language) {
  const date = new Date().toISOString().slice(0, 10);
  if (language === "zh-CN") return `智能建议 ${date}`;
  if (language === "zh-TW") return `智能建議 ${date}`;
  return `Insight recommendation ${date}`;
}

function DecisionConsoleSnapshot({
  language,
  totalAssets,
  candidatePoolSize,
  selectedCount,
  simulationCount,
  riskProfileLabel,
  includeSelectedAssets,
  saveRecommendation,
}: {
  language: Language;
  totalAssets: number;
  candidatePoolSize: number;
  selectedCount: number;
  simulationCount: number;
  riskProfileLabel: string;
  includeSelectedAssets: boolean;
  saveRecommendation: boolean;
}) {
  const rows = [
    { label: t(language, "insights.databaseAssets"), value: formatNumber(totalAssets), width: 100 },
    { label: t(language, "insights.shortlistedAssets"), value: formatNumber(candidatePoolSize), width: totalAssets ? Math.max(8, (candidatePoolSize / totalAssets) * 100) : 0 },
    { label: t(language, "insights.simulationCount"), value: formatNumber(simulationCount), width: 74 },
    { label: t(language, "insights.selectedAssets"), value: formatNumber(selectedCount), width: selectedCount ? Math.min(100, 18 + selectedCount * 10) : 8 },
  ];

  return (
    <div className="mt-5 flex flex-1 flex-col rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-white/10 dark:bg-white/[0.04]">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-zinc-950 dark:text-white">{t(language, "insights.consoleSnapshot")}</div>
        <span className="shrink-0 rounded bg-white px-2 py-1 text-xs font-medium text-zinc-500 dark:bg-white/10 dark:text-zinc-300">{riskProfileLabel}</span>
      </div>
      <div className="mt-3 grid gap-2">
        {rows.map((row) => (
          <div key={row.label} className="rounded border border-white bg-white/80 px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate font-medium text-zinc-500 dark:text-zinc-400">{row.label}</span>
              <span className="font-semibold text-zinc-950 dark:text-white">{row.value}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/10">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, Math.max(0, row.width))}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-auto grid gap-2 pt-3 sm:grid-cols-2">
        <SnapshotFlag label={t(language, "insights.includeSelected")} value={includeSelectedAssets ? t(language, "common.yes") : t(language, "common.no")} />
        <SnapshotFlag label={t(language, "insights.saveRecommendation")} value={saveRecommendation ? t(language, "common.yes") : t(language, "common.no")} />
      </div>
    </div>
  );
}

function SnapshotFlag({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border border-white bg-white/80 px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]">
      <div className="truncate text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-zinc-950 dark:text-white">{value}</div>
    </div>
  );
}

function SavedRecommendationList({
  rows,
  loading,
  language,
  onSelect,
}: {
  rows: SavedRecommendation[];
  loading: boolean;
  language: Language;
  onSelect: (record: SavedRecommendation) => void;
}) {
  return (
    <details className="group rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-white">
          <History size={16} className="text-emerald-600" />
          {t(language, "insights.savedRuns")}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {loading ? <span className="text-xs text-zinc-400">{t(language, "common.loading")}</span> : <span className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-500 dark:bg-white/10 dark:text-zinc-300">{formatNumber(rows.length)}</span>}
          <ChevronDown size={16} className="text-zinc-400 transition group-open:rotate-180" />
        </div>
      </summary>
      <div className="border-t border-zinc-100 dark:border-white/10">
        {!rows.length ? <div className="p-3 text-sm text-zinc-500 dark:text-zinc-400">{t(language, "insights.savedEmpty")}</div> : null}
        {rows.slice(0, 5).map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => onSelect(row)}
            className="block w-full border-b border-zinc-100 px-3 py-2 text-left last:border-b-0 hover:bg-zinc-50 dark:border-white/10 dark:hover:bg-white/[0.06]"
          >
            <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{row.title}</div>
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span>{formatDateTime(row.createdAt)}</span>
              <span>{formatNumber(row.simulationSummary?.completedSimulations ?? 0)} {t(language, "insights.simulationCount")}</span>
              <span>{formatNumber(row.strategies?.length ?? 0)} {t(language, "insights.plans")}</span>
            </div>
          </button>
        ))}
      </div>
    </details>
  );
}

function ToggleRow({ checked, label, icon, onChange }: { checked: boolean; label: string; icon: ReactNode; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200">
      <span className="flex min-w-0 items-center gap-2">
        <span className="text-emerald-600">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      <input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-zinc-950 dark:text-white">{value}</div>
    </div>
  );
}

function AssetCardSkeletons() {
  return (
    <>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="min-h-28 rounded-lg border border-zinc-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
          <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
          <div className="mt-5 flex gap-2">
            <div className="h-6 w-20 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
            <div className="h-6 w-16 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
            <div className="h-6 w-14 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
          </div>
        </div>
      ))}
    </>
  );
}

function numericInput(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
