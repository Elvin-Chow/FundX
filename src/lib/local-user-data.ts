import type {
  JobsResponse,
  PortfolioVersionRecord,
  ReportsResponse,
  SettingsExportPayload,
  SettingsImportMode,
  SettingsImportResponse,
  WatchlistViewItem,
} from "./api-contracts";
import { scoreCustomFund, summarizePortfolio } from "./calculations";
import type {
  AssetRecord,
  AssetType,
  Activity,
  BackgroundJob,
  CashMovement,
  CustomFundHolding,
  CustomFundRecord,
  CustomFundScore,
  CustomFundUniverseItem,
  DcaInput,
  DcaPlan,
  DcaSimulation,
  Fund,
  Holding,
  MarketId,
  Portfolio,
  PortfolioDcaPlan,
  PortfolioSnapshot,
  PortfolioSummary,
  RebalanceSuggestion,
  ReportRecord,
  TimeRange,
  TimePoint,
  Transaction,
  WatchlistItem,
} from "./types";

export const BROWSER_USER_ID = "browser-local-user";

const STORAGE_KEY = "fundx:local-user-data:v2";
const DATA_VERSION = 2;

export type LocalInsightRecommendation = {
  id: string;
  title: string;
  createdAt: string;
  selectedAssets?: unknown[];
  simulationSummary: Record<string, unknown>;
  strategies: unknown[];
  insights?: unknown[];
  methodology?: string[];
};

type LocalUserData = {
  version: number;
  activePortfolioByMarket: Partial<Record<MarketId, string>>;
  portfolios: Portfolio[];
  portfolioVersions: PortfolioVersionRecord[];
  transactions: Transaction[];
  cashMovements: CashMovement[];
  watchlist: WatchlistItem[];
  dcaPlans: DcaPlan[];
  customFunds: CustomFundRecord[];
  portfolioSnapshots: PortfolioSnapshot[];
  rebalanceSuggestions: RebalanceSuggestion[];
  reports: ReportRecord[];
  jobs: BackgroundJob[];
  insightRecommendations: LocalInsightRecommendation[];
  updatedAt: string;
};

export type PortfolioSaveInput = {
  name: string;
  goal?: string;
  riskPreference?: string;
  cashBalance?: number;
  capital?: number;
  startDate?: string;
  endDate?: string;
  dcaPlans?: Record<string, PortfolioDcaPlan>;
  valueHistory?: TimePoint[];
  contributionHistory?: TimePoint[];
};

export type PortfolioUpdateInput = Partial<PortfolioSaveInput>;

export type HoldingSaveInput = {
  portfolioId?: string;
  assetId: string;
  assetType: AssetType;
  quantity: number;
  averageCost: number;
  targetWeight: number;
  currentPrice?: number | null;
  name?: string;
  symbol?: string;
  sector?: string;
};

export type WatchlistSaveInput = {
  assetId: string;
  assetType: AssetType;
  note?: string;
  target?: number;
  group?: string;
};

export type CustomFundSaveInput = {
  name: string;
  style: string;
  holdings: CustomFundHolding[];
  score?: CustomFundScore;
  capital?: number | null;
  cashBalance?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  dcaPlans?: Record<string, PortfolioDcaPlan>;
  portfolio?: Portfolio;
  summary?: PortfolioSummary;
};

export type DcaPlanSaveInput = DcaInput & {
  name: string;
  fund: Fund;
  simulationSnapshot?: DcaSimulation;
};

export function buildLocalPortfolioResponse(marketId: MarketId, portfolioId?: string | null, range: TimeRange = "ALL") {
  const data = readLocalUserData();
  const portfolios = localPortfolios(data, marketId);
  const preferredId = portfolioId || data.activePortfolioByMarket[marketId] || null;
  const portfolio = portfolios.find((item) => item.id === preferredId) ?? portfolios[0] ?? null;
  const summary = portfolio ? summarizePortfolio(portfolio) : null;

  return {
    marketId,
    range,
    portfolio,
    portfolios,
    summary,
    cached: true,
    activities: buildActivities(data, marketId, portfolio?.id ?? null),
    versions: portfolio ? localPortfolioVersions(data, marketId, portfolio.id) : [],
    rebalanceSuggestions: portfolio ? localRebalanceSuggestions(data, marketId, portfolio.id) : [],
    snapshots: portfolio ? localPortfolioSnapshots(data, marketId, portfolio.id) : [],
    source: "browser-local",
    updatedAt: data.updatedAt,
  };
}

export function getLocalPortfolioDetail(marketId: MarketId, portfolioId: string) {
  const data = readLocalUserData();
  const portfolio = localPortfolios(data, marketId).find((item) => item.id === portfolioId);
  if (!portfolio) return null;
  return {
    marketId,
    portfolio,
    summary: summarizePortfolio(portfolio),
    cached: true,
    versions: localPortfolioVersions(data, marketId, portfolio.id),
    rebalanceSuggestions: localRebalanceSuggestions(data, marketId, portfolio.id),
    snapshots: localPortfolioSnapshots(data, marketId, portfolio.id),
    transactions: localTransactions(data, marketId, portfolio.id),
    cashMovements: localCashMovements(data, marketId, portfolio.id),
  };
}

export function createLocalPortfolio(marketId: MarketId, input: PortfolioSaveInput) {
  return mutateLocalUserData((data) => {
    const now = nowIso();
    const portfolio: Portfolio = {
      id: createId("portfolio"),
      userId: BROWSER_USER_ID,
      marketId,
      name: input.name,
      currency: "USD",
      goal: input.goal ?? "Long-term value investing portfolio",
      riskPreference: input.riskPreference ?? "Balanced",
      cashBalance: input.cashBalance ?? 0,
      capital: input.capital ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      dcaPlans: input.dcaPlans ?? {},
      valueHistory: input.valueHistory ?? [],
      contributionHistory: input.contributionHistory ?? [],
      createdAt: now,
      updatedAt: now,
      holdings: [],
    };
    data.portfolios.unshift(portfolio);
    data.activePortfolioByMarket[marketId] = portfolio.id;
    pushPortfolioVersion(data, portfolio, "Initial portfolio");
    return portfolio;
  });
}

export function updateLocalPortfolio(marketId: MarketId, portfolioId: string, input: PortfolioUpdateInput) {
  return mutateLocalUserData((data) => {
    const portfolio = requireLocalPortfolio(data, marketId, portfolioId);
    Object.assign(portfolio, withoutUndefined(input), { updatedAt: nowIso() });
    pushPortfolioVersion(data, portfolio, "Portfolio update");
    return portfolio;
  });
}

