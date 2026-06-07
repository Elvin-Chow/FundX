export type MarketId = "us";

export type AssetType = "fund" | "stock" | "etf" | "customFund" | "customAsset";

export type AssetKind = "stock" | "fund";

export type FundSubtype = "etf" | "open_end" | "lof" | "money_market" | "mutual_fund";

export type QuoteStatus = "fresh" | "stale" | "missing" | "failed";

export type TimeRange = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "3Y" | "5Y" | "10Y" | "ALL";

export type Frequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";

export type DcaStrategy =
  | "standard"
  | "drawdown-addon"
  | "dividend-reinvest"
  | "target-return"
  | "custom";

export type TimePoint = {
  date: string;
  label?: string;
  value: number;
};

export type Tone = "positive" | "negative" | "neutral";

export type Metric = {
  label: string;
  value: string;
  delta?: string;
  tone?: Tone;
};

export type Exposure = {
  name: string;
  weight: number;
};

export type MarketConfig = {
  id: MarketId;
  name: string;
  region: string;
  currency: "USD";
  currencySymbol: "$";
  accent: string;
  benchmarks: string[];
  sectors: string[];
  style: string;
};

export type FundHolding = {
  name: string;
  symbol: string;
  weight: number;
  sector: string;
};

export type Fund = {
  id: string;
  marketId: MarketId;
  name: string;
  symbol: string;
  type: string;
  category: string;
  style: string;
  nav: number;
  dailyChange: number;
  oneYearReturn: number;
  threeYearAnnualizedReturn: number;
  fiveYearAnnualizedReturn: number;
  totalReturn: number;
  maxDrawdown: number;
  volatility: number;
  sharpeRatio: number;
  expenseRatio: number;
  fundCompany?: string;
  managementFee?: number;
  custodianFee?: number;
  salesFee?: number;
  inceptionDate?: string;
  scale?: number;
  styleTags?: string[];
  dividendYield: number;
  aum: number;
  riskLevel: "Low" | "Moderate" | "Balanced" | "Elevated";
  holdings: FundHolding[];
  sectorExposure: Exposure[];
  navHistory: TimePoint[];
  dividends?: Array<{ date: string; amount: number }>;
};

export type Stock = {
  id: string;
  marketId: MarketId;
  name: string;
  symbol: string;
  sector: string;
  industry: string;
  price: number;
  dailyChange: number;
  marketCap: number;
  peRatio: number;
  pbRatio: number;
  dividendYield: number;
  roe: number;
  grossMargin: number;
  debtRatio: number;
  freeCashFlowYield: number;
  revenueGrowth: number;
  profitGrowth: number;
  volatility: number;
  valueScore: number;
  qualityScore: number;
  riskScore: number;
  priceHistory: TimePoint[];
  dividends?: Array<{ date: string; amount: number }>;
};

export type UserAccount = {
  id: string;
  email: string;
  name: string;
  defaultMarket: MarketId;
  preferences: {
    defaultMarket: MarketId;
    watchlistGroups: string[];
    riskFreeRate: number;
    benchmarkByMarket: Record<MarketId, string>;
    activePortfolioByMarket?: Partial<Record<MarketId, string>>;
  };
  createdAt: string;
  updatedAt: string;
};

export type AssetRecord = {
  id: string;
  marketId: MarketId;
  assetType: AssetType;
  kind?: AssetKind;
  fundSubtype?: FundSubtype;
  name: string;
  symbol: string;
  exchange?: string;
  aliases: string[];
  industry?: string;
  sector?: string;
  category?: string;
  fundType?: string;
  fundCompany?: string;
  expenseRatio?: number;
  aum?: number;
  inceptionDate?: string;
  latestPrice: number | null;
  latestVolume?: number | null;
  latestTurnover?: number | null;
  dailyChange: number | null;
  popularity: number;
  source: string;
  sourceName?: string;
  sourceUrl?: string;
  sourceAsOf?: string;
  isTradable?: boolean;
  quoteSource?: string;
  quoteFetchedAt?: string;
  quoteStatus?: QuoteStatus;
  quoteError?: string;
  dividends?: Array<{ date: string; amount: number }>;
  updatedAt: string;
};

export type SecurityMasterRecord = {
  id: string;
  marketId: MarketId;
  kind: AssetKind;
  fundSubtype?: FundSubtype;
  symbol: string;
  exchange: string;
  name: string;
  sector?: string;
  industry?: string;
  category?: string;
  fundCompany?: string;
  sourceName: string;
  sourceUrl: string;
  sourceAsOf: string;
  isTradable: boolean;
  aliases?: string[];
};

