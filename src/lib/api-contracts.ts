import type {
  Activity,
  AssetRecord,
  AssetType,
  BackgroundJob,
  CashMovement,
  CustomFundRecord,
  CustomFundUniverseItem,
  DailyPrice,
  DcaInput,
  DcaPlan,
  DcaSimulation,
  Fund,
  Holding,
  Insight,
  InsightCardModel,
  MarketConfig,
  MarketId,
  MarketOption,
  Portfolio,
  PortfolioSnapshot,
  PortfolioSummary,
  RebalanceSuggestion,
  ReportRecord,
  SearchSortKey,
  Stock,
  TimePoint,
  TimeRange,
  Transaction,
  UserPreference,
  WatchlistItem,
} from "./types";

export type ApiErrorPayload = {
  ok: false;
  error: string;
  message: string;
  status: number;
  fields?: Record<string, string[] | undefined>;
  details?: Record<string, unknown>;
};

export type ApiOk<T> = T & {
  ok?: true;
  marketId?: MarketId;
  cached?: boolean;
  source?: string;
  updatedAt?: string;
};

export type AssetSearchType = "all" | "stock" | "fund";

export type AssetSearchResponse = {
  marketId: MarketId;
  query: string;
  type: AssetSearchType;
  sort: SearchSortKey;
  cached: boolean;
  count: number;
  items: AssetRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  stats?: {
    total: number;
    funds: number;
    stocks: number;
  };
  filteredStats?: {
    total: number;
    funds: number;
    stocks: number;
  };
  facets?: {
    sectors: string[];
    industries: string[];
    fundTypes: string[];
  };
  facetCounts?: {
    sectors: Record<string, number>;
    industries: Record<string, number>;
    fundTypes: Record<string, number>;
  };
  discovery?: {
    synced?: number;
    quoted?: number;
    source?: string;
    updatedAt?: string;
    cached?: boolean;
    failed?: Array<{ source?: string; reason: string }>;
  };
};

export type AssetDetailResponse = {
  marketId: MarketId;
  asset: AssetRecord;
  fund?: Fund;
  stock?: Stock;
  detail?: unknown;
  history: TimePoint[];
  dailyPrices?: DailyPrice[];
  source: string;
  updatedAt: string;
  refreshed?: boolean;
  cache?: {
    cached: boolean;
    key: string;
    status: "fresh" | "expired" | "miss";
    createdAt?: string;
    expiresAt?: string;
  };
  refreshResult?: {
    fetched: number;
    cached?: Array<{ assetId?: string; reason: string }>;
    failed: Array<{ assetId?: string; reason: string }>;
    source: string;
    range?: string;
    startDate?: string | null;
    endDate?: string | null;
  };
};

export type MarketTopResponse = {
  marketId: MarketId;
  source?: string;
  kind: "stock" | "fund";
  count: number;
  items: AssetRecord[];
  refreshed?: boolean;
  cached?: boolean;
  updatedAt?: string;
  refreshSkipped?: "recent";
  universe?: "full-market";
  ranking?: "turnover";
  refreshResult?: {
    fetched: number;
    cached?: Array<{ assetId?: string; source?: string; reason: string }>;
    failed: Array<{ assetId?: string; source?: string; reason: string }>;
    source: string;
    range?: string;
    startDate?: string | null;
    endDate?: string | null;
    universe?: "full-market";
    ranking?: "turnover";
  };
};

export type FundsResponse = {
  marketId: MarketId;
  source: string;
  updatedAt?: string;
  funds: Array<
    Fund & {
      calculated?: {
        volatility: number;
        drawdown: unknown;
      };
    }
  >;
};

export type StocksResponse = {
  marketId: MarketId;
  source: string;
  updatedAt?: string;
  stocks: Array<
    Stock & {
      calculated?: {
        volatility: number;
        drawdown: unknown;
      };
    }
  >;
  customFundUniverse?: CustomFundUniverseItem[];
};

export type WatchlistViewItem = {
  id: string;
  assetId: string;
  assetType: AssetType;
  name: string;
  symbol: string;
  price: number;
  target: number;
  dailyChange: number;
  reason: string;
  performance: TimePoint[];
  group?: string;
  signal: string;
};

export type WatchlistResponse = {
  marketId: MarketId;
  watchlist: WatchlistItem[];
  view: WatchlistViewItem[];
  refreshResult?: {
    fetched: number;
    cached?: Array<{ assetId?: string; reason: string }>;
    failed: Array<{ assetId?: string; reason: string }>;
    source: string;
    skipped?: string;
    range?: string;
    startDate?: string | null;
    endDate?: string | null;
  };
};

export type PortfolioVersionRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  marketId: MarketId;
  version: number;
  name: string;
  savedAt: string;
  data: Portfolio;
};

export type PortfolioResponse = {
  marketId: MarketId;
  range?: TimeRange;
  portfolio: Portfolio | null;
  portfolios: Portfolio[];
  summary: PortfolioSummary | null;
  cached: boolean;
  activities?: Activity[];
  versions?: PortfolioVersionRecord[];
  rebalanceSuggestions?: RebalanceSuggestion[];
  snapshots?: PortfolioSnapshot[];
  source?: string;
  updatedAt?: string;
};