export function deleteLocalPortfolio(marketId: MarketId, portfolioId: string) {
  mutateLocalUserData((data) => {
    data.portfolios = data.portfolios.filter((item) => !(item.marketId === marketId && item.id === portfolioId));
    data.portfolioVersions = data.portfolioVersions.filter((item) => item.portfolioId !== portfolioId);
    data.transactions = data.transactions.filter((item) => item.portfolioId !== portfolioId);
    data.cashMovements = data.cashMovements.filter((item) => item.portfolioId !== portfolioId);
    data.portfolioSnapshots = data.portfolioSnapshots.filter((item) => item.portfolioId !== portfolioId);
    data.rebalanceSuggestions = data.rebalanceSuggestions.filter((item) => item.portfolioId !== portfolioId);
    if (data.activePortfolioByMarket[marketId] === portfolioId) {
      data.activePortfolioByMarket[marketId] = localPortfolios(data, marketId)[0]?.id ?? "";
    }
    return portfolioId;
  });
}

export function setLocalActivePortfolio(marketId: MarketId, portfolioId: string) {
  return mutateLocalUserData((data) => {
    const portfolio = requireLocalPortfolio(data, marketId, portfolioId);
    data.activePortfolioByMarket[marketId] = portfolio.id;
    return portfolio;
  });
}

export function restoreLocalPortfolioVersion(marketId: MarketId, portfolioId: string, version: number) {
  return mutateLocalUserData((data) => {
    const record = localPortfolioVersions(data, marketId, portfolioId).find((item) => item.version === version);
    if (!record) throw new Error("Portfolio version was not found.");
    const index = data.portfolios.findIndex((item) => item.marketId === marketId && item.id === portfolioId);
    if (index < 0) throw new Error("Portfolio was not found.");
    const restored = { ...clone(record.data), updatedAt: nowIso() };
    data.portfolios[index] = restored;
    pushPortfolioVersion(data, restored, `Restored version ${version}`);
    return restored;
  });
}

export function upsertLocalHolding(marketId: MarketId, input: HoldingSaveInput, asset?: Partial<AssetRecord>) {
  return mutateLocalUserData((data) => {
    const portfolioId = input.portfolioId || data.activePortfolioByMarket[marketId] || "";
    const portfolio = requireLocalPortfolio(data, marketId, portfolioId);
    const now = nowIso();
    const existing = portfolio.holdings.find((item) => item.assetId === input.assetId);
    const latestPrice = input.currentPrice ?? asset?.latestPrice ?? existing?.currentPrice ?? 0;
    const holding: Holding = {
      id: existing?.id ?? createId("holding"),
      portfolioId: portfolio.id,
      assetId: input.assetId,
      assetType: input.assetType,
      marketId,
      name: input.name ?? asset?.name ?? existing?.name ?? input.assetId,
      symbol: input.symbol ?? asset?.symbol ?? existing?.symbol ?? input.assetId,
      quantity: input.quantity,
      averageCost: input.averageCost,
      currentPrice: Number(latestPrice) || 0,
      targetWeight: input.targetWeight,
      sector: input.sector ?? asset?.sector ?? asset?.industry ?? asset?.category ?? existing?.sector ?? "Other",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) Object.assign(existing, holding);
    else portfolio.holdings.push(holding);
    portfolio.updatedAt = now;
    return holding;
  });
}

export function deleteLocalHolding(marketId: MarketId, portfolioId: string, holdingId: string) {
  mutateLocalUserData((data) => {
    const portfolio = requireLocalPortfolio(data, marketId, portfolioId);
    portfolio.holdings = portfolio.holdings.filter((item) => item.id !== holdingId && item.assetId !== holdingId);
    portfolio.updatedAt = nowIso();
    return holdingId;
  });
}

export function listLocalTransactions(marketId: MarketId, portfolioId: string) {
  return { marketId, portfolioId, transactions: localTransactions(readLocalUserData(), marketId, portfolioId) };
}

export function recordLocalTransaction(
  marketId: MarketId,
  portfolioId: string,
  input: Omit<Transaction, "id" | "userId" | "portfolioId" | "marketId" | "createdAt">,
) {
  return mutateLocalUserData((data) => {
    requireLocalPortfolio(data, marketId, portfolioId);
    const transaction: Transaction = {
      id: createId("tx"),
      userId: BROWSER_USER_ID,
      portfolioId,
      marketId,
      ...input,
      createdAt: nowIso(),
    };
    data.transactions.unshift(transaction);
    return transaction;
  });
}

export function listLocalCashMovements(marketId: MarketId, portfolioId: string) {
  return { marketId, portfolioId, cashMovements: localCashMovements(readLocalUserData(), marketId, portfolioId) };
}

export function recordLocalCashMovement(
  marketId: MarketId,
  portfolioId: string,
  input: Omit<CashMovement, "id" | "userId" | "portfolioId" | "marketId" | "createdAt">,
) {
  return mutateLocalUserData((data) => {
    requireLocalPortfolio(data, marketId, portfolioId);
    const movement: CashMovement = {
      id: createId("cash"),
      userId: BROWSER_USER_ID,
      portfolioId,
      marketId,
      ...input,
      createdAt: nowIso(),
    };
    data.cashMovements.unshift(movement);
    return movement;
  });
}

export function saveLocalPortfolioSnapshot(marketId: MarketId, portfolioId: string, note: string) {
  return mutateLocalUserData((data) => {
    const portfolio = requireLocalPortfolio(data, marketId, portfolioId);
    const snapshot: PortfolioSnapshot = {
      id: createId("snapshot"),
      userId: BROWSER_USER_ID,
      portfolioId,
      marketId,
      note,
      summary: summarizePortfolio(portfolio),
      createdAt: nowIso(),
    };
    data.portfolioSnapshots.unshift(snapshot);
    return snapshot;
  });
}

