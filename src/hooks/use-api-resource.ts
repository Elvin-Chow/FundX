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

export function useApiResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean; keepPreviousData?: boolean } = {},
) {
  const enabled = options.enabled ?? true;
  const keepPreviousData = options.keepPreviousData ?? true;
  const mounted = useRef(false);
  const [state, setState] = useState<ApiResourceState<T>>({
    data: null,
    error: null,
    loading: enabled,
    reloading: false,
    updatedAt: null,
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
        const data = await load(controller.signal);
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
    [enabled, keepPreviousData, load],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    setState((current) => ({
      ...current,
      data: keepPreviousData ? current.data : null,
      error: null,
      loading: !mounted.current || !current.data,
      reloading: mounted.current && Boolean(current.data),
    }));

    load(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
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
        if (controller.signal.aborted) return;
        mounted.current = true;
        setState((current) => ({
          ...current,
          error: apiErrorMessage(error),
          loading: false,
          reloading: false,
        }));
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    ...state,
    refresh: run,
    setData: (updater: T | ((current: T | null) => T | null)) => {
      setState((current) => ({
        ...current,
        data: typeof updater === "function" ? (updater as (current: T | null) => T | null)(current.data) : updater,
      }));
    },
    setError: (error: string | null) => setState((current) => ({ ...current, error })),
  };
}
