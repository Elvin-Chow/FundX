"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Save } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { CustomSelect } from "@/components/custom-select";
import { useAssetsSearch } from "@/hooks/use-assets-search";
import { useCalculationRun } from "@/hooks/use-calculation-run";
import { useDca } from "@/hooks/use-dca";
import { useResolvedLanguage } from "@/hooks/use-language";
import { assetDisplayName, assetKindLabel, assetPrimaryCategory, localizedAssetSector, quoteStatusLabel } from "@/lib/asset-display";
import { apiErrorMessage } from "@/lib/api-client";
import type { AssetSearchType } from "@/lib/api-contracts";
import { formatCurrency, formatNumber, formatOptionalCurrency, formatOptionalPercent, formatPercent } from "@/lib/formatters";
import { assetTypeLabel, frequencyLabel, localeForLanguage, strategyLabel, t, type Language } from "@/lib/i18n";
import { createReturnToState, locationToReturnTo } from "@/lib/navigation-state";
import type { AssetRecord, DcaInput, DcaPlan, DcaSimulation, DcaStrategy, Frequency, Fund, MarketId, SearchSortKey } from "@/lib/types";
import { defaultStartDate, todayDate } from "@/lib/utils";
import { LoadingRows, StatusBanner, ToneText } from "../shared/feature-shell";
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
import { writeDcaResultCache } from "./dca-result-store";

type DcaNumericField = "initialAmount" | "recurringAmount" | "transactionCost";

type DcaDraft = Omit<DcaInput, DcaNumericField> & Record<DcaNumericField, string> & {
  name: string;
};

type DcaCalculationResult = {
  asset: Fund;
  input: DcaInput & { name?: string };
  simulation: DcaSimulation;
};

type PlanPreview = {
  purchaseCount: number;
  recurringCount: number;
  grossContribution: number;
  estimatedFees: number;
  netContribution: number;
  durationDays: number;
};

const frequencies: Frequency[] = ["weekly", "biweekly", "monthly", "quarterly", "yearly"];
const strategies: DcaStrategy[] = ["standard", "drawdown-addon", "dividend-reinvest", "target-return", "custom"];
const assetTypes: AssetSearchType[] = ["all", "fund", "stock"];
const sortOptions: Array<{ value: SearchSortKey; labelKey: string }> = [
  { value: "popularity", labelKey: "discover.sort.popularity" },
  { value: "relevance", labelKey: "discover.sort.relevance" },
  { value: "return", labelKey: "discover.dailyReturn" },
  { value: "size", labelKey: "discover.size" },
  { value: "risk", labelKey: "discover.lowerRisk" },
];

function fallbackDraft(fundId = "", language: Language = "en"): DcaDraft {
  return {
    fundId,
    name: t(language, "dca.defaultName"),
    initialAmount: "1000",
    recurringAmount: "500",
    frequency: "monthly",
    startDate: defaultStartDate(),
    endDate: todayDate(),
    reinvestDividends: true,
    transactionCost: "0",
    strategy: "standard",
  };
}