export function generateLocalRebalanceSuggestion(marketId: MarketId, portfolioId: string) {
  return mutateLocalUserData((data) => {
    const portfolio = requireLocalPortfolio(data, marketId, portfolioId);
    const summary = summarizePortfolio(portfolio);
    const suggestion: RebalanceSuggestion = {
      id: createId("rebalance"),
      userId: BROWSER_USER_ID,
      portfolioId,
      marketId,
      generatedAt: nowIso(),
      trades: summary.holdings.map((holding) => {
        const gap = holding.targetGap;
        const amount = (gap / 100) * summary.totalValue;
        const quantity = holding.currentPrice ? Math.abs(amount) / holding.currentPrice : 0;
        return {
          holdingId: holding.id,
          assetId: holding.assetId,
          symbol: holding.symbol,
          action: Math.abs(gap) < 1 ? "hold" : gap > 0 ? "buy" : "sell",
          currentWeight: holding.currentWeight,
          targetWeight: holding.targetWeight,
          gap,
          amount: round2(Math.abs(amount)),
          quantity: round6(quantity),
        };
      }),
      summary: {
        driftScore: round2(summary.holdings.reduce((total, item) => total + Math.abs(item.targetGap), 0)),
        cashAfter: summary.cashBalance,
        turnover: round2(summary.holdings.reduce((total, item) => total + Math.abs(item.targetGap), 0) / 2),
      },
    };
    data.rebalanceSuggestions.unshift(suggestion);
    data.rebalanceSuggestions = data.rebalanceSuggestions.slice(0, 50);
    return suggestion;
  });
}

export function buildLocalWatchlistResponse(marketId: MarketId) {
  const watchlist = readLocalUserData().watchlist.filter((item) => item.marketId === marketId);
  return {
    marketId,
    watchlist,
    view: watchlist.map(watchlistViewItem),
  };
}

export function upsertLocalWatchlistItem(marketId: MarketId, input: WatchlistSaveInput, asset: Partial<AssetRecord>, history: TimePoint[] = []) {
  return mutateLocalUserData((data) => {
    const existing = data.watchlist.find((item) => item.marketId === marketId && item.assetId === input.assetId);
    const now = nowIso();
    const price = Number(asset.latestPrice ?? existing?.price ?? 0);
    const dailyChange = resolveWatchlistDailyChange(asset.dailyChange, existing?.dailyChange, history);
    const item: WatchlistItem = {
      id: existing?.id ?? createId("watch"),
      userId: BROWSER_USER_ID,
      marketId,
      assetId: input.assetId,
      assetType: input.assetType,
      name: asset.name ?? existing?.name ?? input.assetId,
      symbol: asset.symbol ?? existing?.symbol ?? input.assetId,
      price,
      dailyChange,
      note: input.note ?? existing?.note ?? "",
      target: input.target ?? existing?.target ?? round2(price * 0.95),
      group: input.group ?? existing?.group ?? "Ideas",
      sparkline: history.length ? history.slice(-40) : existing?.sparkline ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) Object.assign(existing, item);
    else data.watchlist.unshift(item);
    return item;
  });
}

function resolveWatchlistDailyChange(assetChange: unknown, existingChange: unknown, history: TimePoint[]) {
  const historyChange = dailyChangeFromHistory(history);
  const parsedAssetChange = numericValue(assetChange);
  if (historyChange !== null && (parsedAssetChange === null || (parsedAssetChange === 0 && historyChange !== 0))) return historyChange;
  if (parsedAssetChange !== null) return round2(parsedAssetChange);
  const parsedExistingChange = numericValue(existingChange);
  return parsedExistingChange === null ? 0 : round2(parsedExistingChange);
}

function dailyChangeFromHistory(history: TimePoint[]) {
  const valid = history.filter((point) => point.date && Number.isFinite(point.value)).sort((a, b) => a.date.localeCompare(b.date));
  const latest = valid.at(-1);
  const previous = valid.at(-2);
  if (!latest || !previous || previous.value === 0) return null;
  return round2(((latest.value - previous.value) / previous.value) * 100);
}

