import type { MarketConfig, MarketId } from "./types";

export const US_SECTORS = [
  "Technology",
  "Healthcare",
  "Financials",
  "Consumer Staples",
  "Consumer Discretionary",
  "Industrials",
  "Energy",
  "Utilities",
  "Communication Services",
  "Materials",
  "Real Estate",
] as const;

export const MARKET_CONFIGS: Record<MarketId, MarketConfig> = {
  us: {
    id: "us",
    name: "US Market",
    region: "United States",
    currency: "USD",
    currencySymbol: "$",
    accent: "#00c805",
    benchmarks: ["S&P 500", "Nasdaq 100", "Dow Jones", "Russell 1000 Value"],
    sectors: [...US_SECTORS],
    style: "Quality compounders, index core, dividend value, and defensive cash buffers.",
  },
};

export const MARKETS = MARKET_CONFIGS;

export const TRADING_DAYS_PER_YEAR = 252;

export const DEFENSIVE_SECTORS: Record<MarketId, string[]> = {
  us: ["Healthcare", "Consumer Staples", "Utilities"],
};

export const CYCLICAL_SECTORS: Record<MarketId, string[]> = {
  us: ["Consumer Discretionary", "Industrials", "Energy", "Materials", "Financials"],
};
