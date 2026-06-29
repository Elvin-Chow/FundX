"use client";

import { useCallback } from "react";
import { apiGet } from "@/lib/api-client";
import type { AssetDetailResponse, WatchlistResponse } from "@/lib/api-contracts";
import { dispatchMarketDataRefresh } from "@/lib/market-data-refresh-event";
import type { AssetType, MarketId, WatchlistItem } from "@/lib/types";
import {
  buildLocalWatchlistResponse,
  deleteLocalWatchlistItem,
  upsertLocalWatchlistItem,
} from "@/lib/local-user-data";
import { useApiResource } from "./use-api-resource";

export function useWatchlist(marketId: MarketId) {
  const load = useCallback(
    (_signal: AbortSignal) => Promise.resolve(buildLocalWatchlistResponse(marketId) satisfies WatchlistResponse),
    [marketId],
  );
  const resource = useApiResource(load, [load], { keepPreviousData: false });

  async function addItem(input: { assetId: string; assetType: AssetType; note?: string; target?: number }) {
    const previous = resource.data;
    if (previous) {
      resource.setData({
        ...previous,
        view: previous.view.map((item) => item.assetId === input.assetId ? { ...item, reason: input.note ?? item.reason, target: input.target ?? item.target } : item),
      });
    }
    const detail = await apiGet<AssetDetailResponse>(`/api/assets/${input.assetId}`, { market: marketId, type: input.assetType }).catch(() => null);
    upsertLocalWatchlistItem(marketId, input, detail?.asset ?? { id: input.assetId, assetType: input.assetType }, detail?.history ?? []);
    await resource.refresh("reload");
  }

  async function removeItem(id: string) {
    const previous = resource.data;
    if (previous) {
      resource.setData({
        ...previous,
        watchlist: previous.watchlist.filter((item) => item.id !== id && item.assetId !== id),
        view: previous.view.filter((item) => item.id !== id && item.assetId !== id),
      });
    }
    deleteLocalWatchlistItem(marketId, id);
    await resource.refresh("reload");
  }

  async function refreshPrices(options: { forceRefresh?: boolean } = {}) {
    const current = buildLocalWatchlistResponse(marketId);
    const results: Array<{ detail: AssetDetailResponse; item: WatchlistItem } | { error: unknown; item: WatchlistItem }> = await Promise.all(current.watchlist.map(async (item) => {
      const detail = await apiGet<AssetDetailResponse>(`/api/assets/${item.assetId}`, {
        market: marketId,
        type: item.assetType,
        refresh: true,
        ...(options.forceRefresh ? { forceRefresh: true } : {}),
        range: "1mo",
      }).catch((error) => ({ error, item }));
      if ("asset" in detail) {
        upsertLocalWatchlistItem(marketId, {
          assetId: item.assetId,
          assetType: item.assetType,
          note: item.note,
          target: item.target,
          group: item.group,
        }, detail.asset, detail.history);
        return { detail, item };
      }
      return { error: detail.error, item };
    }));
    const cached = results.flatMap((item) => {
      if ("error" in item) return [];
      return (item.detail.refreshResult?.cached ?? []).map((cachedItem) => ({
        assetId: cachedItem.assetId ?? item.item.assetId,
        reason: cachedItem.reason,
      }));
    });
    const failed = results.flatMap((item) => {
      if ("error" in item) return [{ assetId: item.item.assetId, reason: "Refresh failed" }];
      const failures = item.detail.refreshResult?.failed ?? [];
      return failures.map((failure) => ({
        assetId: failure.assetId ?? item.item.assetId,
        reason: failure.reason,
      }));
    });
    const changedAssetIds = results.flatMap((item) => (
      "detail" in item && (item.detail.refreshResult?.fetched ?? 0) > 0 ? [item.detail.asset.id] : []
    ));
    const source = results.find((item): item is { detail: AssetDetailResponse; item: WatchlistItem } => "detail" in item && Boolean(item.detail.refreshResult?.source))?.detail.refreshResult?.source ?? "browser-local";
    const response: WatchlistResponse = {
      ...buildLocalWatchlistResponse(marketId),
      refreshResult: {
        fetched: changedAssetIds.length,
        cached,
        failed,
        source,
      },
    };
    resource.setData(response);
    const refreshResult = response.refreshResult;
    if (changedAssetIds.length && refreshResult) {
      dispatchMarketDataRefresh({
        marketId,
        assetIds: changedAssetIds,
        scopes: ["watchlist", "asset"],
        result: refreshResult,
        source: refreshResult.source,
      });
    }
    return response;
  }

  return { ...resource, addItem, removeItem, refreshPrices };
}