function numericValue(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function deleteLocalWatchlistItem(marketId: MarketId, id: string) {
  mutateLocalUserData((data) => {
    data.watchlist = data.watchlist.filter((item) => !(item.marketId === marketId && (item.id === id || item.assetId === id)));
    return id;
  });
}

export function buildLocalCustomFundsResponse(
  marketId: MarketId,
  publicPayload: { universe?: CustomFundUniverseItem[]; universeCount?: number; draft?: unknown; source?: string; updatedAt?: string },
) {
  return {
    marketId,
    source: publicPayload.source,
    updatedAt: publicPayload.updatedAt,
    universe: publicPayload.universe ?? [],
    universeCount: publicPayload.universeCount,
    customFunds: readLocalUserData().customFunds.filter((item) => item.marketId === marketId),
    draft: publicPayload.draft as {
      name: string;
      style: string;
      holdings: Array<{ stockId: string; weight: number; locked?: boolean }>;
      score: CustomFundScore;
    },
  };
}

export function createLocalCustomFund(marketId: MarketId, input: CustomFundSaveInput, universe: CustomFundUniverseItem[] = []) {
  return mutateLocalUserData((data) => {
    const now = nowIso();
    const fund: CustomFundRecord = {
      id: createId("custom-fund"),
      userId: BROWSER_USER_ID,
      marketId,
      name: input.name,
      style: input.style,
      holdings: input.holdings,
      score: input.score ?? scoreCustomFund(marketId, input.holdings, universeForScore(universe)),
      capital: input.capital ?? null,
      cashBalance: input.cashBalance ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      dcaPlans: input.dcaPlans ?? {},
      portfolio: input.portfolio,
      summary: input.summary,
      version: 1,
      versions: [{ version: 1, name: "Initial fund", savedAt: now, data: customFundVersionData(input) }],
      createdAt: now,
      updatedAt: now,
    };
    data.customFunds.unshift(fund);
    return fund;
  });
}

export function updateLocalCustomFund(marketId: MarketId, id: string, input: Partial<CustomFundSaveInput>, universe: CustomFundUniverseItem[] = []) {
  return mutateLocalUserData((data) => {
    const fund = data.customFunds.find((item) => item.marketId === marketId && item.id === id);
    if (!fund) throw new Error("Custom fund was not found.");
    const next = {
      name: input.name ?? fund.name,
      style: input.style ?? fund.style,
      holdings: input.holdings ?? fund.holdings,
      capital: input.capital ?? fund.capital ?? null,
      cashBalance: input.cashBalance ?? fund.cashBalance ?? null,
      startDate: input.startDate ?? fund.startDate ?? null,
      endDate: input.endDate ?? fund.endDate ?? null,
      dcaPlans: input.dcaPlans ?? fund.dcaPlans ?? {},
    };
    fund.name = next.name;
    fund.style = next.style;
    fund.holdings = next.holdings;
    fund.score = input.score ?? scoreCustomFund(marketId, fund.holdings, universeForScore(universe));
    fund.capital = next.capital;
    fund.cashBalance = next.cashBalance;
    fund.startDate = next.startDate;
    fund.endDate = next.endDate;
    fund.dcaPlans = next.dcaPlans;
    if (input.portfolio) fund.portfolio = input.portfolio;
    else if (input.holdings && !input.summary) delete fund.portfolio;
    if (input.summary) fund.summary = input.summary;
    else if (input.holdings) delete fund.summary;
    fund.version += 1;
    fund.updatedAt = nowIso();
    fund.versions = [
      ...(fund.versions ?? []),
      { version: fund.version, name: `Version ${fund.version}`, savedAt: fund.updatedAt, data: next },
    ];
    return fund;
  });
}

function customFundVersionData(input: CustomFundSaveInput) {
  return {
    name: input.name,
    style: input.style,
    holdings: input.holdings,
    capital: input.capital ?? null,
    cashBalance: input.cashBalance ?? null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    dcaPlans: input.dcaPlans ?? {},
  };
}

export function deleteLocalCustomFund(marketId: MarketId, id: string) {
  mutateLocalUserData((data) => {
    data.customFunds = data.customFunds.filter((item) => !(item.marketId === marketId && item.id === id));
    return id;
  });
}

export function restoreLocalCustomFundVersion(marketId: MarketId, id: string, version: number, universe: CustomFundUniverseItem[] = []) {
  return mutateLocalUserData((data) => {
    const fund = data.customFunds.find((item) => item.marketId === marketId && item.id === id);
    const record = fund?.versions?.find((item) => item.version === version);
    if (!fund || !record) throw new Error("Custom fund version was not found.");
    fund.name = record.data.name;
    fund.style = record.data.style;
    fund.holdings = record.data.holdings;
    fund.capital = record.data.capital ?? null;
    fund.cashBalance = record.data.cashBalance ?? null;
    fund.startDate = record.data.startDate ?? null;
    fund.endDate = record.data.endDate ?? null;
    fund.dcaPlans = record.data.dcaPlans ?? {};
    delete fund.portfolio;
    delete fund.summary;
    fund.score = scoreCustomFund(marketId, fund.holdings, universeForScore(universe));
    fund.version += 1;
    fund.updatedAt = nowIso();
    fund.versions = [
      ...(fund.versions ?? []),
      { version: fund.version, name: `Restored version ${version}`, savedAt: fund.updatedAt, data: { name: fund.name, style: fund.style, holdings: fund.holdings } },
    ];
    return fund;
  });
}

export function localDcaPlans(marketId: MarketId, fundId?: string) {
  return readLocalUserData().dcaPlans.filter((plan) => {
    if (plan.marketId !== marketId) return false;
    return !fundId || plan.input.fundId === fundId || plan.fund.id === fundId;
  });
}

export function createLocalDcaPlan(marketId: MarketId, input: DcaPlanSaveInput) {
  return mutateLocalUserData((data) => {
    const now = nowIso();
    const planInput = { ...input };
    delete (planInput as Partial<DcaPlanSaveInput>).fund;
    delete (planInput as Partial<DcaPlanSaveInput>).simulationSnapshot;
    const savedInput = planInput as DcaInput & { name: string };
    const plan: DcaPlan = {
      id: createId("dca"),
      userId: BROWSER_USER_ID,
      marketId,
      name: input.name,
      fund: input.fund,
      input: savedInput,
      strategy: input.strategy,
      simulationSnapshot: input.simulationSnapshot,
      currencySymbol: "$",
      versions: [{ version: 1, name: "Initial plan", savedAt: now, data: savedInput }],
      createdAt: now,
      updatedAt: now,
    };
    data.dcaPlans.unshift(plan);
    return plan;
  });
}

export function updateLocalDcaPlan(marketId: MarketId, id: string, input: Partial<DcaPlanSaveInput>) {
  return mutateLocalUserData((data) => {
    const plan = data.dcaPlans.find((item) => item.marketId === marketId && item.id === id);
    if (!plan) throw new Error("DCA plan was not found.");
    const now = nowIso();
    plan.name = input.name ?? plan.name;
    plan.fund = input.fund ?? plan.fund;
    plan.input = { ...plan.input, ...withoutUndefined(input), fund: undefined, simulationSnapshot: undefined } as DcaInput & { name: string };
    plan.strategy = input.strategy ?? plan.strategy;
    plan.simulationSnapshot = input.simulationSnapshot ?? plan.simulationSnapshot;
    plan.updatedAt = now;
    const nextVersion = (plan.versions?.at(-1)?.version ?? 0) + 1;
    plan.versions = [
      ...(plan.versions ?? []),
      { version: nextVersion, name: `Version ${nextVersion}`, savedAt: now, data: plan.input },
    ];
    return plan;
  });
}

export function deleteLocalDcaPlan(marketId: MarketId, id: string) {
  mutateLocalUserData((data) => {
    data.dcaPlans = data.dcaPlans.filter((item) => !(item.marketId === marketId && item.id === id));
    return id;
  });
}

export function restoreLocalDcaPlanVersion(marketId: MarketId, id: string, version: number) {
  return mutateLocalUserData((data) => {
    const plan = data.dcaPlans.find((item) => item.marketId === marketId && item.id === id);
    const record = plan?.versions?.find((item) => item.version === version);
    if (!plan || !record) throw new Error("DCA plan version was not found.");
    plan.input = clone(record.data) as DcaInput & { name: string };
    plan.name = plan.input.name ?? plan.name;
    plan.strategy = plan.input.strategy;
    plan.updatedAt = nowIso();
    return plan;
  });
}

export function buildLocalReportsResponse(marketId: MarketId): ReportsResponse {
  const data = readLocalUserData();
  const portfolio = localPortfolios(data, marketId)[0];
  return {
    marketId,
    generatedAt: nowIso(),
    reports: data.reports.filter((item) => item.marketId === marketId),
    portfolioSummary: portfolio ? summarizePortfolio(portfolio) : undefined,
    source: "browser-local",
  };
}

export function createLocalReport(marketId: MarketId, type: ReportRecord["type"], params: Record<string, unknown> = {}) {
  return mutateLocalUserData((data) => {
    const now = nowIso();
    const payload = buildReportPayload(data, marketId, type, params);
    const title = type === "portfolio" ? "Portfolio report" : type === "dca" ? "DCA report" : "Custom fund report";
    const report: ReportRecord = {
      id: createId("report"),
      userId: BROWSER_USER_ID,
      marketId,
      type,
      params,
      status: "ready",
      exportStatus: "ready",
      title,
      payload,
      exports: {
        json: JSON.stringify(payload, null, 2),
        csv: reportPayloadToCsv(payload),
      },
      createdAt: now,
      updatedAt: now,
    };
    data.reports.unshift(report);
    return report;
  });
}

export function localReportBlob(reportId: string, format: "csv" | "json" | "pdf") {
  const report = readLocalUserData().reports.find((item) => item.id === reportId);
  if (!report) throw new Error("Report was not found.");
  if (format === "pdf") {
    return new Blob([JSON.stringify(report.payload, null, 2)], { type: "application/pdf" });
  }
  const body = report.exports[format] ?? (format === "json" ? JSON.stringify(report.payload, null, 2) : reportPayloadToCsv(report.payload));
  return new Blob([body], { type: format === "json" ? "application/json" : "text/csv" });
}

export function exportLocalSettings(marketId: MarketId): SettingsExportPayload {
  const data = readLocalUserData();
  const portfolios = localPortfolios(data, marketId);
  const activeId = data.activePortfolioByMarket[marketId];
  const activePortfolio = portfolios.find((item) => item.id === activeId) ?? portfolios[0];
  return {
    marketId,
    generatedAt: nowIso(),
    portfolios: clone(portfolios),
    activePortfolio: activePortfolio ? clone(activePortfolio) : undefined,
    portfolioSummary: activePortfolio ? summarizePortfolio(activePortfolio) : undefined,
    portfolioVersions: clone(data.portfolioVersions.filter((item) => item.marketId === marketId)),
    transactions: clone(data.transactions.filter((item) => item.marketId === marketId)),
    cashMovements: clone(data.cashMovements.filter((item) => item.marketId === marketId)),
    portfolioSnapshots: clone(data.portfolioSnapshots.filter((item) => item.marketId === marketId)),
    rebalanceSuggestions: clone(data.rebalanceSuggestions.filter((item) => item.marketId === marketId)),
    customFunds: clone(data.customFunds.filter((item) => item.marketId === marketId)),
    dcaPlans: clone(data.dcaPlans.filter((item) => item.marketId === marketId)),
    watchlist: clone(data.watchlist.filter((item) => item.marketId === marketId)),
    reports: clone(data.reports.filter((item) => item.marketId === marketId)),
    insightRecommendations: clone(data.insightRecommendations.filter((item) => (item.simulationSummary as { marketId?: MarketId }).marketId === marketId)),
    preferences: [],
  };
}

export function importLocalSettings(marketId: MarketId, payload: SettingsExportPayload, mode: SettingsImportMode): SettingsImportResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Imported settings must be a JSON object.");
  if (payload.marketId !== marketId) throw new Error("Imported settings market does not match the active market.");
  const normalizedPayload = normalizeSettingsImportPayload(marketId, payload);
  const counts = {
    portfolios: normalizedPayload.portfolios.length,
    customFunds: normalizedPayload.customFunds.length,
    dcaPlans: normalizedPayload.dcaPlans.length,
    watchlist: normalizedPayload.watchlist.length,
    reports: normalizedPayload.reports.length,
    portfolioVersions: normalizedPayload.portfolioVersions?.length ?? 0,
    transactions: normalizedPayload.transactions?.length ?? 0,
    cashMovements: normalizedPayload.cashMovements?.length ?? 0,
    portfolioSnapshots: normalizedPayload.portfolioSnapshots?.length ?? 0,
    rebalanceSuggestions: normalizedPayload.rebalanceSuggestions?.length ?? 0,
    insightRecommendations: normalizedPayload.insightRecommendations?.length ?? 0,
    preferences: normalizedPayload.preferences?.length ?? 0,
  };
  mutateLocalUserData((data) => {
    if (mode === "replace") {
      data.portfolios = data.portfolios.filter((item) => item.marketId !== marketId);
      data.portfolioVersions = data.portfolioVersions.filter((item) => item.marketId !== marketId);
      data.transactions = data.transactions.filter((item) => item.marketId !== marketId);
      data.cashMovements = data.cashMovements.filter((item) => item.marketId !== marketId);
      data.watchlist = data.watchlist.filter((item) => item.marketId !== marketId);
      data.dcaPlans = data.dcaPlans.filter((item) => item.marketId !== marketId);
      data.customFunds = data.customFunds.filter((item) => item.marketId !== marketId);
      data.portfolioSnapshots = data.portfolioSnapshots.filter((item) => item.marketId !== marketId);
      data.rebalanceSuggestions = data.rebalanceSuggestions.filter((item) => item.marketId !== marketId);
      data.reports = data.reports.filter((item) => item.marketId !== marketId);
      data.insightRecommendations = data.insightRecommendations.filter((item) => (item.simulationSummary as { marketId?: MarketId }).marketId !== marketId);
    }
    data.portfolios.unshift(...clone(normalizedPayload.portfolios));
    data.portfolioVersions.unshift(...clone(normalizedPayload.portfolioVersions ?? []));
    data.transactions.unshift(...clone(normalizedPayload.transactions ?? []));
    data.cashMovements.unshift(...clone(normalizedPayload.cashMovements ?? []));
    data.portfolioSnapshots.unshift(...clone(normalizedPayload.portfolioSnapshots ?? []));
    data.rebalanceSuggestions.unshift(...clone(normalizedPayload.rebalanceSuggestions ?? []));
    data.customFunds.unshift(...clone(normalizedPayload.customFunds));
    data.dcaPlans.unshift(...clone(normalizedPayload.dcaPlans));
    data.watchlist.unshift(...clone(normalizedPayload.watchlist));
    data.reports.unshift(...clone(normalizedPayload.reports));
    data.insightRecommendations.unshift(
      ...clone(normalizedPayload.insightRecommendations ?? []).map((item) => ({
        ...(item as LocalInsightRecommendation),
        simulationSummary: { ...((item as LocalInsightRecommendation).simulationSummary ?? {}), marketId },
      })),
    );
    if (normalizedPayload.activePortfolio?.id) data.activePortfolioByMarket[marketId] = normalizedPayload.activePortfolio.id;
    return counts;
  });
  return { ok: true, marketId, mode, imported: counts, idChanges: 0, message: "Settings imported locally." };
}

