"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { ArrowLeft, CalendarClock, Check, Power, RotateCcw } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { CustomSelect } from "@/components/custom-select";
import { useResolvedLanguage } from "@/hooks/use-language";
import { assetDisplayName, assetPrimaryCategory, quoteStatusLabel } from "@/lib/asset-display";
import { formatCurrency, formatNumber } from "@/lib/formatters";
import { frequencyLabel, strategyLabel, t, type Language } from "@/lib/i18n";
import { readReturnToState } from "@/lib/navigation-state";
import type { AssetRecord, DcaStrategy, Frequency, MarketId, PortfolioDcaPlan } from "@/lib/types";
import { StatusBanner } from "../shared/feature-shell";
import { FieldLabel, SecondaryButton, WorkbenchLayout, WorkbenchPanel, inputClassName } from "../shared/calculation-workbench";
import { readPortfolioDraftCache, writePortfolioDraftCache, type PortfolioDraftCache } from "./portfolio-draft-store";

const frequencies: Frequency[] = ["weekly", "biweekly", "monthly", "quarterly", "yearly"];
const strategies: DcaStrategy[] = ["standard", "drawdown-addon", "dividend-reinvest", "target-return", "custom"];
const DEFAULT_CAPITAL = 100000;
const LEGACY_DEFAULT_INITIAL_AMOUNT = 1000;
const DEFAULT_RECURRING_AMOUNT = 500;

type DcaAmountField = "initialAmount" | "recurringAmount" | "transactionCost";
type EditablePortfolioDcaPlan = Omit<PortfolioDcaPlan, DcaAmountField> & Record<DcaAmountField, string>;
type PlanContext = {
  capital: number;
  weights: Record<string, number>;
};