export type DailyPrice = {
  id: string;
  marketId: MarketId;
  assetId: string;
  assetType: AssetType;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  nav?: number;
  volume?: number;
  source: string;
};

export type CustomFundUniverseItem = Stock & {
  assetType?: AssetType;
  kind?: AssetKind;
  category?: string;
  fundType?: string;
  fundSubtype?: FundSubtype;
  valueLabel: string;
  qualityLabel: string;
  priceLabel: string;
};

export type Portfolio = {
  id: string;
  userId?: string;
  marketId: MarketId;
  name: string;
  currency: "USD";
  goal: string;
  riskPreference: string;
  cashBalance: number;
  capital?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  dcaPlans?: Record<string, PortfolioDcaPlan>;
  valueHistory?: TimePoint[];
  contributionHistory?: TimePoint[];
  createdAt: string;
  updatedAt: string;
  holdings: Holding[];
};

export type PortfolioDcaPlan = {
  enabled: boolean;
  initialAmount: number;
  recurringAmount: number;
  frequency: Frequency;
  transactionCost: number;
  reinvestDividends: boolean;
  strategy?: DcaStrategy;
};

export type Holding = {
  id: string;
  portfolioId: string;
  assetId: string;
  assetType: AssetType;
  marketId: MarketId;
  name: string;
  symbol: string;
  quantity: number;
  averageCost: number;
  currentPrice: number;
  targetWeight: number;
  sector: string;
  createdAt: string;
  updatedAt: string;
};

export type Transaction = {
  id: string;
  userId: string;
  portfolioId: string;
  marketId: MarketId;
  assetId: string;
  assetType: AssetType;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fee: number;
  tradeDate: string;
  note?: string;
  createdAt: string;
};

export type CashMovement = {
  id: string;
  userId: string;
  portfolioId: string;
  marketId: MarketId;
  type: "deposit" | "withdrawal" | "dividend" | "fee" | "interest" | "adjustment";
  amount: number;
  date: string;
  assetId?: string;
  note?: string;
  createdAt: string;
};

export type VersionedConfig<T> = {
  version: number;
  name: string;
  savedAt: string;
  data: T;
};

export type Activity = {
  id: string;
  marketId: MarketId;
  title: string;
  subtitle: string;
  amount: number;
  date: string;
  type: "buy" | "sell" | "dividend" | "rebalance" | "deposit";
};

export type Insight = {
  id: string;
  marketId: MarketId;
  portfolioId: string;
  type: "concentration" | "valuation" | "income" | "defensive" | "rebalance";
  title: string;
  issue: string;
  reason: string;
  suggestion: string;
  targetWeight: number;
  candidateAssets: string[];
  estimatedImpact: string;
  beforeMetrics: Record<string, number>;
  afterMetrics: Record<string, number>;
  createdAt: string;
};

export type WatchlistItem = {
  id: string;
  userId?: string;
  marketId: MarketId;
  assetId: string;
  assetType: AssetType;
  name: string;
  symbol: string;
  price: number;
  dailyChange: number;
  note: string;
  target: number;
  group?: string;
  sparkline: TimePoint[];
  createdAt?: string;
  updatedAt?: string;
};

export type DcaInput = {
  fundId: string;
  name?: string;
  initialAmount: number;
  recurringAmount: number;
  frequency: Frequency;
  startDate: string;
  endDate: string;
  reinvestDividends: boolean;
  transactionCost: number;
  strategy: DcaStrategy;
};

export type DcaCashFlow = {
  date: string;
  nav: number;
  contribution: number;
  fee?: number;
  dividend?: number;
  dividendShares?: number;
  sharesPurchased: number;
  accumulatedShares: number;
  portfolioValue: number;
};

export type DcaSimulation = {
  id: string;
  marketId: MarketId;
  fundId: string;
  name: string;
  input: DcaInput;
  totalInvested: number;
  totalFees?: number;
  totalDividends?: number;
  finalValue: number;
  totalReturn: number;
  totalReturnPercent: number;
  annualizedReturn: number;
  maxDrawdown: number;
  averageCost: number;
  sharesAccumulated: number;
  valueHistory: TimePoint[];
  contributionHistory: TimePoint[];
  drawdownHistory: TimePoint[];
  cashFlowHistory: DcaCashFlow[];
  annualReturns: { year: string; return: number }[];
  monthlyReturns: { month: string; return: number }[];
};