function normalizeSettingsImportPayload(marketId: MarketId, payload: SettingsExportPayload): SettingsExportPayload {
  const portfolios = requiredImportArray(payload, "portfolios").map((item, index) => normalizeImportedPortfolio(item, index, marketId)).filter((item): item is Portfolio => Boolean(item));
  const activePortfolio = isPlainRecord(payload.activePortfolio) ? normalizeImportedPortfolio(payload.activePortfolio, 0, marketId) ?? undefined : undefined;

  return {
    ...payload,
    marketId,
    generatedAt: safeString(payload.generatedAt) || nowIso(),
    portfolios,
    activePortfolio,
    portfolioVersions: optionalImportArray(payload, "portfolioVersions").map((item, index) => normalizeImportedPortfolioVersion(item, index, marketId)).filter((item): item is PortfolioVersionRecord => Boolean(item)),
    transactions: normalizeImportedMarketRecords<Transaction>(optionalImportArray(payload, "transactions"), marketId),
    cashMovements: normalizeImportedMarketRecords<CashMovement>(optionalImportArray(payload, "cashMovements"), marketId),
    portfolioSnapshots: normalizeImportedMarketRecords<PortfolioSnapshot>(optionalImportArray(payload, "portfolioSnapshots"), marketId),
    rebalanceSuggestions: normalizeImportedMarketRecords<RebalanceSuggestion>(optionalImportArray(payload, "rebalanceSuggestions"), marketId),
    customFunds: requiredImportArray(payload, "customFunds").map((item, index) => normalizeImportedCustomFund(item, index, marketId)).filter((item): item is CustomFundRecord => Boolean(item)),
    dcaPlans: normalizeImportedMarketRecords<DcaPlan>(requiredImportArray(payload, "dcaPlans"), marketId),
    watchlist: normalizeImportedMarketRecords<WatchlistItem>(requiredImportArray(payload, "watchlist"), marketId),
    reports: normalizeImportedMarketRecords<ReportRecord>(requiredImportArray(payload, "reports"), marketId),
    insightRecommendations: optionalImportArray(payload, "insightRecommendations").filter(isPlainRecord),
    preferences: optionalImportArray(payload, "preferences").filter(isPlainRecord) as SettingsExportPayload["preferences"],
  };
}