export function DCASimulator({ marketId, fundId, language: languageProp = "en" }: { marketId: MarketId; fundId?: string; language?: Language }) {
  const language = useResolvedLanguage(languageProp);
  const location = useLocation();
  const navigate = useNavigate();
  const dca = useDca(marketId);
  const assetSearch = useAssetsSearch(marketId, { type: "all", sort: "popularity", pageSize: 12 });
  const setAssetSearchFilters = assetSearch.setFilters;
  const calculation = useCalculationRun<DcaCalculationResult>(marketId);
  const resetCalculation = calculation.reset;
  const [draft, setDraft] = useState<DcaDraft>(() => fallbackDraft(fundId, language));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [status, setStatus] = useState(t(language, "dca.status.synced"));
  const [selectedAsset, setSelectedAsset] = useState<AssetRecord | null>(null);
  const [savingPlan, setSavingPlan] = useState(false);

  useEffect(() => {
    setDraft(fallbackDraft(fundId, language));
    setEditingId(null);
    setSelectedAsset(null);
    setStatus(t(language, "dca.status.synced"));
    setSavingPlan(false);
    resetCalculation();
    setAssetSearchFilters({ q: "", industry: "", fundType: "", sort: "popularity", page: 1 });
  }, [fundId, language, marketId, resetCalculation, setAssetSearchFilters]);

  const assetResults = useMemo(
    () => (assetSearch.data?.items ?? []).filter((asset) => asset.marketId === marketId && (asset.kind === "fund" || asset.kind === "stock")),
    [assetSearch.data?.items, marketId],
  );
  const categoryOptions = useMemo(() => uniqueOptions([...(assetSearch.data?.facets?.sectors ?? []), ...(assetSearch.data?.facets?.industries ?? [])]), [assetSearch.data?.facets?.industries, assetSearch.data?.facets?.sectors]);
  const fundTypeOptions = useMemo(() => assetSearch.data?.facets?.fundTypes ?? [], [assetSearch.data?.facets?.fundTypes]);
  const categoryCounts = useMemo(
    () => ({ ...(assetSearch.data?.facetCounts?.industries ?? {}), ...(assetSearch.data?.facetCounts?.sectors ?? {}) }),
    [assetSearch.data?.facetCounts?.industries, assetSearch.data?.facetCounts?.sectors],
  );
  const preview = useMemo(() => buildPlanPreview(draft), [draft]);
  const previewDuration = draft.startDate
    ? t(language, "dca.durationDays", { count: formatNumber(preview.durationDays) })
    : t(language, "common.allAvailable");
  const plans = dca.data?.plans ?? [];
  const totalResults = assetSearch.data?.total ?? assetResults.length;
  const currentPage = assetSearch.data?.page ?? assetSearch.filters.page;
  const totalPages = assetSearch.data?.totalPages ?? 1;
  const locale = localeForLanguage(language);

  function selectAsset(asset: AssetRecord) {
    setSelectedAsset(asset);
    setDraft((current) => ({
      ...current,
      fundId: asset.id,
      name: current.name === t(language, "dca.defaultName") ? `${assetDisplayName(asset, language)} DCA` : current.name,
    }));
    resetCalculation();
  }

  function updateDraft<K extends keyof DcaDraft>(key: K, value: DcaDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    resetCalculation();
  }

  async function runCalculation() {
    if (!selectedAsset) return;
    const input = normalizeDcaDraft(draft);
    const response = await calculation.run({
      workflow: "dca",
      assets: [{ assetId: selectedAsset.id, assetType: selectedAsset.assetType }],
      params: input,
      refresh: true,
    });
    if (!response?.result) return;

    writeDcaResultCache({
      marketId,
      language,
      asset: response.result.asset,
      input: { ...response.result.input, name: response.result.input.name ?? input.name },
      simulation: response.result.simulation,
      editingPlanId: editingId,
    });
    navigate(`/dca/result?market=${marketId}&lang=${language}`, { state: createReturnToState(locationToReturnTo(location)) });
  }

  async function savePlanFromDraft() {
    if (!selectedAsset) {
      setStatus(t(language, "dca.selectAssetEmpty"));
      return;
    }
    const input = normalizeDcaDraft({ ...draft, fundId: selectedAsset.id });
    setSavingPlan(true);
    setStatus(editingId ? t(language, "dca.updating") : t(language, "dca.saving"));
    try {
      if (editingId) {
        await dca.updatePlan(editingId, input);
        setStatus(t(language, "dca.updated"));
      } else {
        await dca.savePlan(input);
        setStatus(t(language, "dca.saved"));
      }
    } catch (error) {
      setStatus(apiErrorMessage(error));
    } finally {
      setSavingPlan(false);
    }
  }

  function editPlan(plan: DcaPlan) {
    setEditingId(plan.id);
    setDraft(draftFromDcaInput({ ...plan.input, name: plan.name }));
    setSelectedAsset(assetFromFund(plan.fund));
    resetCalculation();
    setStatus(t(language, "dca.editingPlan", { name: plan.name }));
  }

  async function deletePlan(planId: string) {
    setStatus(t(language, "dca.deletePlan"));
    try {
      await dca.deletePlan(planId);
      setStatus(t(language, "dca.deleted"));
    } catch (error) {
      setStatus(apiErrorMessage(error));
    }
  }

  return (
    <WorkbenchLayout
      pool={
        <WorkbenchPanel
          title={t(language, "dca.assetPool")}
          subtitle={t(language, "dca.assetPoolSubtitle")}
          className="flex min-h-[38rem] flex-col xl:h-[40rem]"
        >
          <input
            className={inputClassName}
            placeholder={t(language, "discover.placeholder")}
            value={assetSearch.filters.q}
            onChange={(event) => assetSearch.setFilters({ q: event.target.value })}
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <FieldLabel label={t(language, "dca.filterAssetType")}>
              <CustomSelect
                ariaLabel={t(language, "dca.filterAssetType")}
                value={assetSearch.filters.type}
                options={assetTypes.map((type) => ({ value: type, label: assetSearchTypeLabel(language, type) }))}
                onChange={(type) => assetSearch.setFilters({ type, industry: "", fundType: "" })}
              />
            </FieldLabel>
            <FieldLabel label={t(language, "dca.filterIndustry")}>
              <CustomSelect
                ariaLabel={t(language, "dca.filterIndustry")}
                value={assetSearch.filters.industry}
                options={[
                  { value: "", label: t(language, "common.allSectors") },
                  ...categoryOptions.map((item) => ({
                    value: item,
                    label: `${localizedAssetSector(item, language)}${categoryCounts[item] ? ` (${categoryCounts[item].toLocaleString(locale)})` : ""}`,
                  })),
                ]}
                onChange={(industry) => assetSearch.setFilters({ industry })}
              />
            </FieldLabel>
            <FieldLabel label={t(language, "dca.filterFundType")}>
              <CustomSelect
                ariaLabel={t(language, "dca.filterFundType")}
                value={assetSearch.filters.fundType}
                options={[
                  { value: "", label: t(language, "dca.allFundTypes") },
                  ...fundTypeOptions.map((item) => ({ value: item, label: item })),
                ]}
                onChange={(fundType) => assetSearch.setFilters({ fundType })}
              />
            </FieldLabel>
            <FieldLabel label={t(language, "dca.sort")}>
              <CustomSelect
                ariaLabel={t(language, "dca.sort")}
                value={assetSearch.filters.sort}
                options={sortOptions.map((item) => ({ value: item.value, label: t(language, item.labelKey) }))}
                onChange={(sort) => assetSearch.setFilters({ sort })}
              />
            </FieldLabel>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span>{assetSearch.loading && !assetSearch.data ? t(language, "dca.loadingAssets") : t(language, "dca.assetPoolSummary", { total: totalResults.toLocaleString(locale), count: assetResults.length.toLocaleString(locale) })}</span>
            {(assetSearch.filters.q || assetSearch.filters.type !== "all" || assetSearch.filters.industry || assetSearch.filters.fundType || assetSearch.filters.sort !== "popularity") ? (
              <button
                type="button"
                onClick={() => assetSearch.setFilters({ q: "", type: "all", industry: "", fundType: "", sort: "popularity", page: 1 })}
                className="h-7 rounded border border-zinc-200 px-2 font-medium text-zinc-600 hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/10 dark:hover:text-white"
              >
                {t(language, "discover.clearFilters")}
              </button>
            ) : null}
          </div>
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="grid gap-3 md:grid-cols-2">
              {assetSearch.loading && assetResults.length === 0 ? <AssetCardSkeletons /> : null}
              {assetResults.map((asset) => {
                const selected = selectedAsset?.id === asset.id;
                return (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => selectAsset(asset)}
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
                      <span className="rounded bg-zinc-100 px-2 py-1 dark:bg-white/10">{formatOptionalCurrency(asset.latestPrice, marketId)}</span>
                      {asset.dailyChange != null ? <span className="rounded bg-zinc-100 px-2 py-1 dark:bg-white/10">{formatOptionalPercent(asset.dailyChange)}</span> : null}
                    </div>
                  </button>
                );
              })}
            </div>
            {!assetSearch.loading && assetSearch.data && totalPages > 1 ? (
              <div className="mt-3 flex items-center justify-between rounded border border-zinc-200 bg-white p-2 text-xs dark:border-white/10 dark:bg-white/[0.03]">
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => assetSearch.setPage(currentPage - 1)}
                  className="h-8 rounded border border-zinc-200 px-2 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:text-zinc-200 dark:disabled:text-zinc-500"
                >
                  {t(language, "common.previous")}
                </button>
                <span className="text-zinc-500 dark:text-zinc-400">{t(language, "common.pageOf", { page: currentPage, totalPages })}</span>
                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() => assetSearch.setPage(currentPage + 1)}
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
        <WorkbenchPanel title={t(language, "dca.planControls")} subtitle={editingId ? t(language, "dca.planEditing") : t(language, "dca.planDraftParameters")} className="flex min-h-[38rem] flex-col xl:h-[40rem]">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <SelectedAssetList
              assets={selectedAsset ? [selectedAsset] : []}
              language={language}
              emptyLabel={t(language, "dca.selectAssetEmpty")}
              onRemove={() => {
                setSelectedAsset(null);
                updateDraft("fundId", "");
              }}
            />
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <FieldLabel label={t(language, "common.name")}>
                <input className={inputClassName} value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} />
              </FieldLabel>
              <FieldLabel label={t(language, "dca.initialAmount")}>
                <input type="number" min="0" className={inputClassName} value={draft.initialAmount} onChange={(event) => updateDraft("initialAmount", event.target.value)} onBlur={() => updateDraft("initialAmount", normalizeNumericInput(draft.initialAmount))} />
              </FieldLabel>
              <FieldLabel label={t(language, "dca.recurringAmount")}>
                <input type="number" min="0" className={inputClassName} value={draft.recurringAmount} onChange={(event) => updateDraft("recurringAmount", event.target.value)} onBlur={() => updateDraft("recurringAmount", normalizeNumericInput(draft.recurringAmount))} />
              </FieldLabel>
              <FieldLabel label={t(language, "dca.frequency")}>
                <CustomSelect
                  ariaLabel={t(language, "dca.frequency")}
                  value={draft.frequency}
                  options={frequencies.map((frequency) => ({ value: frequency, label: frequencyLabel(language, frequency) }))}
                  onChange={(frequency) => updateDraft("frequency", frequency)}
                />
              </FieldLabel>
              <FieldLabel label={t(language, "dca.startDate")}>
                <input type="date" className={inputClassName} value={draft.startDate} onChange={(event) => updateDraft("startDate", event.target.value)} />
              </FieldLabel>
              <FieldLabel label={t(language, "dca.endDate")}>
                <input type="date" className={inputClassName} value={draft.endDate} onChange={(event) => updateDraft("endDate", event.target.value)} />
              </FieldLabel>
              <FieldLabel label={t(language, "dca.strategy")}>
                <CustomSelect
                  ariaLabel={t(language, "dca.strategy")}
                  value={draft.strategy}
                  options={strategies.map((strategy) => ({ value: strategy, label: strategyLabel(language, strategy) }))}
                  onChange={(strategy) => updateDraft("strategy", strategy)}
                />
              </FieldLabel>
              <FieldLabel label={t(language, "dca.transactionCost")}>
                <input type="number" min="0" className={inputClassName} value={draft.transactionCost} onChange={(event) => updateDraft("transactionCost", event.target.value)} onBlur={() => updateDraft("transactionCost", normalizeNumericInput(draft.transactionCost))} />
              </FieldLabel>
            </div>
            <label className="mt-3 flex h-10 items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input type="checkbox" checked={draft.reinvestDividends} onChange={(event) => updateDraft("reinvestDividends", event.target.checked)} />
              {t(language, "dca.reinvestDividends")}
            </label>
            <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-white/10">
              <div className="grid grid-cols-2 gap-x-5 gap-y-3">
                <PreviewMetric label={t(language, "dca.plannedBuys")} value={formatNumber(preview.purchaseCount)} />
                <PreviewMetric label={t(language, "dca.recurringLegs")} value={formatNumber(preview.recurringCount)} />
                <PreviewMetric label={t(language, "dca.budget")} value={formatCurrency(preview.grossContribution, marketId)} />
                <PreviewMetric label={t(language, "dca.estimatedFees")} value={formatCurrency(preview.estimatedFees, marketId)} />
                <PreviewMetric label={t(language, "dca.netInvested")} value={formatCurrency(preview.netContribution, marketId)} />
                <PreviewMetric label={t(language, "common.history")} value={previewDuration} />
              </div>
            </div>
            <div className="mt-4 border-t border-zinc-100 pt-4 text-sm leading-6 text-zinc-500 dark:border-white/10 dark:text-zinc-400">
              <div className="font-medium text-zinc-700 dark:text-zinc-200">{strategyLabel(language, draft.strategy)}</div>
              <p className="mt-1">{strategyDescription(language, draft)}</p>
            </div>
            <div className="mt-4 flex flex-col gap-2 border-t border-zinc-100 pt-4 dark:border-white/10 sm:flex-row">
              <button
                type="button"
                disabled={!selectedAsset || savingPlan}
                onClick={savePlanFromDraft}
                className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
              >
                <Save size={16} />
                {editingId ? t(language, "dca.updatePlan") : t(language, "dca.savePlan")}
              </button>
            </div>
            <div className="pt-4">
              <CalculationStatus
                running={calculation.running}
                error={calculation.error ?? dca.error}
                warnings={calculation.warnings}
                idle={status}
                success={calculation.data ? t(language, "dca.status.openingResult") : undefined}
                runningLabel={t(language, "dca.status.calculating")}
                warningsLabel={t(language, "dca.status.warning")}
              />
            </div>
          </div>
        </WorkbenchPanel>
      }
      results={
        <WorkbenchPanel title={t(language, "dca.savedPlans")} subtitle={t(language, "dca.savedPlansSubtitle", { count: plans.length })}>
          {dca.loading ? <LoadingRows rows={3} /> : null}
          {!dca.loading && plans.length === 0 ? <StatusBanner title={t(language, "dca.noSavedTitle")} body={t(language, "dca.noSavedBody")} /> : null}
          <div className="grid gap-3">
            {plans.map((plan) => (
              <div
                key={plan.id}
                role="button"
                tabIndex={0}
                onClick={() => editPlan(plan)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    editPlan(plan);
                  }
                }}
                className={`cursor-pointer rounded-lg border p-4 text-left transition hover:border-emerald-300 hover:bg-emerald-50/40 dark:hover:border-emerald-400/40 dark:hover:bg-emerald-400/10 ${editingId === plan.id ? "border-emerald-400 bg-emerald-50 dark:border-emerald-400/50 dark:bg-emerald-400/10" : "border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]"}`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="font-semibold text-zinc-950 dark:text-white">{plan.name}</div>
                    <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{plan.fund.symbol} · {strategyLabel(language, plan.strategy ?? "standard")}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onKeyDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        deletePlan(plan.id);
                      }}
                      className="inline-flex h-10 items-center justify-center rounded border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200 dark:hover:bg-white/10"
                    >
                      {t(language, "common.remove")}
                    </button>
                  </div>
                </div>
                {plan.simulationSnapshot ? <ToneText tone={plan.simulationSnapshot.totalReturnPercent >= 0 ? "positive" : "negative"} marketTone>{formatPercent(plan.simulationSnapshot.totalReturnPercent)} · {formatCurrency(plan.simulationSnapshot.finalValue, marketId)}</ToneText> : null}
              </div>
            ))}
          </div>
        </WorkbenchPanel>
      }
      actions={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-zinc-500 dark:text-zinc-400">{selectedAsset ? t(language, "dca.selectedAsset", { symbol: selectedAsset.symbol }) : t(language, "dca.noAssetSelected")}</div>
          <CalculateButton disabled={!selectedAsset} running={calculation.running} onClick={runCalculation}>{t(language, "dca.calculate")}</CalculateButton>
        </div>
      }
    />
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

