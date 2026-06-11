"use client";

import { useEffect } from "react";
import { apiPost } from "@/lib/api-client";
import type { JobsResponse } from "@/lib/api-contracts";
import type { MarketId } from "@/lib/types";

export const MARKET_LATEST_REFRESH_EVENT = "fundx:market-latest-refreshed";

const MARKET_LATEST_AUTO_CHECK_MS = 5 * 60 * 1000;
const MARKET_LATEST_INITIAL_DELAY_MS = 15_000;
const marketLatestInFlight = new Set<MarketId>();
const marketLatestCheckMemory = new Map<MarketId, number>();

export function useMarketLatestRefresh(marketId: MarketId) {
  useEffect(() => {
    let stopped = false;

    function run() {
      if (isDocumentHidden()) return;
      if (!isMarketLatestAutoWindow()) return;
      if (!claimMarketLatestRefreshCheck(marketId)) return;
      void apiPost<JobsResponse>("/api/jobs", { marketId, type: "sync-market-latest" }, { market: marketId })
        .then((response) => {
          const result = response.job?.result;
          if (!stopped && marketLatestJobUpdatedData(result)) {
            window.dispatchEvent(new CustomEvent(MARKET_LATEST_REFRESH_EVENT, { detail: { marketId, result } }));
          }
        })
        .catch(() => {
          return;
        })
        .finally(() => {
          marketLatestInFlight.delete(marketId);
        });
    }

    const initialTimer = window.setTimeout(run, MARKET_LATEST_INITIAL_DELAY_MS);
    const interval = window.setInterval(run, MARKET_LATEST_AUTO_CHECK_MS);
    return () => {
      stopped = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [marketId]);
}

function claimMarketLatestRefreshCheck(marketId: MarketId) {
  if (marketLatestInFlight.has(marketId)) return false;
  if (Date.now() - readLastMarketLatestCheck(marketId) < MARKET_LATEST_AUTO_CHECK_MS) return false;
  marketLatestInFlight.add(marketId);
  writeLastMarketLatestCheck(marketId);
  return true;
}

function readLastMarketLatestCheck(marketId: MarketId) {
  const memoryValue = marketLatestCheckMemory.get(marketId) ?? 0;
  if (typeof window === "undefined") return memoryValue;
  try {
    const parsed = Number(window.localStorage.getItem(marketLatestRefreshKey(marketId)));
    return Number.isFinite(parsed) ? Math.max(parsed, memoryValue) : memoryValue;
  } catch {
    return memoryValue;
  }
}

function writeLastMarketLatestCheck(marketId: MarketId) {
  const checkedAt = Date.now();
  marketLatestCheckMemory.set(marketId, checkedAt);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(marketLatestRefreshKey(marketId), String(checkedAt));
  } catch {
    return;
  }
}

function marketLatestRefreshKey(marketId: MarketId) {
  return `fundx-market-latest-check:${marketId}`;
}

function marketLatestJobUpdatedData(result: Record<string, unknown> | undefined) {
  if (!result || result.skipped) return false;
  return numericResult(result.fetched) > 0 || numericResult(result.synced) > 0;
}

function numericResult(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isDocumentHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function isMarketLatestAutoWindow(now = new Date()) {
  const parts = easternTimeParts(now);
  if (!parts || parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = parts.hour * 60 + parts.minute;
  return (minutes >= 9 * 60 + 30 && minutes <= 11 * 60) || (minutes >= 16 * 60 && minutes <= 17 * 60 + 30);
}

function easternTimeParts(date: Date) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { weekday: values.weekday, hour, minute };
  } catch {
    return null;
  }
}