export type PortfolioDetailResponse = {
  marketId: MarketId;
  portfolio: Portfolio;
  summary: PortfolioSummary;
  cached: boolean;
  versions?: PortfolioVersionRecord[];
  rebalanceSuggestions?: RebalanceSuggestion[];
  transactions?: Transaction[];
  cashMovements?: CashMovement[];
};

export type HoldingsResponse = {
  marketId: MarketId;
  portfolioId: string;
  holdings: Holding[];
};

export type TransactionsResponse = {
  marketId: MarketId;
  portfolioId: string;
  transactions: Transaction[];
};

export type CashMovementsResponse = {
  marketId: MarketId;
  portfolioId: string;
  cashMovements: CashMovement[];
};

export type DcaResponse = {
  marketId: MarketId;
  defaults: DcaInput;
  plans: DcaPlan[];
  simulation?: DcaSimulation;
  source?: string;
  updatedAt?: string;
};

export type CustomFundsResponse = {
  marketId: MarketId;
  universe: CustomFundUniverseItem[];
  universeCount?: number;
  customFunds: CustomFundRecord[];
  draft: {
    name: string;
    style: string;
    holdings: Array<{ stockId: string; weight: number; locked?: boolean }>;
    score: CustomFundRecord["score"];
  };
};

export type CustomAssetsResponse = {
  marketId: MarketId;
  items: AssetRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  cached?: boolean;
};

export type ReportsResponse = {
  marketId: MarketId;
  generatedAt?: string;
  reports: ReportRecord[];
  portfolioSummary?: PortfolioSummary;
  source?: string;
};

export type JobsResponse = {
  ok?: true;
  marketId?: MarketId;
  jobs?: BackgroundJob[];
  job?: BackgroundJob;
};

export type AnalyticsResponse = {
  marketId: MarketId;
  cached?: boolean;
  portfolio: PortfolioSummary;
  benchmarkComparison?: unknown;
  exposures?: unknown;
  fundRiskTable?: unknown[];
  stockScores?: unknown[];
};

export type InsightsResponse = {
  marketId: MarketId;
  insights: Insight[];
  cards: InsightCardModel[];
};

export type MarketResponse = {
  market: MarketConfig;
  options: MarketOption[];
  overview?: unknown;
};

export type CalculationWorkflow =
  | "portfolio"
  | "dca"
  | "custom-fund"
  | "compare"
  | "watchlist"
  | "insights"
  | "asset-detail"
  | "fund-detail"
  | "report";

export type CalculationAssetInput = {
  assetId: string;
  assetType: AssetType;
};

export type CalculationRequest = {
  marketId: MarketId;
  workflow: CalculationWorkflow;
  assets: CalculationAssetInput[];
  params?: Record<string, unknown>;
  refresh: boolean;
};

export type CalculationWarning = {
  assetId?: string;
  message: string;
};

export type CalculationResponse<T = unknown> = {
  ok: true;
  marketId: MarketId;
  workflow: CalculationWorkflow;
  runId: string;
  computedAt: string;
  dataAsOf?: string;
  refreshResult: {
    fetched: number;
    cached?: Array<{ assetId?: string; reason: string }>;
    failed: Array<{ assetId?: string; reason: string }>;
    source: string;
    skipped?: string;
    range?: string;
    startDate?: string | null;
    endDate?: string | null;
  };
  warnings: CalculationWarning[];
  result: T;
};

export type SettingsExportPayload = {
  marketId: MarketId;
  generatedAt: string;
  portfolios: Portfolio[];
  activePortfolio?: Portfolio;
  portfolioSummary?: PortfolioSummary;
  portfolioVersions?: PortfolioVersionRecord[];
  transactions?: Transaction[];
  cashMovements?: CashMovement[];
  portfolioSnapshots?: PortfolioSnapshot[];
  rebalanceSuggestions?: RebalanceSuggestion[];
  customFunds: CustomFundRecord[];
  dcaPlans: DcaPlan[];
  watchlist: WatchlistItem[];
  reports: ReportRecord[];
  insightRecommendations?: unknown[];
  preferences?: UserPreference[];
};

export type SettingsImportMode = "merge" | "replace";

export type SettingsImportResponse = {
  ok: true;
  marketId: MarketId;
  mode: SettingsImportMode;
  imported: {
    portfolios: number;
    customFunds: number;
    dcaPlans: number;
    watchlist: number;
    reports: number;
    portfolioVersions?: number;
    transactions?: number;
    cashMovements?: number;
    portfolioSnapshots?: number;
    rebalanceSuggestions?: number;
    insightRecommendations?: number;
    preferences: number;
  };
  idChanges: number;
  message: string;
};

export type ProviderAccountProvider = "longbridge";

export type ProviderAccountFieldSource = "local" | "environment" | "missing";

export type ProviderAccountField = {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
  configured: boolean;
  masked: string;
  value: string;
  source: ProviderAccountFieldSource;
  options?: string[];
};

export type ProviderAccountSummary = {
  provider: ProviderAccountProvider;
  marketId: MarketId;
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  source: ProviderAccountFieldSource;
  secretFields: ProviderAccountField[];
  configFields: ProviderAccountField[];
};

export type ProviderAccountsResponse = {
  marketId: MarketId;
  updatedAt: string;
  source: string;
  accounts: ProviderAccountSummary[];
};

export type ProviderAccountUpdatePayload = {
  provider: ProviderAccountProvider;
  enabled?: boolean;
  secrets?: Record<string, string>;
  config?: Record<string, string>;
  clear?: boolean;
};