function buildPlanPreview(draft: DcaDraft): PlanPreview {
  const dates = buildPreviewContributionDates(draft.startDate, draft.endDate, draft.frequency);
  const purchaseCount = dates.length;
  const recurringCount = Math.max(0, purchaseCount - 1);
  const initialAmount = numericDraftValue(draft.initialAmount);
  const recurringAmount = numericDraftValue(draft.recurringAmount);
  const transactionCost = numericDraftValue(draft.transactionCost);
  const grossContribution = Math.max(0, initialAmount) + Math.max(0, recurringAmount) * recurringCount;
  const estimatedFees = Math.min(Math.max(0, transactionCost) * purchaseCount, grossContribution);
  return {
    purchaseCount,
    recurringCount,
    grossContribution,
    estimatedFees,
    netContribution: Math.max(0, grossContribution - estimatedFees),
    durationDays: durationDays(draft.startDate, draft.endDate),
  };
}

function draftFromDcaInput(input: DcaInput & { name?: string }): DcaDraft {
  return {
    ...input,
    name: input.name ?? "",
    startDate: input.startDate || defaultStartDate(),
    endDate: input.endDate || todayDate(),
    initialAmount: String(input.initialAmount ?? 0),
    recurringAmount: String(input.recurringAmount ?? 0),
    transactionCost: String(input.transactionCost ?? 0),
  };
}

