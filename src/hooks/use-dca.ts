"use client";

import { useCallback } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import type { AssetDetailResponse, CalculationResponse, DcaResponse } from "@/lib/api-contracts";
import type { DcaInput, DcaSimulation, Fund, MarketId } from "@/lib/types";
import {
  createLocalDcaPlan,
  deleteLocalDcaPlan,
  localDcaPlans,
  restoreLocalDcaPlanVersion,
  updateLocalDcaPlan,
} from "@/lib/local-user-data";
import { useApiResource } from "./use-api-resource";

type DcaCalculationResult = {
  asset: Fund;
  input: DcaInput & { name?: string };
  simulation: DcaSimulation;
};

export function useDca(marketId: MarketId, fundId?: string) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const payload = await apiGet<DcaResponse>("/api/dca", { market: marketId, fundId }, signal);
      return { ...payload, plans: localDcaPlans(marketId, fundId) };
    },
    [fundId, marketId],
  );
  const resource = useApiResource(load, [load], { keepPreviousData: false });

  async function savePlan(input: DcaInput & { name: string }) {
    const payload = await buildDcaPlanSavePayload(marketId, input);
    createLocalDcaPlan(marketId, payload);
    await resource.refresh("reload");
  }

  async function updatePlan(planId: string, input: Partial<DcaInput & { name: string }>) {
    const existing = localDcaPlans(marketId).find((plan) => plan.id === planId);
    const merged = { ...(existing?.input ?? {}), ...input } as DcaInput & { name: string };
    const payload = await buildDcaPlanSavePayload(marketId, merged);
    updateLocalDcaPlan(marketId, planId, payload);
    await resource.refresh("reload");
  }

  async function deletePlan(planId: string) {
    resource.setData((current) => current ? { ...current, plans: current.plans.filter((plan) => plan.id !== planId) } : current);
    deleteLocalDcaPlan(marketId, planId);
    await resource.refresh("reload");
  }

  async function restoreVersion(planId: string, version: number) {
    restoreLocalDcaPlanVersion(marketId, planId, version);
    await resource.refresh("reload");
  }

  return { ...resource, savePlan, updatePlan, deletePlan, restoreVersion };
}

async function buildDcaPlanSavePayload(marketId: MarketId, input: DcaInput & { name: string }) {
  const detail = await apiGet<AssetDetailResponse>(`/api/assets/${input.fundId}`, { market: marketId }).catch(() => null);
  const assetType = detail?.asset?.assetType ?? "fund";
  const response = await apiPost<CalculationResponse<DcaCalculationResult>>("/api/calculations", {
    marketId,
    workflow: "dca",
    assets: [{ assetId: input.fundId, assetType }],
    params: input,
    refresh: true,
  }, { market: marketId });
  if (!response.result?.asset || !response.result?.simulation) throw new Error("DCA simulation was not available.");
  return {
    ...input,
    fund: response.result.asset,
    simulationSnapshot: response.result.simulation,
  };
}