function requiredImportArray(payload: SettingsExportPayload, key: keyof SettingsExportPayload): unknown[] {
  return importArrayField(payload, key);
}

function optionalImportArray(payload: SettingsExportPayload, key: keyof SettingsExportPayload): unknown[] {
  return importArrayField(payload, key);
}

function importArrayField(payload: SettingsExportPayload, key: keyof SettingsExportPayload): unknown[] {
  const value = payload[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`Imported settings field "${String(key)}" must be an array.`);
  return value;
}

function normalizeImportedMarketRecords<T>(values: unknown[], marketId: MarketId): T[] {
  return values
    .filter(isPlainRecord)
    .map((item) => ({ ...clone(item), userId: BROWSER_USER_ID, marketId }) as T);
}

function normalizeImportedPortfolio(value: unknown, index: number, marketId: MarketId): Portfolio | null {
  if (!isPlainRecord(value)) return null;
  const id = safeString(value.id) || createId("portfolio");
  const now = nowIso();
  return {
    ...clone(value),
    id,
    userId: BROWSER_USER_ID,
    marketId,
    name: safeString(value.name) || `Imported Portfolio ${index + 1}`,
    currency: "USD",
    goal: safeString(value.goal) || "Imported portfolio",
    riskPreference: safeString(value.riskPreference) || "Balanced",
    cashBalance: finiteNumber(value.cashBalance),
    capital: nullableNumber(value.capital),
    startDate: safeString(value.startDate) || null,
    endDate: safeString(value.endDate) || null,
    dcaPlans: isPlainRecord(value.dcaPlans) ? (clone(value.dcaPlans) as Record<string, PortfolioDcaPlan>) : {},
    valueHistory: normalizeTimePoints(value.valueHistory),
    contributionHistory: normalizeTimePoints(value.contributionHistory),
    createdAt: safeString(value.createdAt) || now,
    updatedAt: safeString(value.updatedAt) || now,
    holdings: normalizeImportedHoldings(value.holdings, id, marketId),
  };
}

function normalizeImportedPortfolioVersion(value: unknown, index: number, marketId: MarketId): PortfolioVersionRecord | null {
  if (!isPlainRecord(value)) return null;
  const data = normalizeImportedPortfolio(value.data, index, marketId);
  const portfolioId = safeString(value.portfolioId) || data?.id || "";
  if (!portfolioId) return null;
  return {
    ...clone(value),
    id: safeString(value.id) || createId("portfolio-version"),
    userId: BROWSER_USER_ID,
    portfolioId,
    marketId,
    version: positiveInteger(value.version, index + 1),
    name: safeString(value.name) || `Imported version ${index + 1}`,
    savedAt: safeString(value.savedAt) || nowIso(),
    data: data ?? normalizeImportedPortfolio({ id: portfolioId }, index, marketId)!,
  };
}

function normalizeImportedHoldings(value: unknown, portfolioId: string, marketId: MarketId): Holding[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => normalizeImportedHolding(item, index, portfolioId, marketId))
    .filter((item): item is Holding => Boolean(item));
}

function normalizeImportedHolding(value: unknown, index: number, portfolioId: string, marketId: MarketId): Holding | null {
  if (!isPlainRecord(value)) return null;
  const assetId = safeString(value.assetId);
  if (!assetId) return null;
  const now = nowIso();
  return {
    ...clone(value),
    id: safeString(value.id) || createId("holding"),
    portfolioId,
    assetId,
    assetType: normalizeImportedAssetType(value.assetType),
    marketId,
    name: safeString(value.name) || assetId,
    symbol: safeString(value.symbol) || assetId,
    quantity: finiteNumber(value.quantity),
    averageCost: finiteNumber(value.averageCost),
    currentPrice: finiteNumber(value.currentPrice),
    targetWeight: finiteNumber(value.targetWeight),
    sector: safeString(value.sector) || "Other",
    createdAt: safeString(value.createdAt) || now,
    updatedAt: safeString(value.updatedAt) || now,
  };
}

function normalizeImportedCustomFund(value: unknown, index: number, marketId: MarketId): CustomFundRecord | null {
  if (!isPlainRecord(value)) return null;
  const id = safeString(value.id) || createId("custom-fund");
  const now = nowIso();
  const name = safeString(value.name) || `Imported Custom Fund ${index + 1}`;
  const style = safeString(value.style) || "Custom";
  const holdings = normalizeImportedCustomFundHoldings(value.holdings);
  return {
    ...clone(value),
    id,
    userId: BROWSER_USER_ID,
    marketId,
    name,
    style,
    holdings,
    score: normalizeImportedCustomFundScore(value.score),
    capital: nullableNumber(value.capital),
    cashBalance: nullableNumber(value.cashBalance),
    startDate: safeString(value.startDate) || null,
    endDate: safeString(value.endDate) || null,
    dcaPlans: isPlainRecord(value.dcaPlans) ? (clone(value.dcaPlans) as Record<string, PortfolioDcaPlan>) : {},
    version: positiveInteger(value.version, 1),
    versions: normalizeImportedCustomFundVersions(value.versions, holdings, name, style),
    createdAt: safeString(value.createdAt) || now,
    updatedAt: safeString(value.updatedAt) || now,
  };
}

