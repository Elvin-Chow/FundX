import type { Language } from "@/lib/i18n";
import type { AssetRecord, CustomFundHolding, CustomFundScore, MarketId, Portfolio, PortfolioDcaPlan, PortfolioSummary } from "@/lib/types";

export type CustomFundResultInput = {
  customFundId?: string | null;
  name: string;
  style: string;
  capital: number;
  cashBalance: number;
  startDate: string;
  endDate: string;
  holdings: CustomFundHolding[];
  weights: Record<string, number>;
  dcaPlans?: Record<string, PortfolioDcaPlan>;
};

export type CustomFundCalculationResult = {
  name: string;
  style: string;
  holdings: CustomFundHolding[];
  score: CustomFundScore;
  assets: AssetRecord[];
  portfolio: Portfolio;
  summary: PortfolioSummary;
};

export type CustomFundResultCache = {
  marketId: MarketId;
  language: Language;
  input: CustomFundResultInput;
  selectedAssets: AssetRecord[];
  result: CustomFundCalculationResult;
  editingId: string | null;
  savedAt: string;
};

const cacheKey = (marketId: MarketId) => `fundx:custom-fund:last-result:${marketId}`;

export function writeCustomFundResultCache(result: Omit<CustomFundResultCache, "savedAt">) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(cacheKey(result.marketId), JSON.stringify({ ...result, savedAt: new Date().toISOString() }));
}

export function readCustomFundResultCache(marketId: MarketId): CustomFundResultCache | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(cacheKey(marketId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as CustomFundResultCache;
    if (parsed.marketId !== marketId || !parsed.result?.score || !parsed.input || !Array.isArray(parsed.selectedAssets)) return null;
    return parsed;
  } catch {
    return null;
  }
}
