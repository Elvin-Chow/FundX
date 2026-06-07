import type { Language } from "@/lib/i18n";
import type { AssetRecord, MarketId, TimePoint } from "@/lib/types";

export type FundCompareItem = {
  asset: AssetRecord;
  history: TimePoint[];
  metrics: {
    return: number;
    volatility: number;
    maxDrawdown: number;
    riskScore: number;
    dividendYield: number;
    expenseRatio: number;
  };
  allocation: Array<{ name: string; weight: number }>;
  holdings: Array<{ name: string; symbol: string; weight: number; sector: string }>;
};

export type FundCompareResult = {
  items: FundCompareItem[];
};

export type CompareResultCache = {
  marketId: MarketId;
  language: Language;
  selectedIds: string[];
  selectedAssets: AssetRecord[];
  result: FundCompareResult;
  savedAt: string;
};

const cacheKey = (marketId: MarketId) => `fundx:compare:last-result:${marketId}`;

export function writeCompareResultCache(result: Omit<CompareResultCache, "savedAt">) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(cacheKey(result.marketId), JSON.stringify({ ...result, savedAt: new Date().toISOString() }));
}

export function readCompareResultCache(marketId: MarketId): CompareResultCache | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(cacheKey(marketId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as CompareResultCache;
    if (parsed.marketId !== marketId || !Array.isArray(parsed.result?.items) || !Array.isArray(parsed.selectedIds)) return null;
    return parsed;
  } catch {
    return null;
  }
}
