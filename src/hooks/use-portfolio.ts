"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import type {
  AssetDetailResponse,
  CashMovementsResponse,
  PortfolioResponse,
  TransactionsResponse,
} from "@/lib/api-contracts";
import type { AssetType, CashMovement, MarketId, PortfolioDcaPlan, TimePoint, Transaction } from "@/lib/types";
import {
  buildLocalPortfolioResponse,
  createLocalPortfolio,
  deleteLocalHolding,
  deleteLocalPortfolio,
  generateLocalRebalanceSuggestion,
  listLocalCashMovements,
  listLocalTransactions,
  recordLocalCashMovement,
  recordLocalTransaction,
  restoreLocalPortfolioVersion,
  setLocalActivePortfolio,
  updateLocalPortfolio,
  upsertLocalHolding,
} from "@/lib/local-user-data";
import { useApiResource } from "./use-api-resource";

export function usePortfolio(marketId: MarketId) {
  const [activePortfolioId, setActivePortfolioId] = useState<string | null>(null);
  const load = useCallback(
    (_signal: AbortSignal) => Promise.resolve(buildLocalPortfolioResponse(marketId, activePortfolioId)),
    [activePortfolioId, marketId],
  );
  const resource = useApiResource(load, [load], { keepPreviousData: false });
  const portfolioId = activePortfolioId ?? resource.data?.portfolio?.id ?? null;
  const tx = usePortfolioTransactions(marketId, portfolioId);
  const cash = usePortfolioCashMovements(marketId, portfolioId);

  useEffect(() => {
    setActivePortfolioId(null);
  }, [marketId]);

  async function createPortfolio(input: { name: string; goal?: string; riskPreference?: string; cashBalance?: number; capital?: number; startDate?: string; endDate?: string; dcaPlans?: Record<string, PortfolioDcaPlan>; valueHistory?: TimePoint[]; contributionHistory?: TimePoint[] }) {
    const portfolio = createLocalPortfolio(marketId, input);
    setActivePortfolioId(portfolio.id);
    await resource.refresh("reload");
    return portfolio;
  }

  async function updatePortfolio(id: string, input: { name?: string; goal?: string; riskPreference?: string; cashBalance?: number; capital?: number; startDate?: string; endDate?: string; dcaPlans?: Record<string, PortfolioDcaPlan>; valueHistory?: TimePoint[]; contributionHistory?: TimePoint[] }) {
    updateLocalPortfolio(marketId, id, input);
    await resource.refresh("reload");
  }

  async function deletePortfolio(id: string) {
    deleteLocalPortfolio(marketId, id);
    setActivePortfolioId(null);
    await resource.refresh("reload");
  }

  async function setActivePortfolio(id: string) {
    setActivePortfolioId(id);
    setLocalActivePortfolio(marketId, id);
    await resource.refresh("reload");
  }

  async function restorePortfolioVersion(id: string, version: number) {
    restoreLocalPortfolioVersion(marketId, id, version);
    await resource.refresh("reload");
  }

  async function saveHolding(input: { portfolioId?: string; assetId: string; assetType: AssetType; quantity: number; averageCost: number; targetWeight: number; currentPrice?: number | null; name?: string; symbol?: string; sector?: string }) {
    const targetPortfolioId = input.portfolioId ?? portfolioId;
    if (!targetPortfolioId) return;
    const asset = input.name && input.symbol
      ? null
      : await apiGet<AssetDetailResponse>(`/api/assets/${input.assetId}`, { market: marketId, type: input.assetType }).catch(() => null);
    upsertLocalHolding(marketId, { ...input, portfolioId: targetPortfolioId }, asset?.asset);
    await resource.refresh("reload");
  }

  async function removeHolding(holdingId: string, targetPortfolioId = portfolioId) {
    if (!targetPortfolioId) return;
    resource.setData((current) => current
      ? {
          ...current,
          portfolio: current.portfolio ? { ...current.portfolio, holdings: current.portfolio.holdings.filter((item) => item.id !== holdingId) } : current.portfolio,
          summary: current.summary
            ? {
                ...current.summary,
                holdings: current.summary.holdings.filter((item) => item.id !== holdingId),
              }
            : current.summary,
        }
      : current);
    deleteLocalHolding(marketId, targetPortfolioId, holdingId);
    await resource.refresh("reload");
  }

  async function generateRebalance() {
    if (!portfolioId) return;
    generateLocalRebalanceSuggestion(marketId, portfolioId);
    await resource.refresh("reload");
  }

  async function recordTransaction(input: Omit<Transaction, "id" | "userId" | "portfolioId" | "marketId" | "createdAt">) {
    if (!portfolioId) return;
    recordLocalTransaction(marketId, portfolioId, input);
    await Promise.all([resource.refresh("reload"), tx.refresh("reload")]);
  }

  async function recordCashMovement(input: Omit<CashMovement, "id" | "userId" | "portfolioId" | "marketId" | "createdAt">) {
    if (!portfolioId) return;
    recordLocalCashMovement(marketId, portfolioId, input);
    await Promise.all([resource.refresh("reload"), cash.refresh("reload")]);
  }

  return {
    ...resource,
    activePortfolioId: portfolioId,
    setActivePortfolioId: setActivePortfolio,
    transactions: tx.data?.transactions ?? [],
    cashMovements: cash.data?.cashMovements ?? [],
    transactionsLoading: tx.loading,
    cashMovementsLoading: cash.loading,
    createPortfolio,
    updatePortfolio,
    deletePortfolio,
    restorePortfolioVersion,
    saveHolding,
    deleteHolding: removeHolding,
    generateRebalance,
    recordTransaction,
    recordCashMovement,
  };
}

function usePortfolioTransactions(marketId: MarketId, portfolioId: string | null) {
  const load = useCallback(
    (_signal: AbortSignal) => portfolioId
      ? Promise.resolve(listLocalTransactions(marketId, portfolioId) satisfies TransactionsResponse)
      : Promise.resolve({ marketId, portfolioId: "", transactions: [] }),
    [marketId, portfolioId],
  );
  return useApiResource(load, [load], { enabled: Boolean(portfolioId), keepPreviousData: false });
}

function usePortfolioCashMovements(marketId: MarketId, portfolioId: string | null) {
  const load = useCallback(
    (_signal: AbortSignal) => portfolioId
      ? Promise.resolve(listLocalCashMovements(marketId, portfolioId) satisfies CashMovementsResponse)
      : Promise.resolve({ marketId, portfolioId: "", cashMovements: [] }),
    [marketId, portfolioId],
  );
  return useApiResource(load, [load], { enabled: Boolean(portfolioId), keepPreviousData: false });
}
