"use client";

import { useCallback } from "react";
import { apiGet } from "@/lib/api-client";
import type { AssetDetailResponse, WatchlistResponse } from "@/lib/api-contracts";
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

  async function refreshPrices() {
    const current = buildLocalWatchlistResponse(marketId);
    const results: Array<{ ok: true } | { ok: false; item: WatchlistItem }> = await Promise.all(current.watchlist.map(async (item) => {
      const detail = await apiGet<AssetDetailResponse>(`/api/assets/${item.assetId}`, {
        market: marketId,
        type: item.assetType,
        refresh: true,
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
        return { ok: true };
      }
      return { ok: false, item };
    }));
    const response: WatchlistResponse = {
      ...buildLocalWatchlistResponse(marketId),
      refreshResult: {
        fetched: results.filter((item) => item.ok).length,
        failed: results.flatMap((item) => item.ok ? [] : [{ assetId: item.item.assetId, reason: "Refresh failed" }]),
        source: "browser-local",
      },
    };
    resource.setData(response);
    return response;
  }

  return { ...resource, addItem, removeItem, refreshPrices };
}
