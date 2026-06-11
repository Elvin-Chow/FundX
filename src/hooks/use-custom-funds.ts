"use client";

import { useCallback } from "react";
import { apiGet } from "@/lib/api-client";
import type { CustomFundsResponse } from "@/lib/api-contracts";
import type { MarketId } from "@/lib/types";
import {
  buildLocalCustomFundsResponse,
  createLocalCustomFund,
  deleteLocalCustomFund,
  type CustomFundSaveInput,
  restoreLocalCustomFundVersion,
  updateLocalCustomFund,
} from "@/lib/local-user-data";
import { useApiResource } from "./use-api-resource";

export function useCustomFunds(marketId: MarketId) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const payload = await apiGet<CustomFundsResponse>("/api/custom-funds", { market: marketId }, signal);
      return buildLocalCustomFundsResponse(marketId, payload);
    },
    [marketId],
  );
  const resource = useApiResource(load, [load], { cacheKey: `custom-funds:${marketId}`, keepPreviousData: false, staleTimeMs: 60_000 });

  async function saveCustomFund(input: CustomFundSaveInput) {
    createLocalCustomFund(marketId, input, resource.data?.universe ?? []);
    await resource.refresh("reload");
  }

  async function updateCustomFund(id: string, input: Partial<CustomFundSaveInput>) {
    updateLocalCustomFund(marketId, id, input, resource.data?.universe ?? []);
    await resource.refresh("reload");
  }

  async function deleteCustomFund(id: string) {
    resource.setData((current) => current ? { ...current, customFunds: current.customFunds.filter((fund) => fund.id !== id) } : current);
    deleteLocalCustomFund(marketId, id);
    await resource.refresh("reload");
  }

  async function restoreVersion(id: string, version: number) {
    restoreLocalCustomFundVersion(marketId, id, version, resource.data?.universe ?? []);
    await resource.refresh("reload");
  }

  return { ...resource, saveCustomFund, updateCustomFund, deleteCustomFund, restoreVersion };
}
