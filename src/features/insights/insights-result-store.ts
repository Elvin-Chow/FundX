import type { Language } from "@/lib/i18n";
import type { AssetRecord, AssetType, MarketId, PortfolioSummary } from "@/lib/types";

export type RiskProfile = "conservative" | "balanced" | "growth" | "income";

export type InsightAssetSummary = {
  id: string;
  assetId?: string;
  assetType: AssetType;
  kind?: string;
  name: string;
  symbol: string;
  sector?: string;
  category?: string;
  latestPrice?: number | null;
  dailyChange?: number | null;
  expectedReturn?: number | null;
  volatility?: number | null;
  maxDrawdown?: number | null;
  dividendYield?: number | null;
  qualityScore?: number | null;
  riskScore?: number | null;
  historyPoints?: number | null;
};

export type InsightHoldingRecommendation = {
  asset: InsightAssetSummary;
  weight: number;
  role: string;
  rationale: string;
  selectedAnchor?: boolean;
};

export type InsightStrategy = {
  id: string;
  objective: string;
  name: string;
  thesis: string;
  actionSummary: string;
  confidence: number;
  recommendedHoldings: InsightHoldingRecommendation[];
  metrics: {
    expectedReturn?: number;
    volatility?: number;
    maxDrawdown?: number;
    dividendYield?: number;
    expenseRatio?: number;
    qualityScore?: number;
    riskScore?: number;
    topWeight?: number;
    topSectorWeight?: number;
    sectorCount?: number;
    holdingCount?: number;
    historyCoverage?: number;
    diversificationScore?: number;
    objectiveScore?: number;
    sectorExposure?: Array<{ name: string; weight: number }>;
    assetTypeExposure?: Array<{ name: string; weight: number }>;
  };
  explanations: string[];
  sourceSimulation?: number;
};

export type SimulationSummary = {
  simulationCount: number;
  completedSimulations: number;
  universeCount: number;
  candidatePoolSize: number;
  historyBackedAssets: number;
  selectedAnchorCount: number;
  includedAnchorCount: number;
  riskProfile: RiskProfile;
  holdingsCount: number;
  maxPosition: number;
  allocationPolicy?: {
    automatic?: boolean;
    holdingsCount?: number;
    maxPosition?: number;
    sectorCount?: number;
    historyCoverageRatio?: number;
  };
  percentiles?: Record<string, { p10: number; p50: number; p90: number }>;
};

export type SavedRecommendation = {
  id: string;
  title: string;
  createdAt: string;
  selectedAssets?: InsightAssetSummary[];
  simulationSummary: SimulationSummary;
  strategies: InsightStrategy[];
  insights?: Array<{ id?: string; title?: string; issue?: string; suggestion?: string; targetWeight?: number }>;
  methodology?: string[];
};

export type SavedRecommendationResponse = {
  marketId: MarketId;
  recommendations: SavedRecommendation[];
};

export type InsightsResult = {
  summary: PortfolioSummary | null;
  selectedAssets: InsightAssetSummary[];
  simulationSummary: SimulationSummary;
  strategies: InsightStrategy[];
  methodology: string[];
  savedRecommendation?: SavedRecommendation;
  savedRecommendations?: SavedRecommendation[];
};

export type InsightsResultInput = {
  riskProfile: RiskProfile;
  simulationCount: number;
  holdingsCount?: number;
  maxPosition?: number;
  includeSelectedAssets: boolean;
  saveRecommendation: boolean;
  selectedAssets: AssetRecord[];
};

export type InsightsResultCache = {
  marketId: MarketId;
  language: Language;
  input: InsightsResultInput;
  result: InsightsResult;
  savedAt: string;
};

const cacheKey = (marketId: MarketId) => `fundx:insights:last-result:${marketId}`;

export function writeInsightsResultCache(result: Omit<InsightsResultCache, "savedAt">) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(cacheKey(result.marketId), JSON.stringify({ ...result, savedAt: new Date().toISOString() }));
}

export function readInsightsResultCache(marketId: MarketId): InsightsResultCache | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(cacheKey(marketId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as InsightsResultCache;
    if (parsed.marketId !== marketId || !parsed.result?.simulationSummary || !Array.isArray(parsed.result?.strategies)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savedRecommendationToInsightsResult(record: SavedRecommendation): InsightsResult {
  return {
    summary: null,
    selectedAssets: record.selectedAssets ?? [],
    simulationSummary: record.simulationSummary,
    strategies: record.strategies ?? [],
    methodology: record.methodology ?? [],
    savedRecommendation: record,
    savedRecommendations: undefined,
  };
}
