"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MARKET_LATEST_REFRESH_EVENT } from "@/hooks/use-market-latest-refresh";
import { apiGet, apiPost } from "@/lib/api-client";
import type { AssetSearchResponse, AssetSearchType, JobsResponse } from "@/lib/api-contracts";
import type { MarketId, SearchSortKey } from "@/lib/types";
import { useApiResource } from "./use-api-resource";

export type AssetSearchFilters = {
  q: string;
  type: AssetSearchType;
  industry: string;
  fundType: string;
  sort: SearchSortKey;
  page: number;
  pageSize: number;
};

export function useAssetsSearch(marketId: MarketId, initial: Partial<AssetSearchFilters> = {}) {
  const [filters, setFilters] = useState<AssetSearchFilters>({
    q: "",
    type: "all",
    industry: "",
    fundType: "",
    sort: "relevance",
    page: 1,
    pageSize: 12,
    ...initial,
  });
  const [debouncedQuery, setDebouncedQuery] = useState(filters.q.trim());
  const previousMarketId = useRef(marketId);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(filters.q.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [filters.q]);

  useEffect(() => {
    if (previousMarketId.current === marketId) return;
    previousMarketId.current = marketId;
    setFilters((current) => ({ ...current, industry: "", fundType: "", page: 1 }));
  }, [marketId]);

  const params = useMemo(() => ({ market: marketId, ...filters, q: debouncedQuery }), [debouncedQuery, filters, marketId]);
  const cacheKey = useMemo(() => `assets-search:${JSON.stringify(params)}`, [params]);
  const load = useCallback(
    (signal: AbortSignal) => apiGet<AssetSearchResponse>("/api/assets/search", params, signal),
    [params],
  );
  const resource = useApiResource(load, [load], { cacheKey, keepPreviousData: true, staleTimeMs: 30_000 });
  const refreshResource = resource.refresh;

  useEffect(() => {
    function handleMarketLatestRefresh(event: Event) {
      const detail = (event as CustomEvent<{ marketId?: MarketId }>).detail;
      if (detail?.marketId !== marketId) return;
      void refreshResource("reload");
    }

    window.addEventListener(MARKET_LATEST_REFRESH_EVENT, handleMarketLatestRefresh);
    return () => window.removeEventListener(MARKET_LATEST_REFRESH_EVENT, handleMarketLatestRefresh);
  }, [marketId, refreshResource]);

  const updateFilters = useCallback((next: Partial<AssetSearchFilters>) => {
    setFilters((current) => ({ ...current, ...next, page: next.page ?? 1 }));
  }, []);

  const setPage = useCallback((page: number) => {
    setFilters((current) => ({ ...current, page }));
  }, []);

  const refreshPublicData = useCallback(async () => {
    const response = await apiPost<JobsResponse>("/api/jobs", { marketId, type: "sync-universe" }, { market: marketId });
    await refreshResource("reload");
    return response;
  }, [marketId, refreshResource]);

  return {
    ...resource,
    filters,
    setFilters: updateFilters,
    setPage,
    refreshPublicData,
  };
}
