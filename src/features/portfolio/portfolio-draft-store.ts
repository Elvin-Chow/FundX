import type { Language } from "@/lib/i18n";
import type { AssetRecord, MarketId, PortfolioDcaPlan } from "@/lib/types";

export type PortfolioDraftCache = {
  marketId: MarketId;
  language: Language;
  selectedPortfolioId: string;
  selectedAssets: AssetRecord[];
  weights: Record<string, number>;
  dcaPlans: Record<string, PortfolioDcaPlan>;
  draft: {
    name: string;
    goal: string;
    riskPreference: string;
    capital: string;
    cashBalance: string;
    startDate: string;
    endDate: string;
  };
  savedAt: string;
};

const cacheKey = (marketId: MarketId) => `fundx:portfolio:draft:${marketId}`;

export function writePortfolioDraftCache(cache: Omit<PortfolioDraftCache, "savedAt">) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(cacheKey(cache.marketId), JSON.stringify({ ...cache, savedAt: new Date().toISOString() }));
}

export function clearPortfolioDraftCache(marketId: MarketId) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(cacheKey(marketId));
}

export function readPortfolioDraftCache(marketId: MarketId): PortfolioDraftCache | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(cacheKey(marketId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PortfolioDraftCache;
    if (parsed.marketId !== marketId || !Array.isArray(parsed.selectedAssets) || !parsed.draft) return null;
    return parsed;
  } catch {
    return null;
  }
}