export type DcaPlan = {
  id: string;
  userId?: string;
  marketId?: MarketId;
  name: string;
  fund: Fund;
  input: DcaInput;
  currencySymbol: MarketConfig["currencySymbol"];
  strategy?: DcaStrategy;
  simulationSnapshot?: DcaSimulation;
  versions?: Array<VersionedConfig<DcaInput>>;
  createdAt?: string;
  updatedAt?: string;
};

export type PortfolioSummary = {
  range?: TimeRange;
  rangeGain?: number;
  rangeGainPercent?: number;
  rangeStartDate?: string | null;
  rangeEndDate?: string | null;
  rangePointCount?: number;
  totalValue: number;
  totalCost: number;
  totalGain: number;
  totalGainPercent: number;
  annualizedReturn: number;
  cashBalance: number;
  maxDrawdown: number;
  volatility: number;
  sharpeRatio: number;
  riskScore: number;
  sectorExposure: Exposure[];
  assetTypeExposure: Exposure[];
  topHoldingConcentration: number;
  holdings: Array<
    Holding & {
      marketValue: number;
      cost: number;
      gain: number;
      gainPercent: number;
      currentWeight: number;
      targetGap: number;
    }
  >;
  valueHistory: TimePoint[];
};

export type CustomFundHolding = {
  stockId: string;
  weight: number;
  locked?: boolean;
};

export type CustomFundScore = {
  totalWeight: number;
  peRatio: number;
  pbRatio: number;
  dividendYield: number;
  roe: number;
  volatility: number;
  valueScore: number;
  qualityScore: number;
  dividendScore: number;
  riskScore: number;
  concentrationScore: number;
  sectorExposure: Exposure[];
  backtestHistory: TimePoint[];
  maxDrawdown: number;
};

export type InsightCardModel = {
  id: string;
  title: string;
  body: string;
  actionLabel?: string;
  tone?: Tone;
  targetWeight: number;
};

export type MarketOption = {
  id: MarketId;
  code: "US";
  name: string;
  currency: string;
  description: string;
  benchmarks: string[];
  href: string;
};

export type ReportItem = {
  id: string;
  title: string;
  subtitle: string;
  status: "Ready" | "Draft";
  href: string;
};

export type CustomFundRecord = {
  id: string;
  userId: string;
  marketId: MarketId;
  name: string;
  style: string;
  holdings: CustomFundHolding[];
  score: CustomFundScore;
  capital?: number | null;
  cashBalance?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  dcaPlans?: Record<string, PortfolioDcaPlan>;
  portfolio?: Portfolio;
  summary?: PortfolioSummary;
  version: number;
  versions: Array<VersionedConfig<{ name: string; style: string; holdings: CustomFundHolding[]; capital?: number | null; cashBalance?: number | null; startDate?: string | null; endDate?: string | null; dcaPlans?: Record<string, PortfolioDcaPlan> }>>;
  createdAt: string;
  updatedAt: string;
};

export type PortfolioSnapshot = {
  id: string;
  userId: string;
  portfolioId: string;
  marketId: MarketId;
  note: string;
  summary: PortfolioSummary;
  createdAt: string;
};

export type RebalanceSuggestion = {
  id: string;
  userId: string;
  portfolioId: string;
  marketId: MarketId;
  generatedAt: string;
  trades: Array<{
    holdingId: string;
    assetId: string;
    symbol: string;
    action: "buy" | "sell" | "hold";
    currentWeight: number;
    targetWeight: number;
    gap: number;
    amount: number;
    quantity: number;
  }>;
  summary: {
    driftScore: number;
    cashAfter: number;
    turnover: number;
  };
};

export type ReportRecord = {
  id: string;
  userId: string;
  marketId: MarketId;
  type: "portfolio" | "dca" | "custom-fund";
  params: Record<string, unknown>;
  status: "queued" | "running" | "ready" | "failed";
  exportStatus: "not_started" | "ready" | "failed";
  title: string;
  payload: Record<string, unknown>;
  exports: {
    json?: string;
    csv?: string;
    pdf?: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type AuditEvent = {
  id: string;
  userId: string;
  marketId?: MarketId;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type BackgroundJob = {
  id: string;
  type: "sync-security-master" | "sync-universe" | "sync-prices" | "sync-nav" | "sync-holdings" | "sync-market-latest" | "recalculate-metrics" | "cleanup-cache";
  marketId?: MarketId;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  maxAttempts: number;
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  result?: Record<string, unknown>;
};

export type SearchSortKey = "relevance" | "size" | "return" | "risk" | "popularity";

export type UserPreference = {
  label: string;
  value: string;
  description: string;
};