export function PortfolioDcaPlanPage({ marketId, language: languageProp = "en" }: { marketId: MarketId; language?: Language }) {
  const language = useResolvedLanguage(languageProp);
  const location = useLocation();
  const navigate = useNavigate();
  const [cache] = useState<PortfolioDraftCache | null>(() => readPortfolioDraftCache(marketId));
  const assets = useMemo(() => cache?.selectedAssets ?? [], [cache]);
  const planContext = useMemo<PlanContext>(() => ({
    capital: numericValue(cache?.draft.capital, DEFAULT_CAPITAL) || DEFAULT_CAPITAL,
    weights: cache?.weights ?? {},
  }), [cache]);
  const [plans, setPlans] = useState<Record<string, EditablePortfolioDcaPlan>>(() => ensurePlansForAssets(cache?.dcaPlans ?? {}, assets, planContext));
  const summary = useMemo(() => buildPlanSummary(assets, plans, planContext), [assets, planContext, plans]);
  const backHref = readReturnToState(location.state, `/portfolio?market=${marketId}&lang=${language}`);

  function returnToPortfolio() {
    navigate(backHref);
  }

  function applyPlans() {
    if (!cache) returnToPortfolio();
    if (!cache) return;
    writePortfolioDraftCache({
      marketId: cache.marketId,
      language,
      selectedPortfolioId: cache.selectedPortfolioId,
      selectedAssets: assets,
      weights: cache.weights,
      dcaPlans: ensureNumericPlansForAssets(plans, assets, planContext),
      draft: cache.draft,
    });
    returnToPortfolio();
  }

  function updatePlan(assetId: string, updates: Partial<EditablePortfolioDcaPlan>) {
    const asset = assets.find((item) => item.id === assetId);
    const defaultInitial = asset ? defaultInitialAmount(asset, planContext) : LEGACY_DEFAULT_INITIAL_AMOUNT;
    setPlans((current) => ({
      ...current,
      [assetId]: normalizeEditablePlan({ ...normalizeEditablePlan(current[assetId], defaultInitial), ...updates }, defaultInitial),
    }));
  }

  function enableAll(enabled: boolean) {
    setPlans((current) => Object.fromEntries(assets.map((asset) => {
      const defaultInitial = defaultInitialAmount(asset, planContext);
      return [asset.id, normalizeEditablePlan({ ...normalizeEditablePlan(current[asset.id], defaultInitial), enabled }, defaultInitial)];
    })));
  }

  function resetAll() {
    setPlans(Object.fromEntries(assets.map((asset) => [asset.id, defaultPlan(asset, planContext)])));
  }

  if (!cache || !assets.length) {
    return (
      <div className="space-y-5">
        <SecondaryButton onClick={returnToPortfolio}>
          <span className="inline-flex items-center gap-2"><ArrowLeft size={16} /> {t(language, "portfolio.returnToPortfolio")}</span>
        </SecondaryButton>
        <StatusBanner title={t(language, "portfolio.noDraftForDca")} body={t(language, "portfolio.noDraftForDcaBody")} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5 border-b border-zinc-200 pb-5 dark:border-white/10">
        <div className="mb-4">
          <SecondaryButton onClick={returnToPortfolio}>
            <span className="inline-flex items-center gap-2"><ArrowLeft size={16} /> {t(language, "portfolio.returnToPortfolio")}</span>
          </SecondaryButton>
        </div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">{t(language, "portfolio.dcaPlanTitle")}</div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white sm:text-4xl">{cache.draft.name}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500 dark:text-zinc-400 sm:text-base">{t(language, "portfolio.dcaPlanSubtitle")}</p>
      </div>
      <WorkbenchLayout
        align="start"
        pool={
          <WorkbenchPanel title={t(language, "portfolio.planSnapshot")} subtitle={t(language, "portfolio.dcaPlanSnapshotSubtitle")} className="flex min-h-[38rem] flex-col xl:h-[40rem]">
            <div className="grid grid-cols-2 gap-x-5 gap-y-4 border-b border-zinc-100 pb-4 dark:border-white/10">
              <PreviewMetric label={t(language, "portfolio.selectedFunds")} value={formatNumber(assets.length)} />
              <PreviewMetric label={t(language, "portfolio.enabledDcaPlans")} value={formatNumber(summary.enabledCount)} />
              <PreviewMetric label={t(language, "portfolio.totalInitialDca")} value={formatCurrency(summary.initialAmount, marketId)} />
              <PreviewMetric label={t(language, "portfolio.totalRecurringDca")} value={formatCurrency(summary.recurringAmount, marketId)} />
              <PreviewMetric label={t(language, "dca.startDate")} value={cache.draft.startDate} />
              <PreviewMetric label={t(language, "dca.endDate")} value={cache.draft.endDate} />
            </div>
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="space-y-2">
                {assets.map((asset) => {
                  const plan = normalizeNumericPlan(plans[asset.id], defaultInitialAmount(asset, planContext));
                  return (
                    <div key={asset.id} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.03]">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{assetDisplayName(asset, language)}</div>
                          <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{[asset.symbol, assetPrimaryCategory(asset, language), quoteStatusLabel(asset, language)].filter(Boolean).join(" · ")}</div>
                        </div>
                        <span className={`shrink-0 rounded px-2 py-1 text-xs font-medium ${plan.enabled ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300" : "bg-zinc-100 text-zinc-500 dark:bg-white/10 dark:text-zinc-400"}`}>
                          {plan.enabled ? t(language, "portfolio.dcaEnabled") : t(language, "portfolio.dcaDisabled")}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                        <span>{frequencyLabel(language, plan.frequency)}</span>
                        <span className="text-right">{formatCurrency(plan.recurringAmount, marketId)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </WorkbenchPanel>
        }
        controls={
          <WorkbenchPanel
            title={t(language, "portfolio.dcaPlanDetails")}
            subtitle={t(language, "portfolio.dcaPlanDetailsSubtitle")}
            className="flex min-h-[38rem] flex-col xl:h-[40rem]"
            action={
              <div className="flex gap-2">
                <IconButton label={t(language, "portfolio.enableAllDca")} onClick={() => enableAll(true)}><Power size={15} /></IconButton>
                <IconButton label={t(language, "portfolio.disableAllDca")} onClick={() => enableAll(false)}><Power size={15} /></IconButton>
                <IconButton label={t(language, "portfolio.resetDcaPlans")} onClick={resetAll}><RotateCcw size={15} /></IconButton>
              </div>
            }
          >
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="space-y-3">
                {assets.map((asset) => (
                  <PlanEditorCard
                    key={asset.id}
                    asset={asset}
                    plan={normalizeEditablePlan(plans[asset.id], defaultInitialAmount(asset, planContext))}
                    marketId={marketId}
                    language={language}
                    onChange={(updates) => updatePlan(asset.id, updates)}
                  />
                ))}
              </div>
            </div>
          </WorkbenchPanel>
        }
        actions={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-zinc-500 dark:text-zinc-400">
              {t(language, "portfolio.dcaPlanSummary", {
                count: formatNumber(summary.enabledCount),
                amount: formatCurrency(summary.recurringAmount, marketId),
              })}
            </div>
            <button
              type="button"
              onClick={applyPlans}
              className="inline-flex h-10 min-w-32 items-center justify-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              <Check size={16} />
              {t(language, "portfolio.applyDcaPlans")}
            </button>
          </div>
        }
      />
    </div>
  );
}

function PlanEditorCard({
  asset,
  plan,
  marketId,
  language,
  onChange,
}: {
  asset: AssetRecord;
  plan: EditablePortfolioDcaPlan;
  marketId: MarketId;
  language: Language;
  onChange: (updates: Partial<EditablePortfolioDcaPlan>) => void;
}) {
  const recurringAmount = numericAmount(plan.recurringAmount, 0);
  return (
    <section className={`rounded-lg border p-3 transition ${plan.enabled ? "border-emerald-300 bg-emerald-50/40 dark:border-emerald-400/40 dark:bg-emerald-400/10" : "border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]"}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CalendarClock size={16} className={plan.enabled ? "text-emerald-600" : "text-zinc-400"} />
            <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{assetDisplayName(asset, language)}</div>
          </div>
          <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{[asset.symbol, assetPrimaryCategory(asset, language)].filter(Boolean).join(" · ")}</div>
        </div>
        <label className="inline-flex h-9 shrink-0 items-center gap-2 rounded border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200">
          <input type="checkbox" checked={plan.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} />
          {plan.enabled ? t(language, "portfolio.dcaEnabled") : t(language, "portfolio.dcaDisabled")}
        </label>
      </div>
      {plan.enabled ? (
        <>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <FieldLabel label={t(language, "dca.initialAmount")}>
              <input type="number" min="0" className={inputClassName} value={plan.initialAmount} onChange={(event) => onChange({ initialAmount: event.target.value })} onBlur={() => onChange({ initialAmount: normalizeNumericInput(plan.initialAmount) })} />
            </FieldLabel>
            <FieldLabel label={t(language, "dca.recurringAmount")}>
              <input type="number" min="0" className={inputClassName} value={plan.recurringAmount} onChange={(event) => onChange({ recurringAmount: event.target.value })} onBlur={() => onChange({ recurringAmount: normalizeNumericInput(plan.recurringAmount) })} />
            </FieldLabel>
            <FieldLabel label={t(language, "dca.frequency")}>
              <CustomSelect
                ariaLabel={t(language, "dca.frequency")}
                value={plan.frequency}
                options={frequencies.map((frequency) => ({ value: frequency, label: frequencyLabel(language, frequency) }))}
                onChange={(frequency) => onChange({ frequency })}
              />
            </FieldLabel>
            <FieldLabel label={t(language, "dca.transactionCost")}>
              <input type="number" min="0" className={inputClassName} value={plan.transactionCost} onChange={(event) => onChange({ transactionCost: event.target.value })} onBlur={() => onChange({ transactionCost: normalizeNumericInput(plan.transactionCost) })} />
            </FieldLabel>
            <FieldLabel label={t(language, "dca.strategy")}>
              <CustomSelect
                ariaLabel={t(language, "dca.strategy")}
                value={plan.strategy ?? "standard"}
                options={strategies.map((strategy) => ({ value: strategy, label: strategyLabel(language, strategy) }))}
                onChange={(strategy) => onChange({ strategy })}
              />
            </FieldLabel>
            <label className="flex h-10 items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input type="checkbox" checked={plan.reinvestDividends} onChange={(event) => onChange({ reinvestDividends: event.target.checked })} />
              {t(language, "dca.reinvestDividends")}
            </label>
          </div>
          <div className="mt-3 rounded border border-white bg-white/80 px-3 py-2 text-xs text-zinc-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
            {t(language, "portfolio.dcaRecurringSummary", {
              amount: formatCurrency(recurringAmount, marketId),
              frequency: frequencyLabel(language, plan.frequency),
              strategy: strategyLabel(language, plan.strategy ?? "standard"),
            })}
          </div>
        </>
      ) : null}
    </section>
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

function IconButton({ label, children, onClick }: { label: string; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-9 w-9 items-center justify-center rounded border border-zinc-200 bg-white text-zinc-600 transition hover:bg-zinc-50 hover:text-zinc-950 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300 dark:hover:bg-white/10 dark:hover:text-white"
    >
      {children}
    </button>
  );
}

function ensurePlansForAssets(current: Record<string, PortfolioDcaPlan | EditablePortfolioDcaPlan>, assets: AssetRecord[], context: PlanContext) {
  return Object.fromEntries(assets.map((asset) => [asset.id, normalizeEditablePlan(current[asset.id], defaultInitialAmount(asset, context))]));
}

function ensureNumericPlansForAssets(current: Record<string, EditablePortfolioDcaPlan>, assets: AssetRecord[], context: PlanContext) {
  return Object.fromEntries(assets.map((asset) => [asset.id, normalizeNumericPlan(current[asset.id], defaultInitialAmount(asset, context))]));
}

function normalizeEditablePlan(plan?: Partial<PortfolioDcaPlan> | Partial<EditablePortfolioDcaPlan>, defaultInitial = LEGACY_DEFAULT_INITIAL_AMOUNT): EditablePortfolioDcaPlan {
  return {
    enabled: Boolean(plan?.enabled),
    initialAmount: editableAmount(initialAmountInput(plan, defaultInitial), defaultInitial),
    recurringAmount: editableAmount(plan?.recurringAmount, DEFAULT_RECURRING_AMOUNT),
    frequency: plan?.frequency ?? "monthly",
    transactionCost: editableAmount(plan?.transactionCost, 0),
    reinvestDividends: plan?.reinvestDividends ?? true,
    strategy: plan?.strategy ?? "standard",
  };
}

function normalizeNumericPlan(plan?: Partial<PortfolioDcaPlan> | Partial<EditablePortfolioDcaPlan>, defaultInitial = LEGACY_DEFAULT_INITIAL_AMOUNT): PortfolioDcaPlan {
  const normalized = normalizeEditablePlan(plan, defaultInitial);
  return {
    ...normalized,
    initialAmount: numericAmount(normalized.initialAmount, defaultInitial),
    recurringAmount: numericAmount(normalized.recurringAmount, DEFAULT_RECURRING_AMOUNT),
    transactionCost: numericAmount(normalized.transactionCost, 0),
  };
}

function defaultPlan(asset: AssetRecord, context: PlanContext) {
  return normalizeEditablePlan(undefined, defaultInitialAmount(asset, context));
}

function buildPlanSummary(assets: AssetRecord[], plans: Record<string, EditablePortfolioDcaPlan>, context: PlanContext) {
  const selectedPlans = assets.map((asset) => normalizeNumericPlan(plans[asset.id], defaultInitialAmount(asset, context))).filter((plan) => plan.enabled);
  return {
    enabledCount: selectedPlans.length,
    initialAmount: selectedPlans.reduce((total, plan) => total + plan.initialAmount, 0),
    recurringAmount: selectedPlans.reduce((total, plan) => total + plan.recurringAmount, 0),
  };
}

function initialAmountInput(plan: Partial<PortfolioDcaPlan> | Partial<EditablePortfolioDcaPlan> | undefined, defaultInitial: number) {
  if (!plan || plan.initialAmount == null) return defaultInitial;
  if (!plan.enabled) return defaultInitial;
  return plan.initialAmount;
}

function defaultInitialAmount(asset: AssetRecord, context: PlanContext) {
  const weight = context.weights[asset.id] ?? 0;
  if (!Number.isFinite(context.capital) || context.capital <= 0 || !Number.isFinite(weight) || weight <= 0) return LEGACY_DEFAULT_INITIAL_AMOUNT;
  return roundAmount(context.capital * (weight / 100));
}

function editableAmount(value: unknown, fallback: number) {
  if (value === "") return "";
  if (typeof value === "string") {
    if (!value.trim()) return "";
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? value : String(fallback);
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(number) : String(fallback);
}

function normalizeNumericInput(value: string) {
  return String(numericAmount(value, 0));
}

function numericAmount(value: unknown, fallback: number) {
  if (typeof value === "string" && !value.trim()) return 0;
  return numericValue(value, fallback);
}

function numericValue(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function roundAmount(value: number) {
  return Math.round(value * 100) / 100;
}