function normalizeDcaDraft(draft: DcaDraft): DcaInput & { name: string } {
  return {
    ...draft,
    initialAmount: numericDraftValue(draft.initialAmount),
    recurringAmount: numericDraftValue(draft.recurringAmount),
    transactionCost: numericDraftValue(draft.transactionCost),
  };
}

function normalizeNumericInput(value: string) {
  return String(numericDraftValue(value));
}

function numericDraftValue(value: string) {
  if (!value.trim()) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function buildPreviewContributionDates(startDate: string, endDate: string, frequency: Frequency) {
  const dates: string[] = [];
  const start = parseDate(startDate);
  let cursor = start;
  const end = parseDate(endDate);
  if (!cursor || !end || cursor > end) return dates;
  const anchor = cursor;
  let monthOffset = 0;

  while (cursor <= end && dates.length < 1000) {
    dates.push(cursor.toISOString().slice(0, 10));
    if (frequency === "weekly") cursor = addDays(cursor, 7);
    else if (frequency === "biweekly") cursor = addDays(cursor, 14);
    else if (frequency === "quarterly") {
      monthOffset += 3;
      cursor = addMonths(anchor, monthOffset);
    } else if (frequency === "yearly") {
      monthOffset += 12;
      cursor = addMonths(anchor, monthOffset);
    } else {
      monthOffset += 1;
      cursor = addMonths(anchor, monthOffset);
    }
  }
  return dates;
}

function parseDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date: Date, months: number) {
  const monthIndex = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

function durationDays(startDate: string, endDate: string) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!start || !end || start > end) return 0;
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}

function uniqueOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function assetSearchTypeLabel(language: Language, type: AssetSearchType) {
  return type === "all" ? t(language, "assetType.all") : assetTypeLabel(language, type);
}

function strategyDescription(language: Language, draft: DcaDraft) {
  const dividendText = draft.reinvestDividends
    ? t(language, "dca.dividendReinvestDescription")
    : t(language, "dca.dividendRetainedDescription");
  if (draft.strategy === "drawdown-addon") return t(language, "dca.strategyDrawdownDescription", { dividend: dividendText });
  if (draft.strategy === "target-return") return t(language, "dca.strategyTargetDescription", { dividend: dividendText });
  if (draft.strategy === "dividend-reinvest") return t(language, "dca.strategyDividendDescription");
  if (draft.strategy === "custom") return t(language, "dca.strategyCustomDescription");
  return t(language, "dca.strategyStandardDescription", { dividend: dividendText });
}

function assetFromFund(fund: DcaPlan["fund"]): AssetRecord {
  const fundWithKind = fund as Fund & { assetType?: AssetRecord["assetType"]; kind?: AssetRecord["kind"] };
  return {
    id: fund.id,
    marketId: fund.marketId,
    assetType: fundWithKind.assetType ?? "fund",
    kind: fundWithKind.kind ?? "fund",
    name: fund.name,
    symbol: fund.symbol,
    aliases: [fund.symbol, fund.name],
    industry: fund.style,
    sector: fund.category,
    category: fund.category,
    fundType: fund.type,
    latestPrice: fund.nav,
    latestVolume: null,
    dailyChange: fund.dailyChange,
    popularity: 0,
    source: "local-db",
    quoteStatus: "fresh",
    updatedAt: new Date().toISOString(),
  };
}
