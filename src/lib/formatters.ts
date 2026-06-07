import type { MarketConfig, MarketId } from "./types";

const currencyFormatters = {
  us: new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }),
};

const compactCurrencyFormatters = {
  us: new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1
  }),
};

export function formatCurrency(value: number, marketOrConfig: MarketId | MarketConfig = "us") {
  const marketId = typeof marketOrConfig === "string" ? marketOrConfig : marketOrConfig.id;
  return currencyFormatters[marketId].format(value);
}

export function formatOptionalCurrency(value: number | null | undefined, marketOrConfig: MarketId | MarketConfig = "us", empty = "—") {
  return value == null ? empty : formatCurrency(value, marketOrConfig);
}

export function formatCompactCurrency(value: number, marketOrConfig: MarketId | MarketConfig = "us") {
  const marketId = typeof marketOrConfig === "string" ? marketOrConfig : marketOrConfig.id;
  return compactCurrencyFormatters[marketId].format(value);
}

export function formatOptionalCompactCurrency(value: number | null | undefined, marketOrConfig: MarketId | MarketConfig = "us", empty = "—") {
  return value == null ? empty : formatCompactCurrency(value, marketOrConfig);
}

export function formatPercent(value: number, digits = 1) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function formatOptionalPercent(value: number | null | undefined, digits = 1, empty = "—") {
  return value == null ? empty : formatPercent(value, digits);
}

export function formatSignedNumber(value: number, digits = 2) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(value);
}

export function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}
