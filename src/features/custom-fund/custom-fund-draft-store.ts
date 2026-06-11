import type { Language } from "@/lib/i18n";
import type { AssetRecord, MarketId, PortfolioDcaPlan } from "@/lib/types";
import { defaultStartDate, todayDate } from "@/lib/utils";

export type CustomFundDraftCache = {
  marketId: MarketId;
  language: Language;
  editingId: string | null;
  selectedAssets: AssetRecord[];
  weights: Record<string, number>;
  dcaPlans: Record<string, PortfolioDcaPlan>;
  draft: {
    name: string;
    style: string;
    capital: string;
    cashBalance: string;
    startDate: string;
    endDate: string;
  };
  savedAt: string;
};

const cacheKey = (marketId: MarketId) => `fundx:custom-fund:draft:${marketId}`;

export function writeCustomFundDraftCache(cache: Omit<CustomFundDraftCache, "savedAt">) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(cacheKey(cache.marketId), JSON.stringify({ ...cache, savedAt: new Date().toISOString() }));
}

export function clearCustomFundDraftCache(marketId: MarketId) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(cacheKey(marketId));
}

export function readCustomFundDraftCache(marketId: MarketId): CustomFundDraftCache | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(cacheKey(marketId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as CustomFundDraftCache;
    if (parsed.marketId !== marketId || !Array.isArray(parsed.selectedAssets) || !parsed.draft) return null;
    parsed.draft = {
      ...parsed.draft,
      startDate: parsed.draft.startDate || defaultStartDate(),
      endDate: parsed.draft.endDate || todayDate(),
    };
    return parsed;
  } catch {
    return null;
  }
}
