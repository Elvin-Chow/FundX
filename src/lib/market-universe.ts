import { STATIC_SECURITY_MASTER } from "./security-master";
import type { AssetRecord, DailyPrice, Fund, MarketId, SecurityMasterRecord, Stock } from "./types";

export type MarketUniversePatch = {
  securityMaster: SecurityMasterRecord[];
  funds: Fund[];
  stocks: Stock[];
  assets: AssetRecord[];
  dailyPrices: DailyPrice[];
};

export function buildExpandedMarketUniverse(): MarketUniversePatch {
  return patchFromSecurityMaster(STATIC_SECURITY_MASTER);
}

export function buildDiscoveredAssetsForQuery(): MarketUniversePatch {
  return emptyPatch();
}

export function patchFromSecurityMaster(records: SecurityMasterRecord[]): MarketUniversePatch {
  const funds = records.filter((record) => record.kind === "fund").map(securityMasterToFund);
  const stocks = records.filter((record) => record.kind === "stock").map(securityMasterToStock);
  const assets = records.map(securityMasterToAsset);
  return {
    securityMaster: records,
    funds,
    stocks,
    assets,
    dailyPrices: [],
  };
}

export function securityMasterToAsset(record: SecurityMasterRecord): AssetRecord {
  return {
    id: record.id,
    marketId: record.marketId,
    assetType: record.kind === "fund" ? "fund" : "stock",
    kind: record.kind,
    fundSubtype: record.fundSubtype,
    name: record.name,
    symbol: record.symbol,
    exchange: record.exchange,
    aliases: aliasesFor(record),
    industry: record.industry ?? record.category,
    sector: record.sector ?? record.category,
    category: record.category,
    fundType: record.fundSubtype,
    fundCompany: record.fundCompany,
    latestPrice: null,
    latestVolume: null,
    dailyChange: null,
    popularity: 0,
    source: "security-master",
    sourceName: record.sourceName,
    sourceUrl: record.sourceUrl,
    sourceAsOf: record.sourceAsOf,
    isTradable: record.isTradable,
    quoteStatus: "missing",
    updatedAt: record.sourceAsOf,
  };
}

function securityMasterToFund(record: SecurityMasterRecord): Fund {
  return {
    id: record.id,
    marketId: record.marketId,
    name: record.name,
    symbol: record.symbol,
    type: record.fundSubtype ?? "mutual_fund",
    category: record.category ?? "Unclassified",
    style: record.category ?? "Unclassified",
    nav: 0,
    dailyChange: 0,
    oneYearReturn: 0,
    threeYearAnnualizedReturn: 0,
    fiveYearAnnualizedReturn: 0,
    totalReturn: 0,
    maxDrawdown: 0,
    volatility: 0,
    sharpeRatio: 0,
    expenseRatio: 0,
    fundCompany: record.fundCompany,
    managementFee: undefined,
    custodianFee: undefined,
    salesFee: undefined,
    inceptionDate: undefined,
    scale: undefined,
    styleTags: [record.fundSubtype ?? "fund", record.category ?? ""].filter(Boolean),
    dividendYield: 0,
    aum: 0,
    riskLevel: "Balanced",
    holdings: [],
    sectorExposure: [],
    navHistory: [],
    dividends: [],
  };
}

function securityMasterToStock(record: SecurityMasterRecord): Stock {
  return {
    id: record.id,
    marketId: record.marketId,
    name: record.name,
    symbol: record.symbol,
    sector: record.sector ?? "Unclassified",
    industry: record.industry ?? "Unclassified",
    price: 0,
    dailyChange: 0,
    marketCap: 0,
    peRatio: 0,
    pbRatio: 0,
    dividendYield: 0,
    roe: 0,
    grossMargin: 0,
    debtRatio: 0,
    freeCashFlowYield: 0,
    revenueGrowth: 0,
    profitGrowth: 0,
    volatility: 0,
    valueScore: 0,
    qualityScore: 0,
    riskScore: 0,
    priceHistory: [],
  };
}

function aliasesFor(record: SecurityMasterRecord) {
  return Array.from(new Set([
    record.name,
    record.symbol,
    record.id,
    record.exchange,
    record.category,
    record.sector,
    record.industry,
    ...record.aliases ?? [],
  ].filter(Boolean).flatMap((value) => [value!, value!.toLowerCase()])));
}

function emptyPatch(): MarketUniversePatch {
  return { securityMaster: [], funds: [], stocks: [], assets: [], dailyPrices: [] };
}
