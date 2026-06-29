import type { AssetType, MarketId } from "@/lib/types";

export const MARKET_DATA_REFRESH_EVENT = "fundx:market-data-refreshed";

export type MarketDataRefreshScope = "asset" | "home-display" | "market-latest" | "market-top" | "universe" | "watchlist";

export type MarketDataRefreshDetail = {
  marketId: MarketId;
  assetIds?: string[];
  assetTypes?: AssetType[];
  scopes?: MarketDataRefreshScope[];
  source?: string;
  result?: unknown;
};

export function dispatchMarketDataRefresh(detail: MarketDataRefreshDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MARKET_DATA_REFRESH_EVENT, { detail }));
}

export function marketDataRefreshDetail(event: Event) {
  return (event as CustomEvent<MarketDataRefreshDetail>).detail;
}

export function refreshResultChangedData(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const candidate = result as { fetched?: unknown; synced?: unknown; dailyPrices?: unknown };
  return numericResult(candidate.fetched) > 0 || numericResult(candidate.synced) > 0 || numericResult(candidate.dailyPrices) > 0;
}

function numericResult(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