function normalizeImportedCustomFundHoldings(value: unknown): CustomFundHolding[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainRecord)
    .map((item) => ({
      stockId: safeString(item.stockId),
      weight: finiteNumber(item.weight),
      ...(typeof item.locked === "boolean" ? { locked: item.locked } : {}),
    }))
    .filter((item) => item.stockId);
}

function normalizeImportedCustomFundVersions(
  value: unknown,
  fallbackHoldings: CustomFundHolding[],
  fallbackName: string,
  fallbackStyle: string,
): CustomFundRecord["versions"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainRecord)
    .map((item, index) => ({
      version: positiveInteger(item.version, index + 1),
      name: safeString(item.name) || `Imported version ${index + 1}`,
      savedAt: safeString(item.savedAt) || nowIso(),
      data: normalizeImportedCustomFundVersionData(item.data, fallbackHoldings, fallbackName, fallbackStyle),
    }));
}

function normalizeImportedCustomFundVersionData(
  value: unknown,
  fallbackHoldings: CustomFundHolding[],
  fallbackName: string,
  fallbackStyle: string,
): CustomFundRecord["versions"][number]["data"] {
  const record: Record<string, unknown> = isPlainRecord(value) ? value : {};
  const holdings = normalizeImportedCustomFundHoldings(record.holdings);
  return {
    name: safeString(record.name) || fallbackName,
    style: safeString(record.style) || fallbackStyle,
    holdings: holdings.length ? holdings : fallbackHoldings,
    capital: nullableNumber(record.capital),
    cashBalance: nullableNumber(record.cashBalance),
    startDate: safeString(record.startDate) || null,
    endDate: safeString(record.endDate) || null,
    dcaPlans: isPlainRecord(record.dcaPlans) ? (clone(record.dcaPlans) as Record<string, PortfolioDcaPlan>) : {},
  };
}

function normalizeImportedCustomFundScore(value: unknown): CustomFundScore {
  const record = isPlainRecord(value) ? value : {};
  return {
    totalWeight: finiteNumber(record.totalWeight),
    peRatio: finiteNumber(record.peRatio),
    pbRatio: finiteNumber(record.pbRatio),
    dividendYield: finiteNumber(record.dividendYield),
    roe: finiteNumber(record.roe),
    volatility: finiteNumber(record.volatility),
    valueScore: finiteNumber(record.valueScore),
    qualityScore: finiteNumber(record.qualityScore),
    dividendScore: finiteNumber(record.dividendScore),
    riskScore: finiteNumber(record.riskScore),
    concentrationScore: finiteNumber(record.concentrationScore),
    sectorExposure: normalizeExposure(value, "sectorExposure"),
    backtestHistory: normalizeTimePoints(record.backtestHistory),
    maxDrawdown: finiteNumber(record.maxDrawdown),
  };
}

function normalizeExposure(value: unknown, key: string) {
  if (!isPlainRecord(value) || !Array.isArray(value[key])) return [];
  return value[key]
    .filter(isPlainRecord)
    .map((item) => ({ name: safeString(item.name) || "Other", weight: finiteNumber(item.weight) }));
}

function normalizeTimePoints(value: unknown): TimePoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainRecord)
    .map((item) => ({ date: safeString(item.date), value: finiteNumber(item.value) }))
    .filter((item) => item.date);
}

function normalizeImportedAssetType(value: unknown): AssetType {
  return value === "fund" || value === "stock" || value === "etf" || value === "customFund" || value === "customAsset" ? value : "stock";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function buildLocalJobsResponse(marketId?: MarketId): JobsResponse {
  const jobs = readLocalUserData().jobs.filter((job) => !marketId || job.marketId === marketId);
  return { ok: true, marketId, jobs };
}

export function recordLocalJob(type: BackgroundJob["type"], marketId?: MarketId, result: Record<string, unknown> = {}) {
  return mutateLocalUserData((data) => {
    const now = nowIso();
    const job: BackgroundJob = {
      id: createId("job"),
      type,
      marketId,
      status: "succeeded",
      attempts: 1,
      maxAttempts: 1,
      scheduledAt: now,
      startedAt: now,
      finishedAt: now,
      result,
    };
    data.jobs.unshift(job);
    data.jobs = data.jobs.slice(0, 50);
    return job;
  });
}

export function localInsightRecommendations(marketId: MarketId, limit = 8) {
  return readLocalUserData().insightRecommendations
    .filter((item) => (item.simulationSummary as { marketId?: MarketId }).marketId === marketId)
    .slice(0, limit)
    .map((item) => ({ ...item, marketId }));
}

export function saveLocalInsightRecommendation(marketId: MarketId, title: string, result: {
  selectedAssets?: unknown[];
  simulationSummary?: Record<string, unknown>;
  strategies?: unknown[];
  insights?: unknown[];
  methodology?: string[];
}) {
  return mutateLocalUserData((data) => {
    const now = nowIso();
    const record: LocalInsightRecommendation = {
      id: createId("insight-rec"),
      title,
      createdAt: now,
      selectedAssets: result.selectedAssets,
      simulationSummary: { ...(result.simulationSummary ?? {}), marketId },
      strategies: result.strategies ?? [],
      insights: result.insights,
      methodology: result.methodology,
    };
    data.insightRecommendations.unshift(record);
    data.insightRecommendations = data.insightRecommendations.slice(0, 100);
    return record;
  });
}

function readLocalUserData(): LocalUserData {
  if (typeof window === "undefined") return emptyLocalUserData();
  try {
    return normalizeLocalUserData(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return emptyLocalUserData();
  }
}

function writeLocalUserData(data: LocalUserData) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, updatedAt: nowIso() }));
}

function mutateLocalUserData<T>(mutator: (data: LocalUserData) => T): T {
  const data = readLocalUserData();
  const result = mutator(data);
  data.updatedAt = nowIso();
  writeLocalUserData(data);
  return result;
}

