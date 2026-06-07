import type { Language } from "@/lib/i18n";
import type { AssetRecord, MarketId, Portfolio, PortfolioDcaPlan, PortfolioSummary } from "@/lib/types";

export type PortfolioResultInput = {
  portfolioId?: string;
  name: string;
  goal: string;
  riskPreference: string;
  capital: number;
  cashBalance: number;
  startDate: string;
  endDate: string;
  weights: Record<string, number>;
  dcaPlans?: Record<string, PortfolioDcaPlan>;
};

export type PortfolioCalculationResult = {
  portfolio: Portfolio;
  summary: PortfolioSummary;
  savedPortfolio?: Portfolio | null;
};

export type PortfolioResultCache = {
  marketId: MarketId;
  language: Language;
  input: PortfolioResultInput;
  selectedAssets: AssetRecord[];
  result: PortfolioCalculationResult;
  activePortfolioId: string | null;
  savedAt: string;
};

const cacheKey = (marketId: MarketId) => `fundx:portfolio:last-result:${marketId}`;

export function writePortfolioResultCache(result: Omit<PortfolioResultCache, "savedAt">) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(cacheKey(result.marketId), JSON.stringify({ ...result, savedAt: new Date().toISOString() }));
}

export function readPortfolioResultCache(marketId: MarketId): PortfolioResultCache | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(cacheKey(marketId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PortfolioResultCache;
    if (parsed.marketId !== marketId || !parsed.result?.summary || !parsed.input || !Array.isArray(parsed.selectedAssets)) return null;
    return parsed;
  } catch {
    return null;
  }
}
