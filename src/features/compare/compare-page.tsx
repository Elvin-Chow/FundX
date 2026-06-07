"use client";

import { useEffect, useMemo, useState } from "react";
import { Calculator, Database, Plus, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { CustomSelect } from "@/components/custom-select";
import { useAssetsSearch } from "@/hooks/use-assets-search";
import { useCalculationRun } from "@/hooks/use-calculation-run";
import { assetDisplayName, assetKindLabel, assetPrimaryCategory, localizedAssetSector, quoteStatusLabel } from "@/lib/asset-display";
import { formatNumber, formatOptionalCurrency, formatOptionalPercent } from "@/lib/formatters";
import { t, type Language } from "@/lib/i18n";
import { createReturnToState } from "@/lib/navigation-state";
import type { AssetRecord, MarketId, SearchSortKey } from "@/lib/types";
import { normalizeMarket, type Market } from "../../components/types";
import { LoadingRows, PageHeader, StatusBanner } from "../shared/feature-shell";
import {
  CalculateButton,
  CalculationStatus,
  FieldLabel,
  SecondaryButton,
  WorkbenchLayout,
  WorkbenchPanel,
  inputClassName,
} from "../shared/calculation-workbench";
import { writeCompareResultCache, type FundCompareResult } from "./compare-result-store";

const MAX_COMPARE_FUNDS = 4;
const FUND_PAGE_SIZE = 12;

const sortOptions: Array<{ value: SearchSortKey; labelKey: string }> = [
  { value: "popularity", labelKey: "discover.sort.popularity" },
  { value: "relevance", labelKey: "discover.sort.relevance" },
  { value: "return", labelKey: "discover.dailyReturn" },
  { value: "size", labelKey: "discover.size" },
  { value: "risk", labelKey: "discover.lowerRisk" },
];

export function ComparePage({
  market = "us",
  marketId,
  initialIds = [],
  language = "en",
}: {
  market?: Market;
  marketId?: Market;
  initialIds?: string[];
  language?: Language;
}) {
  const activeMarket = normalizeMarket(marketId ?? market);
  const navigate = useNavigate();
  const fundSearch = useAssetsSearch(activeMarket, { type: "fund", pageSize: FUND_PAGE_SIZE, sort: "popularity" });
  const setFundSearchFilters = fundSearch.setFilters;
  const calculation = useCalculationRun<FundCompareResult>(activeMarket);
  const resetCalculation = calculation.reset;
  const [selectedIds, setSelectedIds] = useState<string[]>(initialIds.slice(0, MAX_COMPARE_FUNDS));
  const [selectedAssetsById, setSelectedAssetsById] = useState<Record<string, AssetRecord>>({});
  const initialIdsKey = initialIds.join("|");

  useEffect(() => {
    setSelectedIds(initialIdsKey ? initialIdsKey.split("|").slice(0, MAX_COMPARE_FUNDS) : []);
    setSelectedAssetsById({});
    resetCalculation();
    setFundSearchFilters({ q: "", type: "fund", industry: "", fundType: "", sort: "popularity", page: 1 });
  }, [activeMarket, initialIdsKey, resetCalculation, setFundSearchFilters]);

  const fundResults = useMemo(
    () => (fundSearch.data?.items ?? []).filter(isFundAsset),
    [fundSearch.data?.items],
  );
  const fundAssetsById = useMemo(() => new Map(fundResults.map((asset) => [asset.id, asset])), [fundResults]);
  const selectedEntries = selectedIds.map((id) => ({
    id,
    asset: selectedAssetsById[id] ?? fundAssetsById.get(id) ?? calculation.result?.items.find((item) => item.asset.id === id)?.asset,
  }));
  const selectedAssets = selectedEntries.map((entry) => entry.asset).filter(Boolean) as AssetRecord[];
  const fundTypeOptions = useMemo(() => fundSearch.data?.facets?.fundTypes ?? [], [fundSearch.data?.facets?.fundTypes]);
  const fundTypeCounts = useMemo(() => fundSearch.data?.facetCounts?.fundTypes ?? {}, [fundSearch.data?.facetCounts?.fundTypes]);
  const totalResults = fundSearch.data?.total ?? fundResults.length;
  const currentPage = fundSearch.data?.page ?? fundSearch.filters.page;
  const totalPages = fundSearch.data?.totalPages ?? 1;
  const syncedFundCount = fundSearch.data?.stats?.funds ?? fundSearch.data?.total ?? fundResults.length;
  const hasActiveFilters = Boolean(fundSearch.filters.q || fundSearch.filters.industry || fundSearch.filters.fundType || fundSearch.filters.sort !== "popularity");

  function toggleAsset(asset: AssetRecord) {
    setSelectedAssetsById((current) => ({ ...current, [asset.id]: asset }));
    setSelectedIds((current) => {
      if (current.includes(asset.id)) return current.filter((id) => id !== asset.id);
      if (current.length >= MAX_COMPARE_FUNDS) return current;
      return [...current, asset.id];
    });
    calculation.reset();
  }

  function removeAsset(assetId: string) {
    setSelectedIds((current) => current.filter((id) => id !== assetId));
    calculation.reset();
  }

  function clearFilters() {
    fundSearch.setFilters({ q: "", type: "fund", industry: "", fundType: "", sort: "popularity", page: 1 });
  }

  function resetSelection() {
    setSelectedIds([]);
    setSelectedAssetsById({});
    calculation.reset();
  }

  async function runCompare() {
    if (!selectedIds.length) return;
    const response = await calculation.run({
      workflow: "compare",
      assets: selectedIds.map((assetId) => ({ assetId, assetType: selectedAssetsById[assetId]?.assetType ?? "fund" })),
      params: {},
      refresh: true,
    });
    if (!response?.result) return;

    writeCompareResultCache({
      marketId: activeMarket,
      language,
      selectedIds,
      selectedAssets: response.result.items.map((item) => item.asset),
      result: response.result,
    });
    const selectedIdsParam = selectedIds.join(",");
    navigate(`/compare/result?market=${activeMarket}&ids=${selectedIdsParam}&lang=${language}`, {
      state: createReturnToState(`/compare?market=${activeMarket}&ids=${selectedIdsParam}&lang=${language}`),
    });
  }

  return (
    <div>
      <PageHeader
        eyebrow={t(language, "nav.compare")}
        title={t(language, "compare.title")}
        description={t(language, "compare.subtitle")}
        showDivider={false}
        action={
          <div className="inline-flex h-10 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200">
            <Database size={16} className="text-emerald-600" />
            {t(language, "compare.syncedFunds", { count: formatNumber(syncedFundCount) })}
          </div>
        }
      />
      <div>
        <WorkbenchLayout
          align="start"
          pool={
            <WorkbenchPanel
              title={t(language, "compare.fundUniverse")}
              subtitle={t(language, "compare.fundPoolSubtitle")}
              className="flex min-h-[38rem] flex-col xl:h-[40rem]"
            >
              <input
                className={inputClassName}
                placeholder={t(language, "discover.placeholder")}
                value={fundSearch.filters.q}
                onChange={(event) => fundSearch.setFilters({ q: event.target.value, type: "fund" })}
              />
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <FieldLabel label={t(language, "dca.filterIndustry")}>
                  <CustomSelect
                    ariaLabel={t(language, "dca.filterIndustry")}
                    value={fundSearch.filters.industry}
                    options={[
                      { value: "", label: t(language, "common.allSectors") },
                      ...(fundSearch.data?.facets?.sectors ?? []).map((item) => ({ value: item, label: localizedAssetSector(item, language) })),
                    ]}
                    onChange={(industry) => fundSearch.setFilters({ industry, type: "fund" })}
                  />
                </FieldLabel>
                <FieldLabel label={t(language, "dca.filterFundType")}>
                  <CustomSelect
                    ariaLabel={t(language, "dca.filterFundType")}
                    value={fundSearch.filters.fundType}
                    options={[
                      { value: "", label: t(language, "dca.allFundTypes") },
                      ...fundTypeOptions.map((item) => ({
                        value: item,
                        label: `${item}${fundTypeCounts[item] ? ` (${fundTypeCounts[item].toLocaleString()})` : ""}`,
                      })),
                    ]}
                    onChange={(fundType) => fundSearch.setFilters({ fundType, type: "fund" })}
                  />
                </FieldLabel>
                <FieldLabel label={t(language, "dca.sort")}>
                  <CustomSelect
                    ariaLabel={t(language, "dca.sort")}
                    value={fundSearch.filters.sort}
                    options={sortOptions.map((item) => ({ value: item.value, label: t(language, item.labelKey) }))}
                    onChange={(sort) => fundSearch.setFilters({ sort, type: "fund" })}
                  />
                </FieldLabel>
                <div className="flex items-end">
                  {hasActiveFilters ? (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="h-10 w-full rounded border border-zinc-200 px-3 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/10 dark:hover:text-white"
                    >
                      {t(language, "discover.clearFilters")}
                    </button>
                  ) : (
                    <div className="h-10 w-full rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300">
                      {t(language, "common.ready")}
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span>{fundSearch.loading && !fundSearch.data ? t(language, "dca.loadingAssets") : t(language, "dca.assetPoolSummary", { total: totalResults.toLocaleString(), count: fundResults.length.toLocaleString() })}</span>
                <span>{t(language, "assetType.fund")}</span>
              </div>
              <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
                <div className="grid gap-3 md:grid-cols-2">
                  {fundSearch.loading && fundResults.length === 0 ? <AssetCardSkeletons /> : null}
                  {fundResults.map((asset) => {
                    const selected = selectedIds.includes(asset.id);
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => toggleAsset(asset)}
                        className={`min-h-24 rounded-lg border p-3 text-left transition ${selected ? "border-emerald-400 bg-emerald-50 dark:border-emerald-400/50 dark:bg-emerald-400/10" : "border-zinc-200 bg-white hover:border-emerald-300 hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-emerald-400/40 dark:hover:bg-white/[0.06]"}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{assetDisplayName(asset, language)}</div>
                            <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{[asset.symbol, assetKindLabel(asset, language), assetPrimaryCategory(asset, language)].filter(Boolean).join(" · ")}</div>
                          </div>
                          <Plus size={16} className={`shrink-0 ${selected ? "text-emerald-600" : "text-zinc-400"}`} />
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
                {!fundSearch.loading && fundSearch.data && fundResults.length === 0 ? (
                  <div className="mt-3">
                    <StatusBanner title={t(language, "compare.noFundsTitle")} body={t(language, "compare.noFundsBody")} />
                  </div>
                ) : null}
                {!fundSearch.loading && fundSearch.data && totalPages > 1 ? (
                  <div className="mt-3 flex items-center justify-between rounded border border-zinc-200 bg-white p-2 text-xs dark:border-white/10 dark:bg-white/[0.03]">
                    <button
                      type="button"
                      disabled={currentPage <= 1}
                      onClick={() => fundSearch.setPage(currentPage - 1)}
                      className="h-8 rounded border border-zinc-200 px-2 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:text-zinc-200 dark:disabled:text-zinc-500"
                    >
                      {t(language, "common.previous")}
                    </button>
                    <span className="text-zinc-500 dark:text-zinc-400">{t(language, "common.pageOf", { page: currentPage, totalPages })}</span>
                    <button
                      type="button"
                      disabled={currentPage >= totalPages}
                      onClick={() => fundSearch.setPage(currentPage + 1)}
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
              title={t(language, "compare.selectedFundPool")}
              subtitle={t(language, "compare.maxObjects", { count: selectedIds.length })}
              className="flex min-h-[38rem] flex-col xl:h-[40rem]"
            >
              <div className="flex min-h-0 flex-1 flex-col pr-1">
                <SelectedFundSlots entries={selectedEntries} language={language} onRemove={removeAsset} />
                <CompareMetricsPreview selectedAssets={selectedAssets} selectedCount={selectedIds.length} syncedFundCount={syncedFundCount} language={language} />
                <div className="mt-auto pt-4">
                  <CalculationStatus
                    running={calculation.running}
                    error={calculation.error}
                    warnings={calculation.warnings}
                    idle={selectedIds.length ? t(language, "compare.analysisReady") : t(language, "compare.selectAtLeastOne")}
                    success={calculation.data ? t(language, "compare.analysisComplete") : undefined}
                    runningLabel={t(language, "compare.analysisRunning")}
                    warningsLabel={t(language, "portfolio.status.warning")}
                  />
                </div>
              </div>
            </WorkbenchPanel>
          }
          actions={
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-zinc-500 dark:text-zinc-400">{t(language, "compare.selectedFundSummary", { count: selectedIds.length })}</div>
              <div className="flex flex-wrap gap-2">
                <SecondaryButton onClick={resetSelection} disabled={!selectedIds.length}>{t(language, "common.reset")}</SecondaryButton>
                <CalculateButton disabled={!selectedIds.length} running={calculation.running} onClick={runCompare}>
                  <span className="inline-flex items-center gap-2"><Calculator size={16} /> {t(language, "compare.analyze")}</span>
                </CalculateButton>
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
}

function SelectedFundSlots({
  entries,
  language,
  onRemove,
}: {
  entries: Array<{ id: string; asset?: AssetRecord }>;
  language: Language;
  onRemove: (assetId: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-zinc-950 dark:text-white">{t(language, "compare.fundSlots")}</div>
        <div className="text-sm font-semibold text-emerald-600">{entries.length}/4</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: MAX_COMPARE_FUNDS }, (_, index) => {
          const entry = entries[index];
          if (!entry) {
            return (
              <div key={`slot-${index}`} className="min-h-24 rounded-lg border border-dashed border-zinc-200 bg-zinc-50/60 p-3 dark:border-white/10 dark:bg-white/[0.02]">
                <div className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{t(language, "compare.slotLabel", { count: index + 1 })}</div>
                <div className="mt-3 text-sm font-semibold text-zinc-500 dark:text-zinc-400">{entries.length ? t(language, "compare.emptySlot") : index === 0 ? t(language, "compare.selectFundsEmpty") : t(language, "compare.emptySlot")}</div>
              </div>
            );
          }

          return (
            <div key={entry.id} className="min-h-24 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-400/30 dark:bg-emerald-400/10">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{entry.asset ? assetDisplayName(entry.asset, language) : entry.id}</div>
                  <div className="mt-1 truncate text-xs text-zinc-600 dark:text-zinc-300">
                    {entry.asset ? [entry.asset.symbol, assetPrimaryCategory(entry.asset, language)].filter(Boolean).join(" · ") : t(language, "compare.profileLoading")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(entry.id)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-emerald-700 transition hover:bg-white/70 hover:text-zinc-950 dark:text-emerald-300 dark:hover:bg-white/10 dark:hover:text-white"
                  aria-label={`${t(language, "common.remove")} ${entry.asset?.symbol ?? entry.id}`}
                >
                  <X size={15} />
                </button>
              </div>
              {entry.asset ? (
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                  <span className="rounded bg-white/70 px-2 py-1 dark:bg-white/10">{quoteStatusLabel(entry.asset, language)}</span>
                  <span className="rounded bg-white/70 px-2 py-1 dark:bg-white/10">{formatOptionalCurrency(entry.asset.latestPrice)}</span>
                  {entry.asset.dailyChange != null ? <span className="rounded bg-white/70 px-2 py-1 dark:bg-white/10">{formatOptionalPercent(entry.asset.dailyChange)}</span> : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CompareMetricsPreview({
  selectedAssets,
  selectedCount,
  syncedFundCount,
  language,
}: {
  selectedAssets: AssetRecord[];
  selectedCount: number;
  syncedFundCount: number;
  language: Language;
}) {
  const averageDailyChange = average(selectedAssets.map((asset) => asset.dailyChange).filter((value): value is number => value != null));
  const metrics = [
    { label: t(language, "compare.selectedFunds"), value: formatNumber(selectedCount) },
    { label: t(language, "compare.loadedProfiles"), value: formatNumber(selectedAssets.length) },
    { label: t(language, "compare.averageDailyChange"), value: selectedAssets.length ? formatOptionalPercent(averageDailyChange) : "—" },
    { label: t(language, "compare.dividendYield"), value: "—" },
    { label: t(language, "compare.expenseRatio"), value: "—" },
    { label: t(language, "compare.syncedFundProfiles"), value: formatNumber(syncedFundCount) },
  ];

  return (
    <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-zinc-950 dark:text-white">{t(language, "compare.metricsPreview")}</div>
        <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{formatNumber(MAX_COMPARE_FUNDS)} {t(language, "assetType.fund")}</div>
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        {metrics.map((metric) => (
          <div key={metric.label} className="min-h-16 rounded border border-zinc-200 bg-zinc-50/70 p-2.5 dark:border-white/10 dark:bg-white/[0.04]">
            <div className="truncate text-xs font-medium text-zinc-500 dark:text-zinc-400">{metric.label}</div>
            <div className="mt-1 truncate text-base font-semibold tabular-nums text-zinc-950 dark:text-white">{metric.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function average(values: number[]) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return 0;
  return valid.reduce((total, value) => total + value, 0) / valid.length;
}

function AssetCardSkeletons() {
  return (
    <>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="min-h-24 rounded-lg border border-zinc-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.03]">
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

function isFundAsset(asset: AssetRecord) {
  return asset.kind === "fund" || asset.assetType === "fund" || asset.assetType === "etf";
}