function emptyLocalUserData(): LocalUserData {
  return {
    version: DATA_VERSION,
    activePortfolioByMarket: {},
    portfolios: [],
    portfolioVersions: [],
    transactions: [],
    cashMovements: [],
    watchlist: [],
    dcaPlans: [],
    customFunds: [],
    portfolioSnapshots: [],
    rebalanceSuggestions: [],
    reports: [],
    jobs: [],
    insightRecommendations: [],
    updatedAt: nowIso(),
  };
}

function normalizeLocalUserData(value: unknown): LocalUserData {
  const base = emptyLocalUserData();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const input = value as Partial<LocalUserData>;
  return {
    ...base,
    ...input,
    version: DATA_VERSION,
    activePortfolioByMarket: input.activePortfolioByMarket && typeof input.activePortfolioByMarket === "object" ? input.activePortfolioByMarket : {},
    portfolios: arrayValue(input.portfolios),
    portfolioVersions: arrayValue(input.portfolioVersions),
    transactions: arrayValue(input.transactions),
    cashMovements: arrayValue(input.cashMovements),
    watchlist: arrayValue(input.watchlist),
    dcaPlans: arrayValue(input.dcaPlans),
    customFunds: arrayValue(input.customFunds),
    portfolioSnapshots: arrayValue(input.portfolioSnapshots),
    rebalanceSuggestions: arrayValue(input.rebalanceSuggestions),
    reports: arrayValue(input.reports),
    jobs: arrayValue(input.jobs),
    insightRecommendations: arrayValue(input.insightRecommendations),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : nowIso(),
  };
}

function arrayValue<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function localPortfolios(data: LocalUserData, marketId: MarketId) {
  return data.portfolios.filter((item) => item.marketId === marketId);
}

function localPortfolioVersions(data: LocalUserData, marketId: MarketId, portfolioId: string) {
  return data.portfolioVersions.filter((item) => item.marketId === marketId && item.portfolioId === portfolioId);
}

function localTransactions(data: LocalUserData, marketId: MarketId, portfolioId: string) {
  return data.transactions.filter((item) => item.marketId === marketId && item.portfolioId === portfolioId);
}

function localCashMovements(data: LocalUserData, marketId: MarketId, portfolioId: string) {
  return data.cashMovements.filter((item) => item.marketId === marketId && item.portfolioId === portfolioId);
}

function localPortfolioSnapshots(data: LocalUserData, marketId: MarketId, portfolioId: string) {
  return data.portfolioSnapshots.filter((item) => item.marketId === marketId && item.portfolioId === portfolioId);
}

function localRebalanceSuggestions(data: LocalUserData, marketId: MarketId, portfolioId: string) {
  return data.rebalanceSuggestions.filter((item) => item.marketId === marketId && item.portfolioId === portfolioId);
}

function requireLocalPortfolio(data: LocalUserData, marketId: MarketId, portfolioId: string) {
  const portfolio = data.portfolios.find((item) => item.marketId === marketId && item.id === portfolioId);
  if (!portfolio) throw new Error("Portfolio was not found.");
  return portfolio;
}

function pushPortfolioVersion(data: LocalUserData, portfolio: Portfolio, name: string) {
  const current = localPortfolioVersions(data, portfolio.marketId, portfolio.id);
  const version = Math.max(0, ...current.map((item) => item.version)) + 1;
  data.portfolioVersions.push({
    id: createId("portfolio-version"),
    userId: BROWSER_USER_ID,
    portfolioId: portfolio.id,
    marketId: portfolio.marketId,
    version,
    name,
    savedAt: nowIso(),
    data: clone(portfolio),
  });
  data.portfolioVersions = data.portfolioVersions.slice(-200);
}

function watchlistViewItem(item: WatchlistItem): WatchlistViewItem {
  return {
    id: item.id,
    assetId: item.assetId,
    assetType: item.assetType,
    name: item.name,
    symbol: item.symbol,
    price: item.price,
    target: item.target,
    dailyChange: item.dailyChange,
    reason: item.note,
    performance: item.sparkline,
    group: item.group,
    signal: `${item.dailyChange.toFixed(2)}% today`,
  };
}

function buildActivities(data: LocalUserData, marketId: MarketId, portfolioId: string | null): Activity[] {
  const transactions = data.transactions
    .filter((item) => item.marketId === marketId && (!portfolioId || item.portfolioId === portfolioId))
    .map((item) => ({
      id: item.id,
      marketId,
      title: `${item.side.toUpperCase()} ${item.assetId}`,
      subtitle: item.note ?? item.tradeDate,
      amount: item.quantity * item.price,
      date: item.tradeDate,
      type: item.side,
    }));
  const cash: Activity[] = data.cashMovements
    .filter((item) => item.marketId === marketId && (!portfolioId || item.portfolioId === portfolioId))
    .map((item) => ({
      id: item.id,
      marketId,
      title: item.type,
      subtitle: item.note ?? item.date,
      amount: item.amount,
      date: item.date,
      type: item.type === "deposit" ? "deposit" : item.type === "dividend" ? "dividend" : "sell" as Activity["type"],
    }));
  return [...transactions, ...cash].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
}

function buildReportPayload(data: LocalUserData, marketId: MarketId, type: ReportRecord["type"], params: Record<string, unknown>) {
  if (type === "portfolio") {
    const portfolioId = typeof params.portfolioId === "string" ? params.portfolioId : data.activePortfolioByMarket[marketId];
    const portfolio = localPortfolios(data, marketId).find((item) => item.id === portfolioId) ?? localPortfolios(data, marketId)[0];
    return portfolio ? { type, generatedAt: nowIso(), portfolio, summary: summarizePortfolio(portfolio) } : { type, generatedAt: nowIso() };
  }
  if (type === "dca") {
    const plan = data.dcaPlans.find((item) => item.marketId === marketId);
    return { type, generatedAt: nowIso(), plan };
  }
  const customFund = data.customFunds.find((item) => item.marketId === marketId);
  return { type, generatedAt: nowIso(), customFund };
}

function reportPayloadToCsv(payload: Record<string, unknown>) {
  return Object.entries(payload)
    .map(([key, value]) => `${escapeCsv(key)},${escapeCsv(typeof value === "object" ? JSON.stringify(value) : String(value ?? ""))}`)
    .join("\n");
}

function escapeCsv(value: string) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function universeForScore(universe: CustomFundUniverseItem[]) {
  return universe.map((item) => ({
    ...item,
    priceHistory: Array.isArray(item.priceHistory) ? item.priceHistory : [],
  }));
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function round6(value: number) {
  return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000;
}
