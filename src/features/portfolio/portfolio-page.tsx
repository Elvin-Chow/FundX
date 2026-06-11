"use client";

import { useEffect, useMemo, useState } from "react";
import { Calculator, CalendarClock, ChevronRight, Plus, Save, Trash2, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { CustomSelect } from "@/components/custom-select";
import { useAssetsSearch } from "@/hooks/use-assets-search";
import { useCalculationRun } from "@/hooks/use-calculation-run";
import { useResolvedLanguage } from "@/hooks/use-language";
import { usePortfolio } from "@/hooks/use-portfolio";
import { apiErrorMessage, apiPost } from "@/lib/api-client";
import type { CalculationResponse } from "@/lib/api-contracts";
import { assetDisplayName, assetKindLabel, assetPrimaryCategory, localizedAssetSector, quoteStatusLabel } from "@/lib/asset-display";
import { formatCurrency, formatNumber, formatOptionalCurrency, formatOptionalPercent } from "@/lib/formatters";
import { getMarketCopy, localeForLanguage, t, type Language } from "@/lib/i18n";
import { createReturnToState, locationToReturnTo } from "@/lib/navigation-state";
import type { AssetRecord, MarketId, Portfolio, PortfolioDcaPlan, PortfolioSummary, SearchSortKey } from "@/lib/types";
import { defaultStartDate, todayDate } from "@/lib/utils";
import { normalizeMarket, type Market } from "../../components/types";
import {
  CalculateButton,
  CalculationStatus,
  FieldLabel,
  SecondaryButton,
  WorkbenchLayout,
  WorkbenchPanel,
  inputClassName,
} from "../shared/calculation-workbench";
import { clearPortfolioDraftCache, readPortfolioDraftCache, writePortfolioDraftCache } from "./portfolio-draft-store";
import { writePortfolioResultCache } from "./portfolio-result-store";

type PortfolioCalculationResult = {
  portfolio: Portfolio;
  summary: PortfolioSummary;
  savedPortfolio?: Portfolio | null;
};

type PortfolioDraft = {
  name: string;
  goal: string;
  riskPreference: string;
  capital: string;
  cashBalance: string;
  startDate: string;
  endDate: string;
};

const sortOptions: Array<{ value: SearchSortKey; labelKey: string }> = [
  { value: "popularity", labelKey: "discover.sort.popularity" },
  { value: "relevance", labelKey: "discover.sort.relevance" },
  { value: "return", labelKey: "discover.dailyReturn" },
  { value: "size", labelKey: "discover.size" },
  { value: "risk", labelKey: "discover.lowerRisk" },
];
const DEFAULT_CAPITAL = 100000;
const LEGACY_DEFAULT_INITIAL_AMOUNT = 1000;
const DEFAULT_RECURRING_AMOUNT = 500;

export function PortfolioPage({ market = "us", marketId, language: languageProp = "en" }: { market?: Market; marketId?: Market; language?: Language }) {
  const activeMarket = normalizeMarket(marketId ?? market);
  const language = useResolvedLanguage(languageProp);
  const location = useLocation();
  const navigate = useNavigate();
  const portfolio = usePortfolio(activeMarket);
  const search = useAssetsSearch(activeMarket, { type: "fund", pageSize: 12, sort: "popularity" });
  const calculation = useCalculationRun<PortfolioCalculationResult>(activeMarket);
  const resetCalculation = calculation.reset;
  const setSearchFilters = search.setFilters;
  const defaultPortfolioName = t(language, "portfolio.defaultName", { market: getMarketCopy(language, activeMarket).shortName });
  const defaultGoal = t(language, "portfolio.defaultGoal");
  const portfolioOptions = portfolio.data?.portfolios ?? [];
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedAssetMap, setSelectedAssetMap] = useState<Record<string, AssetRecord>>({});
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [dcaPlans, setDcaPlans] = useState<Record<string, PortfolioDcaPlan>>({});
  const [selectedPortfolioId, setSelectedPortfolioId] = useState("");
  const [status, setStatus] = useState(t(language, "portfolio.status.synced"));
  const [savingDraft, setSavingDraft] = useState(false);
  const [deletingPortfolio, setDeletingPortfolio] = useState(false);
  const [draft, setDraft] = useState<PortfolioDraft>(() => defaultPortfolioDraft(defaultPortfolioName, defaultGoal));

  useEffect(() => {
    const cached = readPortfolioDraftCache(activeMarket);
    if (cached) {
      setSelectedPortfolioId(cached.selectedPortfolioId);
      setSelectedIds(cached.selectedAssets.map((asset) => asset.id));
      setSelectedAssetMap(Object.fromEntries(cached.selectedAssets.map((asset) => [asset.id, asset])));
      setWeights(cached.weights);
      setDcaPlans(ensureDcaPlansForAssets(cached.dcaPlans, cached.selectedAssets, numericDraftValue(cached.draft.capital) || DEFAULT_CAPITAL, cached.weights));
      setDraft(normalizePortfolioDraft(cached.draft, defaultPortfolioName, defaultGoal));
      setStatus(t(language, "portfolio.dcaDraftRestored"));
    } else {
      setSelectedPortfolioId("");
      setSelectedIds([]);
      setSelectedAssetMap({});
      setWeights({});
      setDcaPlans({});
      setDraft(defaultPortfolioDraft(defaultPortfolioName, defaultGoal));
      setDeletingPortfolio(false);
    }
    resetCalculation();
    setSearchFilters({ q: "", type: "fund", industry: "", fundType: "", sort: "popularity", page: 1 });
  }, [activeMarket, defaultGoal, defaultPortfolioName, language, resetCalculation, setSearchFilters]);

  useEffect(() => {
    setStatus(t(language, "portfolio.status.synced"));
  }, [language]);

  const fundResults = useMemo(
    () => (search.data?.items ?? []).filter((asset) => asset.marketId === activeMarket && isFundAsset(asset)),
    [activeMarket, search.data?.items],
  );
  const categoryOptions = useMemo(() => uniqueOptions([...(search.data?.facets?.sectors ?? []), ...(search.data?.facets?.industries ?? [])]), [search.data?.facets?.industries, search.data?.facets?.sectors]);
  const fundTypeOptions = useMemo(() => search.data?.facets?.fundTypes ?? [], [search.data?.facets?.fundTypes]);
  const categoryCounts = useMemo(
    () => ({ ...(search.data?.facetCounts?.industries ?? {}), ...(search.data?.facetCounts?.sectors ?? {}) }),
    [search.data?.facetCounts?.industries, search.data?.facetCounts?.sectors],
  );
  const selectedAssets = selectedIds.map((id) => selectedAssetMap[id]).filter(Boolean);
  const totalWeight = roundTotal(selectedAssets.map((asset) => weights[asset.id] ?? 0));
  const weightValid = selectedAssets.length > 0 && Math.abs(totalWeight - 100) <= 0.01;
  const totalResults = search.data?.total ?? fundResults.length;
  const currentPage = search.data?.page ?? search.filters.page;
  const totalPages = search.data?.totalPages ?? 1;
  const locale = localeForLanguage(language);
  const capital = numericDraftValue(draft.capital) || DEFAULT_CAPITAL;
  const cashBalance = 0;
  const dcaSummary = useMemo(() => buildDcaPlanSummary(selectedAssets, dcaPlans, capital, weights), [capital, dcaPlans, selectedAssets, weights]);

  function selectSavedPortfolio(portfolioId: string) {
    setSelectedPortfolioId(portfolioId);
    resetCalculation();
    if (!portfolioId) {
      setDraft(defaultPortfolioDraft(defaultPortfolioName, defaultGoal));
      setSelectedIds([]);
      setSelectedAssetMap({});
      setWeights({});
      setDcaPlans({});
      setStatus(t(language, "portfolio.newDraft"));
      return;
    }

    const saved = portfolioOptions.find((item) => item.id === portfolioId);
    if (!saved) return;
    loadSavedPortfolio(saved);
    void portfolio.setActivePortfolioId(portfolioId);
  }

  function loadSavedPortfolio(saved: Portfolio) {
    const fundHoldings = saved.holdings.filter((holding) => holding.assetType === "fund" || holding.assetType === "etf");
    const assets = fundHoldings.map((holding) => assetFromHolding(holding, activeMarket));
    const nextWeights = Object.fromEntries(fundHoldings.map((holding) => [holding.assetId, normalizeStoredWeight(holding.targetWeight)]));
    const normalizedWeights = roundTotal(Object.values(nextWeights)) > 0 ? nextWeights : equalWeights(assets);
    setDraft((current) => ({
      ...current,
      name: saved.name || defaultPortfolioName,
      goal: saved.goal || defaultGoal,
      riskPreference: saved.riskPreference || "Balanced",
      capital: String(saved.capital ?? DEFAULT_CAPITAL),
      cashBalance: String(saved.cashBalance ?? 0),
      startDate: saved.startDate || defaultStartDate(),
      endDate: saved.endDate || todayDate(),
    }));
    setSelectedAssetMap(Object.fromEntries(assets.map((asset) => [asset.id, asset])));
    setSelectedIds(assets.map((asset) => asset.id));
    setWeights(normalizedWeights);
    setDcaPlans(ensureDcaPlansForAssets(saved.dcaPlans ?? {}, assets, saved.capital ?? DEFAULT_CAPITAL, normalizedWeights));
    setStatus(t(language, "portfolio.editingPortfolio", { name: saved.name }));
  }

  function toggleAsset(asset: AssetRecord) {
    const nextMap = { ...selectedAssetMap, [asset.id]: asset };
    const nextIds = selectedIds.includes(asset.id) ? selectedIds.filter((id) => id !== asset.id) : [...selectedIds, asset.id];
    const nextAssets = nextIds.map((id) => nextMap[id]).filter(Boolean);
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

  function resetDraft() {
    setSelectedPortfolioId("");
    setSelectedIds([]);
    setSelectedAssetMap({});
    setWeights({});
    setDcaPlans({});
    setDraft(defaultPortfolioDraft(defaultPortfolioName, defaultGoal));
    clearPortfolioDraftCache(activeMarket);
    resetCalculation();
    setStatus(t(language, "portfolio.status.synced"));
  }

  async function deleteSelectedPortfolio() {
    if (!selectedPortfolioId || deletingPortfolio) return;
    setDeletingPortfolio(true);
    setStatus(t(language, "portfolio.deleting"));
    try {
      await portfolio.deletePortfolio(selectedPortfolioId);
      setSelectedPortfolioId("");
      setSelectedIds([]);
      setSelectedAssetMap({});
      setWeights({});
      setDcaPlans({});
      setDraft(defaultPortfolioDraft(defaultPortfolioName, defaultGoal));
      clearPortfolioDraftCache(activeMarket);
      resetCalculation();
      setStatus(t(language, "portfolio.deleted"));
    } catch (error) {
      setStatus(apiErrorMessage(error));
    } finally {
      setDeletingPortfolio(false);
    }
  }

  async function savePortfolioDraft() {
    setSavingDraft(true);
    setStatus(t(language, "portfolio.saving"));
    try {
      const input = {
        name: draft.name || defaultPortfolioName,
        goal: draft.goal || defaultGoal,
        riskPreference: draft.riskPreference,
        cashBalance,
        capital,
        startDate: draft.startDate,
        endDate: draft.endDate,
        dcaPlans: selectedDcaPlans(selectedAssets, dcaPlans, capital, weights),
      };
      if (selectedPortfolioId) {
        await portfolio.updatePortfolio(selectedPortfolioId, input);
        await saveDraftHoldings(selectedPortfolioId);
      } else {
        const created = await portfolio.createPortfolio(input);
        setSelectedPortfolioId(created.id);
        await saveDraftHoldings(created.id);
      }
      setStatus(t(language, "portfolio.saved"));
    } catch (error) {
      setStatus(apiErrorMessage(error));
    } finally {
      setSavingDraft(false);
    }
  }

  async function saveDraftHoldings(portfolioId: string) {
    const calculated = await calculatePortfolioDraft(portfolioId);
    const calculatedHoldings = calculated.result.summary.holdings;
    const existing = portfolioOptions.find((item) => item.id === portfolioId)?.holdings ?? [];
    const selectedSet = new Set(selectedAssets.map((asset) => asset.id));
    const staleHoldings = existing.filter((holding) => !selectedSet.has(holding.assetId));
    await Promise.all(staleHoldings.map((holding) => portfolio.deleteHolding(holding.id, portfolioId)));
    await Promise.all(calculatedHoldings.map((holding) => {
      const price = Number(holding.currentPrice ?? 0);
      if (!Number.isFinite(price) || price <= 0) throw new Error(t(language, "portfolio.priceRequired", { symbol: holding.symbol }));
      return portfolio.saveHolding({
        portfolioId,
        assetId: holding.assetId,
        assetType: holding.assetType,
        quantity: holding.quantity,
        averageCost: holding.averageCost,
        currentPrice: holding.currentPrice,
        targetWeight: holding.targetWeight,
        name: holding.name,
        symbol: holding.symbol,
        sector: holding.sector,
      });
    }));
    await portfolio.updatePortfolio(portfolioId, {
      dcaPlans: selectedDcaPlans(selectedAssets, dcaPlans, capital, weights),
      valueHistory: calculated.result.summary.valueHistory,
      contributionHistory: calculated.result.portfolio.contributionHistory ?? [],
      capital,
      cashBalance,
      startDate: draft.startDate,
      endDate: draft.endDate,
    });
    await portfolio.refresh("reload");
  }

  async function calculatePortfolioDraft(portfolioId?: string) {
    const params = buildPortfolioCalculationInput(portfolioId);
    const response = await apiPost<CalculationResponse<PortfolioCalculationResult>>("/api/calculations", {
      marketId: activeMarket,
      workflow: "portfolio",
      assets: selectedAssets.map((asset) => ({ assetId: asset.id, assetType: asset.assetType })),
      params,
      refresh: true,
    }, { market: activeMarket });
    if (!response.result) throw new Error(t(language, "portfolio.noResultTitle"));
    return response;
  }

  function buildPortfolioCalculationInput(portfolioId?: string) {
    return {
      portfolioId,
      name: draft.name || defaultPortfolioName,
      goal: draft.goal || defaultGoal,
      riskPreference: draft.riskPreference,
      capital,
      cashBalance,
      startDate: draft.startDate,
      endDate: draft.endDate,
      weights,
      dcaPlans: selectedDcaPlans(selectedAssets, dcaPlans, capital, weights),
    };
  }

  function writeCurrentDraftCache() {
    writePortfolioDraftCache({
      marketId: activeMarket,
      language,
      selectedPortfolioId,
      selectedAssets,
      weights,
      dcaPlans: selectedDcaPlans(selectedAssets, dcaPlans, capital, weights),
      draft,
    });
  }

  function openDcaPlanPage() {
    writeCurrentDraftCache();
    navigate(`/portfolio/dca-plan?market=${activeMarket}&lang=${language}`, { state: createReturnToState(locationToReturnTo(location)) });
  }

  async function runCalculation() {
    const input = buildPortfolioCalculationInput(selectedPortfolioId || undefined);
    const response = await calculation.run({
      workflow: "portfolio",
      assets: selectedAssets.map((asset) => ({ assetId: asset.id, assetType: asset.assetType })),
      params: input,
      refresh: true,
    });
    if (!response?.result) return;

    writePortfolioResultCache({
      marketId: activeMarket,
      language,
      input,
      selectedAssets,
      result: response.result,
      activePortfolioId: selectedPortfolioId || null,
    });
    writeCurrentDraftCache();
    navigate(`/portfolio/result?market=${activeMarket}&lang=${language}`, { state: createReturnToState(locationToReturnTo(location)) });
  }

  return (
    <div>
      <div className="mb-5">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">{t(language, "nav.portfolio")}</div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white sm:text-4xl">{t(language, "portfolio.title")}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500 dark:text-zinc-400 sm:text-base">{t(language, "portfolio.subtitle")}</p>
      </div>
      <WorkbenchLayout
        align="start"
        pool={
          <WorkbenchPanel
            title={t(language, "portfolio.fundPool")}
            subtitle={t(language, "portfolio.fundPoolSubtitle")}
            className="flex min-h-[38rem] flex-col xl:h-[40rem]"
          >
            <input
              className={inputClassName}
              placeholder={t(language, "discover.placeholder")}
              value={search.filters.q}
              onChange={(event) => search.setFilters({ q: event.target.value })}
            />
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <FieldLabel label={t(language, "dca.filterIndustry")}>
                <CustomSelect
                  ariaLabel={t(language, "dca.filterIndustry")}
                  value={search.filters.industry}
                  options={[
                    { value: "", label: t(language, "common.allSectors") },
                    ...categoryOptions.map((item) => ({
                      value: item,
                      label: `${localizedAssetSector(item, language)}${categoryCounts[item] ? ` (${categoryCounts[item].toLocaleString(locale)})` : ""}`,
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
                    ...fundTypeOptions.map((item) => ({ value: item, label: item })),
                  ]}
                  onChange={(fundType) => search.setFilters({ fundType })}
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
              <div className="flex items-end">
                <div className="h-10 w-full rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300">
                  {t(language, "assetType.fund")}
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span>{search.loading && !search.data ? t(language, "dca.loadingAssets") : t(language, "dca.assetPoolSummary", { total: totalResults.toLocaleString(locale), count: fundResults.length.toLocaleString(locale) })}</span>
              {(search.filters.q || search.filters.industry || search.filters.fundType || search.filters.sort !== "popularity") ? (
                <button
                  type="button"
                  onClick={() => search.setFilters({ q: "", type: "fund", industry: "", fundType: "", sort: "popularity", page: 1 })}
                  className="h-7 rounded border border-zinc-200 px-2 font-medium text-zinc-600 hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/10 dark:hover:text-white"
                >
                  {t(language, "discover.clearFilters")}
                </button>
              ) : null}
            </div>
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="grid gap-3 md:grid-cols-2">
                {search.loading && fundResults.length === 0 ? <AssetCardSkeletons /> : null}
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
                        <Plus size={16} className="shrink-0 text-zinc-400" />
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
              {!search.loading && search.data && totalPages > 1 ? (
                <div className="mt-3 flex items-center justify-between rounded border border-zinc-200 bg-white p-2 text-xs dark:border-white/10 dark:bg-white/[0.03]">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => search.setPage(currentPage - 1)}
                    className="h-8 rounded border border-zinc-200 px-2 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:text-zinc-200 dark:disabled:text-zinc-500"
                  >
                    {t(language, "common.previous")}
                  </button>
                  <span className="text-zinc-500 dark:text-zinc-400">{t(language, "common.pageOf", { page: currentPage, totalPages })}</span>
                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    onClick={() => search.setPage(currentPage + 1)}
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
          <WorkbenchPanel title={t(language, "portfolio.fundControls")} subtitle={t(language, "portfolio.fundDraftParameters")} className="flex min-h-[38rem] flex-col xl:h-[40rem]">
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <FieldLabel label={t(language, "portfolio.savedPortfolios")}>
                <div className="flex gap-2">
                  <CustomSelect
                    ariaLabel={t(language, "portfolio.savedPortfolios")}
                    className="min-w-0 flex-1"
                    value={selectedPortfolioId}
                    options={[
                      { value: "", label: t(language, "portfolio.newPortfolioDraft") },
                      ...portfolioOptions.map((item) => ({ value: item.id, label: item.name })),
                    ]}
                    onChange={selectSavedPortfolio}
                  />
                  <button
                    type="button"
                    title={t(language, "common.deleteActive")}
                    aria-label={t(language, "common.deleteActive")}
                    disabled={!selectedPortfolioId || deletingPortfolio}
                    onClick={deleteSelectedPortfolio}
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded border border-zinc-200 bg-white text-zinc-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-50 disabled:text-zinc-300 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300 dark:hover:border-red-400/40 dark:hover:bg-red-400/10 dark:hover:text-red-300 dark:disabled:bg-white/[0.02] dark:disabled:text-zinc-600"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </FieldLabel>
              <div className="mt-4">
                <SelectedFundsEditor
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
                      {t(language, "portfolio.dcaPlanTitle")}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                      {t(language, "portfolio.dcaPlanSummary", {
                        count: formatNumber(dcaSummary.enabledCount),
                        amount: formatCurrency(dcaSummary.recurringAmount, activeMarket),
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
                <FieldLabel label={t(language, "portfolio.namePlaceholder")}>
                  <input className={inputClassName} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                </FieldLabel>
                <FieldLabel label={t(language, "portfolio.capital")}>
                  <input type="number" min="0" className={inputClassName} value={draft.capital} onChange={(event) => setDraft((current) => ({ ...current, capital: event.target.value }))} />
                </FieldLabel>
                <FieldLabel label={t(language, "common.risk")}>
                  <CustomSelect
                    ariaLabel={t(language, "common.risk")}
                    value={draft.riskPreference}
                    options={[
                      { value: "Conservative", label: t(language, "portfolio.riskConservative") },
                      { value: "Balanced", label: t(language, "portfolio.riskBalanced") },
                      { value: "Growth", label: t(language, "portfolio.riskGrowth") },
                    ]}
                    onChange={(riskPreference) => setDraft((current) => ({ ...current, riskPreference }))}
                  />
                </FieldLabel>
                <FieldLabel label={t(language, "dca.startDate")}>
                  <input type="date" className={inputClassName} value={draft.startDate} onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))} />
                </FieldLabel>
                <FieldLabel label={t(language, "dca.endDate")}>
                  <input type="date" className={inputClassName} value={draft.endDate} onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))} />
                </FieldLabel>
              </div>
              <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-white/10">
                <div className="grid grid-cols-2 gap-x-5 gap-y-3 lg:grid-cols-3">
                  <PreviewMetric label={t(language, "portfolio.selectedFunds")} value={formatNumber(selectedAssets.length)} />
                  <PreviewMetric label={t(language, "common.targetWeight")} value={formatWeight(totalWeight)} />
                  <PreviewMetric label={t(language, "portfolio.enabledDcaPlans")} value={formatNumber(dcaSummary.enabledCount)} />
                  <PreviewMetric label={t(language, "portfolio.capital")} value={formatCurrency(capital, activeMarket)} />
                  <PreviewMetric label={t(language, "common.history")} value={dateRangeLabel(draft.startDate, draft.endDate, language)} />
                </div>
              </div>
              <div className="pt-4">
                <CalculationStatus
                  running={calculation.running}
                  error={calculation.error ?? portfolio.error}
                  warnings={calculation.warnings}
                  idle={status}
                  runningLabel={t(language, "portfolio.status.calculating")}
                  warningsLabel={t(language, "portfolio.status.warning")}
                />
              </div>
              <div className="mt-4 flex flex-col gap-2 border-t border-zinc-100 pt-4 dark:border-white/10 sm:flex-row">
                <button
                  type="button"
                  disabled={savingDraft || deletingPortfolio}
                  onClick={savePortfolioDraft}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
                >
                  <Save size={16} />
                  {t(language, "portfolio.savePortfolio")}
                </button>
              </div>
            </div>
          </WorkbenchPanel>
        }
        actions={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-zinc-500">{t(language, "portfolio.selectedFundsSummary", { count: selectedAssets.length, weight: formatWeight(totalWeight) })}</div>
            <div className="flex flex-wrap gap-2">
              <SecondaryButton onClick={resetDraft} disabled={calculation.running || savingDraft}>{t(language, "common.reset")}</SecondaryButton>
              <CalculateButton disabled={!weightValid} running={calculation.running} onClick={runCalculation}>
                <span className="inline-flex items-center gap-2"><Calculator size={16} /> {t(language, "portfolio.calculate")}</span>
              </CalculateButton>
            </div>
          </div>
        }
      />
    </div>
  );
}

function defaultPortfolioDraft(defaultName: string, defaultGoal: string): PortfolioDraft {
  return {
    name: defaultName,
    goal: defaultGoal,
    riskPreference: "Balanced",
    capital: "100000",
    cashBalance: "0",
    startDate: defaultStartDate(),
    endDate: todayDate(),
  };
}

function normalizePortfolioDraft(draft: PortfolioDraft, defaultName: string, defaultGoal: string): PortfolioDraft {
  return {
    ...draft,
    name: draft.name || defaultName,
    goal: draft.goal || defaultGoal,
    riskPreference: draft.riskPreference || "Balanced",
    capital: draft.capital || "100000",
    cashBalance: draft.cashBalance || "0",
    startDate: draft.startDate || defaultStartDate(),
    endDate: draft.endDate || todayDate(),
  };
}

function SelectedFundsEditor({
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
    return <div className="rounded-lg border border-dashed border-zinc-200 p-5 text-sm text-zinc-500 dark:border-white/10 dark:text-zinc-400">{t(language, "portfolio.selectFundEmpty")}</div>;
  }

  return (
    <details open className="rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
        <span className="text-sm font-semibold text-zinc-950 dark:text-white">{t(language, "portfolio.selectedFunds")}</span>
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

function uniqueOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function isFundAsset(asset: AssetRecord) {
  return asset.kind === "fund" || asset.assetType === "fund" || asset.assetType === "etf";
}

function assetFromHolding(holding: Portfolio["holdings"][number], marketId: MarketId): AssetRecord {
  return {
    id: holding.assetId,
    marketId,
    assetType: holding.assetType,
    kind: "fund",
    name: holding.name,
    symbol: holding.symbol,
    aliases: [holding.symbol, holding.name],
    industry: holding.sector,
    sector: holding.sector,
    category: holding.sector,
    latestPrice: holding.currentPrice,
    latestVolume: null,
    dailyChange: null,
    popularity: 0,
    source: "portfolio",
    quoteStatus: "fresh",
    updatedAt: holding.updatedAt,
  };
}

function normalizeStoredWeight(value: number) {
  return Math.round((value <= 1 ? value * 100 : value) * 100) / 100;
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

function numericDraftValue(value: string) {
  if (!value.trim()) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatWeight(value: number, digits = 1) {
  return `${value.toFixed(digits)}%`;
}

function dateRangeLabel(startDate: string, endDate: string, language: Language) {
  const start = startDate ? startDate.slice(0, 10) : t(language, "common.allAvailable");
  const end = endDate ? endDate.slice(0, 10) : t(language, "common.latest");
  return `${start} - ${end}`;
}
