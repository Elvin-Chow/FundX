"use client";

import { useEffect, useMemo, useState } from "react";
import { Calculator, CalendarClock, ChevronRight, Plus, Save, Trash2, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { CustomSelect } from "@/components/custom-select";
import { useAssetsSearch } from "@/hooks/use-assets-search";
import { useCalculationRun } from "@/hooks/use-calculation-run";
import { useCustomFunds } from "@/hooks/use-custom-funds";
import { useResolvedLanguage } from "@/hooks/use-language";
import { assetDisplayName, assetKindLabel, assetPrimaryCategory, localizedAssetSector, quoteStatusLabel } from "@/lib/asset-display";
import { apiErrorMessage } from "@/lib/api-client";
import { formatCurrency, formatNumber, formatOptionalCurrency, formatOptionalPercent, formatPercent } from "@/lib/formatters";
import { t, type Language } from "@/lib/i18n";
import { createReturnToState, locationToReturnTo } from "@/lib/navigation-state";
import type { AssetRecord, CustomFundRecord, CustomFundUniverseItem, MarketId, PortfolioDcaPlan, SearchSortKey } from "@/lib/types";
import {
  CalculateButton,
  CalculationStatus,
  FieldLabel,
  SecondaryButton,
  WorkbenchLayout,
  WorkbenchPanel,
  inputClassName,
} from "../shared/calculation-workbench";
import { clearCustomFundDraftCache, readCustomFundDraftCache, writeCustomFundDraftCache } from "./custom-fund-draft-store";
import { writeCustomFundResultCache, type CustomFundCalculationResult } from "./custom-fund-result-store";

type CustomFundDraft = {
  name: string;
  style: string;
  capital: string;
  cashBalance: string;
  startDate: string;
  endDate: string;
};

const stockSortOptions: Array<{ value: SearchSortKey; labelKey: string }> = [
  { value: "popularity", labelKey: "discover.sort.popularity" },
  { value: "relevance", labelKey: "discover.sort.relevance" },
  { value: "return", labelKey: "discover.dailyReturn" },
  { value: "size", labelKey: "discover.size" },
  { value: "risk", labelKey: "discover.lowerRisk" },
];

const STOCK_PAGE_SIZE = 12;
const DEFAULT_CAPITAL = 100000;
const LEGACY_DEFAULT_INITIAL_AMOUNT = 1000;
const DEFAULT_RECURRING_AMOUNT = 500;

export function CustomFundBuilder({ marketId, language: languageProp = "en" }: { marketId: MarketId; language?: Language }) {
  const language = useResolvedLanguage(languageProp);
  const location = useLocation();
  const navigate = useNavigate();
  const customFunds = useCustomFunds(marketId);
  const stockSearch = useAssetsSearch(marketId, { type: "stock", pageSize: STOCK_PAGE_SIZE, sort: "popularity" });
  const setStockSearchFilters = stockSearch.setFilters;
  const calculation = useCalculationRun<CustomFundCalculationResult>(marketId);
  const resetCalculation = calculation.reset;
  const defaultName = t(language, "custom.defaultName");
  const defaultStyle = t(language, "custom.defaultStyle");
  const savedFunds = customFunds.data?.customFunds ?? [];
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedAssetMap, setSelectedAssetMap] = useState<Record<string, AssetRecord>>({});
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [dcaPlans, setDcaPlans] = useState<Record<string, PortfolioDcaPlan>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [status, setStatus] = useState(t(language, "custom.status.synced"));
  const [savingDraft, setSavingDraft] = useState(false);
  const [deletingFund, setDeletingFund] = useState(false);
  const [draft, setDraft] = useState<CustomFundDraft>({
    name: defaultName,
    style: defaultStyle,
    capital: "100000",
    cashBalance: "0",
    startDate: "",
    endDate: new Date().toISOString().slice(0, 10),
  });

  useEffect(() => {
    const cached = readCustomFundDraftCache(marketId);
    if (cached) {
      setEditingId(cached.editingId);
      setSelectedIds(cached.selectedAssets.map((asset) => asset.id));
      setSelectedAssetMap(Object.fromEntries(cached.selectedAssets.map((asset) => [asset.id, asset])));
      setWeights(cached.weights);
      setDcaPlans(ensureDcaPlansForAssets(cached.dcaPlans, cached.selectedAssets, numericDraftValue(cached.draft.capital) || DEFAULT_CAPITAL, cached.weights));
      setDraft(cached.draft);
      setStatus(t(language, "custom.dcaDraftRestored"));
    } else {
      setEditingId(null);
      setSelectedIds([]);
      setSelectedAssetMap({});
      setWeights({});
      setDcaPlans({});
      setDraft(defaultDraft(defaultName, defaultStyle));
      setStatus(t(language, "custom.status.synced"));
      setDeletingFund(false);
    }
    resetCalculation();
    setStockSearchFilters({ q: "", industry: "", fundType: "", sort: "popularity", page: 1, type: "stock" });
  }, [defaultName, defaultStyle, language, marketId, resetCalculation, setStockSearchFilters]);

  const universeById = useMemo(
    () => new Map((customFunds.data?.universe ?? []).map((asset) => [asset.id, asset])),
    [customFunds.data?.universe],
  );
  const categoryOptions = useMemo(() => stockSearch.data?.facets?.sectors ?? [], [stockSearch.data?.facets?.sectors]);
  const categoryCounts = useMemo(() => stockSearch.data?.facetCounts?.sectors ?? {}, [stockSearch.data?.facetCounts?.sectors]);
  const stockResults = useMemo(
    () => (stockSearch.data?.items ?? []).filter((asset) => asset.marketId === marketId && isStockAsset(asset)),
    [marketId, stockSearch.data?.items],
  );
  const selectedAssets = selectedIds
    .map((id) => mergeStockAsset(selectedAssetMap[id], universeById.get(id), marketId))
    .filter(Boolean) as AssetRecord[];
  const holdings = useMemo(
    () => selectedAssets.map((asset) => ({ stockId: asset.id, weight: weights[asset.id] ?? 0 })),
    [selectedAssets, weights],
  );
  const totalWeight = roundTotal(holdings.map((holding) => holding.weight));
  const weightValid = selectedAssets.length > 0 && Math.abs(totalWeight - 100) <= 0.01;
  const totalResults = stockSearch.data?.total ?? stockResults.length;
  const currentPage = stockSearch.data?.page ?? stockSearch.filters.page;
  const totalPages = stockSearch.data?.totalPages ?? 1;
  const capital = numericDraftValue(draft.capital) || DEFAULT_CAPITAL;
  const cashBalance = 0;
  const dcaSummary = useMemo(() => buildDcaPlanSummary(selectedAssets, dcaPlans, capital, weights), [capital, dcaPlans, selectedAssets, weights]);
  const previewDividendYield = weightedAssetDividendYield(selectedAssets, weights);
  const estimatedAnnualDividend = capital * (previewDividendYield / 100);

  function selectSavedFund(fundId: string) {
    resetCalculation();
    if (!fundId) {
      resetDraft();
      setStatus(t(language, "portfolio.newDraft"));
      return;
    }

    const fund = savedFunds.find((item) => item.id === fundId);
    if (!fund) return;
    editFund(fund);
  }

  function toggleAsset(asset: AssetRecord) {
    const nextMap = { ...selectedAssetMap, [asset.id]: asset };
    const nextIds = selectedIds.includes(asset.id) ? selectedIds.filter((id) => id !== asset.id) : [...selectedIds, asset.id];
    const nextAssets = nextIds.map((id) => nextMap[id] ?? assetFromUniverse(universeById.get(id), marketId)).filter(Boolean) as AssetRecord[];
    const nextWeights = equalWeights(nextAssets);
    setSelectedAssetMap(nextMap);
    setSelectedIds(nextIds);
    setWeights(nextWeights);
    setDcaPlans((current) => ensureDcaPlansForAssets(current, nextAssets, capital, nextWeights));
    resetCalculation();
  }

  function removeAsset(assetId: string) {
    const nextAssets = selectedAssets.filter((asset) => asset.id !== assetId);
    const nextWeights = equalWeights(nextAssets);
    setSelectedIds(nextAssets.map((asset) => asset.id));
    setWeights(nextWeights);
    setDcaPlans((current) => ensureDcaPlansForAssets(current, nextAssets, capital, nextWeights));
    resetCalculation();
  }

  function updateWeight(assetId: string, value: number) {
    setWeights((current) => ({ ...current, [assetId]: Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)) }));
    resetCalculation();
  }

  async function runCalculation() {
    const input = buildCalculationInput();
    const response = await calculation.run({
      workflow: "custom-fund",
      assets: selectedAssets.map((asset) => ({ assetId: asset.id, assetType: "stock" })),
      params: input,
      refresh: true,
    });
    if (!response?.result) return;

    writeCustomFundResultCache({
      marketId,
      language,
      input: {
        customFundId: editingId,
        name: input.name,
        style: input.style,
        capital,
        cashBalance,
        startDate: input.startDate,
        endDate: input.endDate,
        holdings,
        weights,
        dcaPlans: input.dcaPlans,
      },
      selectedAssets: response.result.assets?.length ? response.result.assets : selectedAssets,
      result: response.result,
      editingId,
    });
    navigate(`/custom-fund/result?market=${marketId}&lang=${language}`, { state: createReturnToState(locationToReturnTo(location)) });
  }

  function buildCalculationInput() {
    return {
      customFundId: editingId,
      name: draft.name || defaultName,
      style: draft.style || defaultStyle,
      capital,
      cashBalance,
      startDate: draft.startDate,
      endDate: draft.endDate,
      holdings,
      weights,
      dcaPlans: selectedDcaPlans(selectedAssets, dcaPlans, capital, weights),
    };
  }

  function writeCurrentDraftCache() {
    writeCustomFundDraftCache({
      marketId,
      language,
      editingId,
      selectedAssets,
      weights,
      dcaPlans: selectedDcaPlans(selectedAssets, dcaPlans, capital, weights),
      draft,
    });
  }

  function openDcaPlanPage() {
    writeCurrentDraftCache();
    navigate(`/custom-fund/dca-plan?market=${marketId}&lang=${language}`, { state: createReturnToState(locationToReturnTo(location)) });
  }

  async function saveDraft() {
    if (!weightValid) {
      setStatus(t(language, "custom.adjustWeights", { total: formatWeight(totalWeight) }));
      return;
    }
    setSavingDraft(true);
    setStatus(editingId ? t(language, "custom.status.updating") : t(language, "custom.status.saving"));
    try {
      const draftInput = {
        name: draft.name || defaultName,
        style: draft.style || defaultStyle,
        holdings,
        capital,
        cashBalance,
        startDate: draft.startDate,
        endDate: draft.endDate,
        dcaPlans: selectedDcaPlans(selectedAssets, dcaPlans, capital, weights),
      };
      if (editingId) {
        await customFunds.updateCustomFund(editingId, draftInput);
        setStatus(t(language, "custom.status.updated"));
      } else {
        const response = await customFunds.saveCustomFund(draftInput);
        setStatus(t(language, "custom.status.saved"));
        void response;
      }
    } catch (error) {
      setStatus(apiErrorMessage(error));
    } finally {
      setSavingDraft(false);
    }
  }

  function resetDraft() {
    setEditingId(null);
    setSelectedIds([]);
    setSelectedAssetMap({});
    setWeights({});
    setDcaPlans({});
    setDraft(defaultDraft(defaultName, defaultStyle));
    clearCustomFundDraftCache(marketId);
    resetCalculation();
    setStatus(t(language, "custom.status.synced"));
  }

  function editFund(fund: CustomFundRecord) {
    const restoredWeights = Object.fromEntries(fund.holdings.map((holding) => [holding.stockId, holding.weight]));
    const restoredCapital = Number(fund.capital ?? capital);
    const restoredAssets = Object.fromEntries(
      fund.holdings
        .map((holding) => assetFromUniverse(universeById.get(holding.stockId), marketId))
        .filter((asset): asset is AssetRecord => Boolean(asset))
        .map((asset) => [asset.id, asset]),
    ) as Record<string, AssetRecord>;
    setEditingId(fund.id);
    setDraft((current) => ({
      ...current,
      name: fund.name,
      style: fund.style,
      capital: Number.isFinite(restoredCapital) && restoredCapital > 0 ? String(restoredCapital) : (current.capital || "100000"),
      cashBalance: String(fund.cashBalance ?? 0),
      startDate: fund.startDate ?? "",
      endDate: fund.endDate ?? new Date().toISOString().slice(0, 10),
    }));
    setSelectedIds(fund.holdings.map((holding) => holding.stockId));
    setSelectedAssetMap(restoredAssets);
    setWeights(restoredWeights);
    setDcaPlans(ensureDcaPlansForAssets(fund.dcaPlans ?? {}, Object.values(restoredAssets), restoredCapital, restoredWeights));
    resetCalculation();
    setStatus(t(language, "custom.editing", { name: fund.name }));
  }

  async function removeFund(id: string) {
    if (!id || deletingFund) return;
    setDeletingFund(true);
    setStatus(t(language, "custom.status.deleting"));
    try {
      await customFunds.deleteCustomFund(id);
      if (editingId === id) resetDraft();
      setStatus(t(language, "custom.status.deleted"));
    } catch (error) {
      setStatus(apiErrorMessage(error));
    } finally {
      setDeletingFund(false);
    }
  }

  return (
    <WorkbenchLayout
      align="start"
      pool={
        <WorkbenchPanel
          title={t(language, "custom.stockUniverse")}
          subtitle={t(language, "custom.syncedStocks", { count: formatNumber(customFunds.data?.universeCount ?? stockSearch.data?.stats?.stocks ?? 0) })}
          className="flex min-h-[38rem] flex-col xl:h-[40rem]"
        >
          <input
            className={inputClassName}
            placeholder={t(language, "discover.placeholder")}
            value={stockSearch.filters.q}
            onChange={(event) => stockSearch.setFilters({ q: event.target.value })}
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <FieldLabel label={t(language, "dca.filterIndustry")}>
              <CustomSelect
                ariaLabel={t(language, "dca.filterIndustry")}
                value={stockSearch.filters.industry}
                options={[
                  { value: "", label: t(language, "common.allSectors") },
                  ...categoryOptions.map((item) => ({
                    value: item,
                    label: `${localizedAssetSector(item, language)}${categoryCounts[item] ? ` (${categoryCounts[item].toLocaleString()})` : ""}`,
                  })),
                ]}
                onChange={(industry) => stockSearch.setFilters({ industry })}
              />
            </FieldLabel>
            <FieldLabel label={t(language, "dca.sort")}>
              <CustomSelect
                ariaLabel={t(language, "dca.sort")}
                value={stockSearch.filters.sort}
                options={stockSortOptions.map((item) => ({ value: item.value, label: t(language, item.labelKey) }))}
                onChange={(sort) => stockSearch.setFilters({ sort })}
              />
            </FieldLabel>
            <div className="flex items-end">
              <div className="h-10 w-full rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300">
                {t(language, "assetType.stock")}
              </div>
            </div>
            <div className="flex items-end">
              {(stockSearch.filters.q || stockSearch.filters.industry || stockSearch.filters.sort !== "popularity") ? (
                <button
                  type="button"
                  onClick={() => stockSearch.setFilters({ q: "", type: "stock", industry: "", fundType: "", sort: "popularity", page: 1 })}
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
            <span>{stockSearch.loading && !stockSearch.data ? t(language, "dca.loadingAssets") : t(language, "dca.assetPoolSummary", { total: totalResults.toLocaleString(), count: stockResults.length.toLocaleString() })}</span>
          </div>
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="grid gap-3 md:grid-cols-2">
              {stockSearch.loading && stockResults.length === 0 ? <AssetCardSkeletons /> : null}
              {stockResults.map((asset) => {
                const selected = selectedIds.includes(asset.id);
                const displayAsset = mergeStockAsset(asset, universeById.get(asset.id), marketId) ?? asset;
                return (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => toggleAsset(displayAsset)}
                    className={`min-h-24 rounded-lg border p-3 text-left transition ${selected ? "border-emerald-400 bg-emerald-50 dark:border-emerald-400/50 dark:bg-emerald-400/10" : "border-zinc-200 bg-white hover:border-emerald-300 hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-emerald-400/40 dark:hover:bg-white/[0.06]"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{assetDisplayName(displayAsset, language)}</div>
                        <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{[displayAsset.symbol, assetKindLabel(displayAsset, language), assetPrimaryCategory(displayAsset, language)].filter(Boolean).join(" · ")}</div>
                      </div>
                      <Plus size={16} className="shrink-0 text-zinc-400" />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                      <span className="rounded bg-zinc-100 px-2 py-1 dark:bg-white/10">{quoteStatusLabel(displayAsset, language)}</span>
                      <span className="rounded bg-zinc-100 px-2 py-1 dark:bg-white/10">{formatOptionalCurrency(displayAsset.latestPrice, marketId)}</span>
                      {displayAsset.dailyChange != null ? <span className="rounded bg-zinc-100 px-2 py-1 dark:bg-white/10">{formatOptionalPercent(displayAsset.dailyChange)}</span> : null}
                    </div>
                  </button>
                );
              })}
            </div>
            {!stockSearch.loading && stockSearch.data && totalPages > 1 ? (
              <div className="mt-3 flex items-center justify-between rounded border border-zinc-200 bg-white p-2 text-xs dark:border-white/10 dark:bg-white/[0.03]">
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => stockSearch.setPage(currentPage - 1)}
                  className="h-8 rounded border border-zinc-200 px-2 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:text-zinc-200 dark:disabled:text-zinc-500"
                >
                  {t(language, "common.previous")}
                </button>
                <span className="text-zinc-500 dark:text-zinc-400">{t(language, "common.pageOf", { page: currentPage, totalPages })}</span>
                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() => stockSearch.setPage(currentPage + 1)}
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
        <WorkbenchPanel title={t(language, "custom.stockControls")} subtitle={t(language, "custom.stockControlsSubtitle")} className="flex min-h-[38rem] flex-col xl:h-[40rem]">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <FieldLabel label={t(language, "custom.savedFunds")}>
              <div className="flex gap-2">
                <CustomSelect
                  ariaLabel={t(language, "custom.savedFunds")}
                  className="min-w-0 flex-1"
                  value={editingId ?? ""}
                  options={[
                    { value: "", label: t(language, "custom.newCustomFund") },
                    ...savedFunds.map((item) => ({ value: item.id, label: item.name })),
                  ]}
                  onChange={selectSavedFund}
                />
                <button
                  type="button"
                  title={t(language, "common.deleteActive")}
                  aria-label={t(language, "common.deleteActive")}
                  disabled={!editingId || deletingFund}
                  onClick={() => {
                    if (editingId) void removeFund(editingId);
                  }}
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded border border-zinc-200 bg-white text-zinc-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-50 disabled:text-zinc-300 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300 dark:hover:border-red-400/40 dark:hover:bg-red-400/10 dark:hover:text-red-300 dark:disabled:bg-white/[0.02] dark:disabled:text-zinc-600"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </FieldLabel>
            <div className="mt-4">
              <SelectedStocksEditor
                assets={selectedAssets}
                weights={weights}
                totalWeight={totalWeight}
                weightValid={weightValid}
                language={language}
                onRemove={removeAsset}
                onWeightChange={updateWeight}
              />
            </div>
            <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-white/10 dark:bg-white/[0.04]">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-white">
                    <CalendarClock size={16} className="text-emerald-600" />
                    {t(language, "custom.dcaPlanTitle")}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                    {t(language, "portfolio.dcaPlanSummary", {
                      count: formatNumber(dcaSummary.enabledCount),
                      amount: formatCurrency(dcaSummary.recurringAmount, marketId),
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!selectedAssets.length}
                  onClick={openDcaPlanPage}
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200 dark:hover:bg-white/10 dark:disabled:text-zinc-500"
                >
                  {t(language, dcaSummary.enabledCount ? "portfolio.editDcaPlans" : "portfolio.configureDca")}
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <FieldLabel label={t(language, "common.name")}>
                <input className={inputClassName} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </FieldLabel>
              <FieldLabel label={t(language, "custom.style")}>
                <input className={inputClassName} value={draft.style} onChange={(event) => setDraft((current) => ({ ...current, style: event.target.value }))} />
              </FieldLabel>
              <FieldLabel label={t(language, "portfolio.capital")}>
                <input type="number" min="0" className={inputClassName} value={draft.capital} onChange={(event) => setDraft((current) => ({ ...current, capital: event.target.value }))} />
              </FieldLabel>
              <FieldLabel label={t(language, "dca.startDate")}>
                <input type="date" className={inputClassName} value={draft.startDate} onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))} />
              </FieldLabel>
              <FieldLabel label={t(language, "dca.endDate")}>
                <input type="date" className={inputClassName} value={draft.endDate} onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))} />
              </FieldLabel>
              <div className="flex items-end">
                <div className="h-10 w-full rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300">
                  {formatCurrency(estimatedAnnualDividend, marketId)} {t(language, "custom.estimatedAnnualShort")}
                </div>
              </div>
            </div>
            <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-white/10">
              <div className="grid grid-cols-2 gap-x-5 gap-y-3 lg:grid-cols-3">
                <PreviewMetric label={t(language, "custom.selectedAssets")} value={formatNumber(selectedAssets.length)} />
                <PreviewMetric label={t(language, "common.targetWeight")} value={formatWeight(totalWeight)} />
                <PreviewMetric label={t(language, "compare.dividendYield")} value={formatPercent(previewDividendYield)} />
                <PreviewMetric label={t(language, "custom.estimatedAnnualDividend")} value={formatCurrency(estimatedAnnualDividend, marketId)} />
                <PreviewMetric label={t(language, "portfolio.capital")} value={formatCurrency(capital, marketId)} />
                <PreviewMetric label={t(language, "portfolio.enabledDcaPlans")} value={formatNumber(dcaSummary.enabledCount)} />
              </div>
            </div>
            <div className="pt-4">
              <CalculationStatus
                running={calculation.running}
                error={calculation.error ?? customFunds.error}
                warnings={calculation.warnings}
                idle={status}
                runningLabel={t(language, "portfolio.status.calculating")}
                warningsLabel={t(language, "portfolio.status.warning")}
              />
            </div>
            <div className="mt-4 flex flex-col gap-2 border-t border-zinc-100 pt-4 dark:border-white/10 sm:flex-row">
              <button
                type="button"
                disabled={savingDraft || deletingFund || !weightValid}
                onClick={saveDraft}
                className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
              >
                <Save size={16} />
                {editingId ? t(language, "custom.updateCustomFund") : t(language, "custom.saveDraft")}
              </button>
              {editingId ? (
                <SecondaryButton onClick={() => removeFund(editingId)} disabled={savingDraft || deletingFund}>
                  {t(language, "common.remove")}
                </SecondaryButton>
              ) : null}
            </div>
          </div>
        </WorkbenchPanel>
      }
      actions={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-zinc-500 dark:text-zinc-400">{t(language, "custom.selectedStocksSummary", { count: selectedAssets.length, weight: formatWeight(totalWeight) })}</div>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton onClick={resetDraft}>{t(language, "common.reset")}</SecondaryButton>
            <CalculateButton disabled={!weightValid} running={calculation.running} onClick={runCalculation}>
              <span className="inline-flex items-center gap-2"><Calculator size={16} /> {t(language, "portfolio.calculate")}</span>
            </CalculateButton>
          </div>
        </div>
      }
    />
  );
}

function SelectedStocksEditor({
  assets,
  weights,
  totalWeight,
  weightValid,
  language,
  onRemove,
  onWeightChange,
}: {
  assets: AssetRecord[];
  weights: Record<string, number>;
  totalWeight: number;
  weightValid: boolean;
  language: Language;
  onRemove: (assetId: string) => void;
  onWeightChange: (assetId: string, value: number) => void;
}) {
  if (!assets.length) {
    return <div className="rounded-lg border border-dashed border-zinc-200 p-5 text-sm text-zinc-500 dark:border-white/10 dark:text-zinc-400">{t(language, "custom.selectStocksEmpty")}</div>;
  }

  return (
    <details open className="rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
        <span className="text-sm font-semibold text-zinc-950 dark:text-white">{t(language, "custom.selectedAssets")}</span>
        <span className={`text-sm font-semibold ${weightValid ? "text-emerald-600" : "text-red-500"}`}>{assets.length} · {formatWeight(totalWeight)}</span>
      </summary>
      <div className="max-h-44 overflow-y-auto overscroll-contain border-t border-zinc-100 dark:border-white/10">
        {assets.map((asset) => (
          <div key={asset.id} className="grid gap-2 border-b border-zinc-100 px-3 py-2 last:border-b-0 dark:border-white/10 sm:grid-cols-[minmax(0,1fr)_6.5rem_2rem] sm:items-center">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{assetDisplayName(asset, language)}</div>
              <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                {[asset.symbol, assetPrimaryCategory(asset, language), quoteStatusLabel(asset, language)].filter(Boolean).join(" · ")}
              </div>
            </div>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              aria-label={`${asset.symbol} ${t(language, "common.targetWeight")}`}
              className="h-9 w-full rounded border border-zinc-200 bg-white px-2 text-sm text-zinc-950 outline-none transition focus:border-emerald-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-white"
              value={weights[asset.id] ?? 0}
              onChange={(event) => onWeightChange(asset.id, Number(event.target.value))}
            />
            <button
              type="button"
              onClick={() => onRemove(asset.id)}
              className="flex h-8 w-8 items-center justify-center rounded text-zinc-400 transition hover:bg-zinc-50 hover:text-zinc-950 dark:hover:bg-white/10 dark:hover:text-white"
              aria-label={`${t(language, "common.remove")} ${asset.symbol}`}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </details>
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

function roundTotal(values: number[]) {
  return Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
}

function equalWeights(assets: AssetRecord[]) {
  if (!assets.length) return {};
  const raw = Math.floor((100 / assets.length) * 100) / 100;
  const values = assets.map(() => raw);
  values[values.length - 1] = Math.round((100 - raw * (assets.length - 1)) * 100) / 100;
  return Object.fromEntries(assets.map((asset, index) => [asset.id, values[index]]));
}

function defaultDraft(name: string, style: string): CustomFundDraft {
  return {
    name,
    style,
    capital: "100000",
    cashBalance: "0",
    startDate: "",
    endDate: new Date().toISOString().slice(0, 10),
  };
}

function isStockAsset(asset: AssetRecord) {
  return asset.kind === "stock" || asset.assetType === "stock";
}

function assetFromUniverse(asset: CustomFundUniverseItem | undefined, marketId: MarketId): AssetRecord | null {
  if (!asset) return null;
  return {
    id: asset.id,
    marketId,
    assetType: "stock",
    kind: "stock",
    name: asset.name,
    symbol: asset.symbol,
    aliases: [asset.symbol, asset.name],
    industry: asset.industry,
    sector: asset.sector,
    category: asset.category,
    latestPrice: asset.price,
    latestVolume: null,
    dailyChange: asset.dailyChange,
    popularity: 0,
    source: "local-db",
    quoteStatus: "fresh",
    updatedAt: new Date().toISOString(),
    dividendYield: asset.dividendYield,
  } as AssetRecord & { dividendYield?: number };
}

function mergeStockAsset(asset: AssetRecord | undefined, universeAsset: CustomFundUniverseItem | undefined, marketId: MarketId): AssetRecord | null {
  const enriched = assetFromUniverse(universeAsset, marketId);
  if (!asset) return enriched;
  return {
    ...enriched,
    ...asset,
    latestPrice: asset.latestPrice ?? enriched?.latestPrice ?? null,
    dailyChange: preferredDailyChange(asset.dailyChange, enriched?.dailyChange),
    sector: asset.sector ?? enriched?.sector,
    industry: asset.industry ?? enriched?.industry,
    category: asset.category ?? enriched?.category,
    dividendYield: (enriched as (AssetRecord & { dividendYield?: number }) | null)?.dividendYield ?? (asset as AssetRecord & { dividendYield?: number }).dividendYield,
  } as AssetRecord & { dividendYield?: number };
}

function preferredDailyChange(searchChange: number | null | undefined, universeChange: number | null | undefined) {
  const searchValue = Number(searchChange);
  const universeValue = Number(universeChange);
  if (Number.isFinite(universeValue) && (!Number.isFinite(searchValue) || Math.abs(searchValue) < 0.05)) return universeValue;
  if (Number.isFinite(searchValue)) return searchValue;
  return Number.isFinite(universeValue) ? universeValue : null;
}

function numericDraftValue(value: string) {
  if (!value.trim()) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function ensureDcaPlansForAssets(current: Record<string, PortfolioDcaPlan>, assets: AssetRecord[], capital = DEFAULT_CAPITAL, weights: Record<string, number> = {}) {
  return Object.fromEntries(assets.map((asset) => [asset.id, normalizeDcaPlan(current[asset.id], defaultInitialAmount(asset, capital, weights))]));
}

function selectedDcaPlans(assets: AssetRecord[], plans: Record<string, PortfolioDcaPlan>, capital = DEFAULT_CAPITAL, weights: Record<string, number> = {}) {
  return Object.fromEntries(assets.map((asset) => [asset.id, normalizeDcaPlan(plans[asset.id], defaultInitialAmount(asset, capital, weights))]));
}

function normalizeDcaPlan(plan?: PortfolioDcaPlan, defaultInitial = LEGACY_DEFAULT_INITIAL_AMOUNT): PortfolioDcaPlan {
  return {
    enabled: Boolean(plan?.enabled),
    initialAmount: initialAmountForPlan(plan, defaultInitial),
    recurringAmount: numericPlanValue(plan?.recurringAmount, DEFAULT_RECURRING_AMOUNT),
    frequency: plan?.frequency ?? "monthly",
    transactionCost: numericPlanValue(plan?.transactionCost, 0),
    reinvestDividends: plan?.reinvestDividends ?? true,
    strategy: plan?.strategy ?? "standard",
  };
}

function buildDcaPlanSummary(assets: AssetRecord[], plans: Record<string, PortfolioDcaPlan>, capital = DEFAULT_CAPITAL, weights: Record<string, number> = {}) {
  const selectedPlans = assets.map((asset) => normalizeDcaPlan(plans[asset.id], defaultInitialAmount(asset, capital, weights))).filter((plan) => plan.enabled);
  return {
    enabledCount: selectedPlans.length,
    initialAmount: selectedPlans.reduce((total, plan) => total + plan.initialAmount, 0),
    recurringAmount: selectedPlans.reduce((total, plan) => total + plan.recurringAmount, 0),
  };
}

function initialAmountForPlan(plan: PortfolioDcaPlan | undefined, defaultInitial: number) {
  if (!plan || !plan.enabled) return defaultInitial;
  return numericPlanValue(plan.initialAmount, defaultInitial);
}

function defaultInitialAmount(asset: AssetRecord, capital: number, weights: Record<string, number>) {
  const weight = weights[asset.id] ?? 0;
  if (!Number.isFinite(capital) || capital <= 0 || !Number.isFinite(weight) || weight <= 0) return LEGACY_DEFAULT_INITIAL_AMOUNT;
  return roundAmount(capital * (weight / 100));
}

function numericPlanValue(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function roundAmount(value: number) {
  return Math.round(value * 100) / 100;
}

function weightedAssetDividendYield(assets: AssetRecord[], weights: Record<string, number>) {
  const total = assets.reduce((sum, asset) => sum + (weights[asset.id] ?? 0), 0);
  if (!total) return 0;
  return assets.reduce((sum, asset) => {
    const dividendYield = (asset as AssetRecord & { dividendYield?: number }).dividendYield;
    return sum + (Number.isFinite(dividendYield) ? Number(dividendYield) : 0) * ((weights[asset.id] ?? 0) / total);
  }, 0);
}

function formatWeight(value: number, digits = 1) {
  return `${value.toFixed(digits)}%`;
}
