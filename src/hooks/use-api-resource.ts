"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiErrorMessage } from "@/lib/api-client";

export type ApiResourceState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reloading: boolean;
  updatedAt: string | null;
};

type CachedResource<T> = {
  data: T;
  updatedAt: string;
  updatedAtMs: number;
};

const resourceCache = new Map<string, CachedResource<unknown>>();
const resourceInFlight = new Map<string, Promise<unknown>>();
const DEFAULT_STALE_TIME_MS = 60_000;

export function useApiResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean; keepPreviousData?: boolean; cacheKey?: string; staleTimeMs?: number } = {},
) {
  const enabled = options.enabled ?? true;
  const keepPreviousData = options.keepPreviousData ?? true;
  const cacheKey = options.cacheKey;
  const staleTimeMs = options.staleTimeMs ?? DEFAULT_STALE_TIME_MS;
  const cached = cacheKey ? readFreshCache<T>(cacheKey, staleTimeMs) : null;
  const mounted = useRef(false);
  const [state, setState] = useState<ApiResourceState<T>>({
    data: cached?.data ?? null,
    error: null,
    loading: enabled && !cached,
    reloading: false,
    updatedAt: cached?.updatedAt ?? null,
  });

  const run = useCallback(
    async (mode: "initial" | "reload" = "reload") => {
      if (!enabled) return null;
      const controller = new AbortController();
      setState((current) => ({
        ...current,
        data: keepPreviousData ? current.data : null,
        error: null,
        loading: mode === "initial" && !current.data,
        reloading: mode === "reload" || Boolean(current.data),
      }));

      try {
        const data = await loadResource(load, controller.signal, cacheKey, staleTimeMs, true);
        setState({
          data,
          error: null,
          loading: false,
          reloading: false,
          updatedAt: new Date().toISOString(),
        });
        return data;
      } catch (error) {
        if (controller.signal.aborted) return null;
        setState((current) => ({
          ...current,
          error: apiErrorMessage(error),
          loading: false,
          reloading: false,
        }));
        return null;
      }
    },
    [cacheKey, enabled, keepPreviousData, load, staleTimeMs],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const freshCached = cacheKey ? readFreshCache<T>(cacheKey, staleTimeMs) : null;
    if (freshCached) {
      mounted.current = true;
      setState({
        data: freshCached.data,
        error: null,
        loading: false,
        reloading: false,
        updatedAt: freshCached.updatedAt,
      });
      return undefined;
    }
    const staleCached = cacheKey ? readAnyCache<T>(cacheKey) : null;
    let cancelled = false;
    setState((current) => ({
      ...current,
      data: keepPreviousData ? current.data ?? staleCached?.data ?? null : null,
      error: null,
      loading: !mounted.current || !(current.data ?? staleCached?.data),
      reloading: mounted.current && Boolean(current.data ?? staleCached?.data),
      updatedAt: current.updatedAt ?? staleCached?.updatedAt ?? null,
    }));

    loadResource(load, controller.signal, cacheKey, staleTimeMs, false)
      .then((data) => {
        if (controller.signal.aborted || cancelled) return;
        mounted.current = true;
        setState({
          data,
          error: null,
          loading: false,
          reloading: false,
          updatedAt: new Date().toISOString(),
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || cancelled) return;
        mounted.current = true;
        setState((current) => ({
          ...current,
          error: apiErrorMessage(error),
          loading: false,
          reloading: false,
        }));
      });

    return () => {
      cancelled = true;
      if (!cacheKey) controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    ...state,
    refresh: run,
    setData: (updater: T | ((current: T | null) => T | null)) => {
      setState((current) => ({
        ...current,
        data: updateCachedData(cacheKey, typeof updater === "function" ? (updater as (current: T | null) => T | null)(current.data) : updater),
      }));
    },
    setError: (error: string | null) => setState((current) => ({ ...current, error })),
  };
}

function readFreshCache<T>(cacheKey: string, staleTimeMs: number) {
  const cached = readAnyCache<T>(cacheKey);
  if (!cached) return null;
  return Date.now() - cached.updatedAtMs <= staleTimeMs ? cached : null;
}

function readAnyCache<T>(cacheKey: string) {
  return (resourceCache.get(cacheKey) as CachedResource<T> | undefined) ?? null;
}

function writeCache<T>(cacheKey: string | undefined, data: T) {
  if (!cacheKey) return;
  resourceCache.set(cacheKey, { data, updatedAt: new Date().toISOString(), updatedAtMs: Date.now() });
}

function updateCachedData<T>(cacheKey: string | undefined, data: T | null) {
  if (cacheKey && data !== null) {
    writeCache(cacheKey, data);
  } else if (cacheKey) {
    resourceCache.delete(cacheKey);
  }
  return data;
}

async function loadResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  cacheKey: string | undefined,
  staleTimeMs: number,
  force: boolean,
) {
  if (cacheKey && !force) {
    const cached = readFreshCache<T>(cacheKey, staleTimeMs);
    if (cached) return cached.data;
    const inFlight = resourceInFlight.get(cacheKey) as Promise<T> | undefined;
    if (inFlight) return inFlight;
  }

  const request = load(signal).then((data) => {
    writeCache(cacheKey, data);
    return data;
  });
  if (cacheKey) {
    resourceInFlight.set(cacheKey, request);
    request.then(() => {
      if (resourceInFlight.get(cacheKey) === request) {
        resourceInFlight.delete(cacheKey);
      }
    }, () => {
      if (resourceInFlight.get(cacheKey) === request) {
        resourceInFlight.delete(cacheKey);
      }
    });
  }
  return request;
}
