import type { Language } from "@/lib/i18n";
import type { DcaInput, DcaSimulation, Fund, MarketId } from "@/lib/types";

export type DcaResultCache = {
  marketId: MarketId;
  language: Language;
  asset: Fund;
  input: DcaInput & { name: string };
  simulation: DcaSimulation;
  editingPlanId: string | null;
  savedAt: string;
};

const cacheKey = (marketId: MarketId) => `fundx:dca:last-result:${marketId}`;

export function writeDcaResultCache(result: Omit<DcaResultCache, "savedAt">) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(cacheKey(result.marketId), JSON.stringify({ ...result, savedAt: new Date().toISOString() }));
}

export function readDcaResultCache(marketId: MarketId): DcaResultCache | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(cacheKey(marketId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as DcaResultCache;
    if (parsed.marketId !== marketId || !parsed.simulation || !parsed.input || !parsed.asset) return null;
    return parsed;
  } catch {
    return null;
  }
}
