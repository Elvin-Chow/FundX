"use client";

import { useCallback, useState } from "react";
import { apiErrorMessage, apiPost } from "@/lib/api-client";
import type {
  CalculationAssetInput,
  CalculationRequest,
  CalculationResponse,
  CalculationWorkflow,
} from "@/lib/api-contracts";
import type { MarketId } from "@/lib/types";

type RunInput = {
  workflow: CalculationWorkflow;
  assets: CalculationAssetInput[];
  params?: Record<string, unknown>;
  refresh?: boolean;
  forceRefresh?: boolean;
};

export function useCalculationRun<T = unknown>(marketId: MarketId) {
  const [data, setData] = useState<CalculationResponse<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(
    async ({ workflow, assets, params, refresh = false, forceRefresh = false }: RunInput) => {
      setRunning(true);
      setError(null);
      try {
        const payload: CalculationRequest = {
          marketId,
          workflow,
          assets,
          params,
          ...(refresh ? { refresh } : {}),
          ...(forceRefresh ? { forceRefresh } : {}),
        };
        const response = await apiPost<CalculationResponse<T>>("/api/calculations", payload, { market: marketId });
        setData(response);
        return response;
      } catch (nextError) {
        const message = apiErrorMessage(nextError);
        setError(message);
        return null;
      } finally {
        setRunning(false);
      }
    },
    [marketId],
  );

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setRunning(false);
  }, []);

  return {
    data,
    error,
    running,
    warnings: data?.warnings ?? [],
    result: data?.result ?? null,
    run,
    reset,
  };
}
