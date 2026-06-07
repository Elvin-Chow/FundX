import type { ReactNode } from "react";

export type Market = "us" | "US";

export type MarketCode = "us";

export type TimeRange = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "3Y" | "5Y" | "10Y" | "ALL";

export type NavItem = {
  label: string;
  href: string;
  icon?: ReactNode;
  active?: boolean;
};

export type Metric = {
  label: string;
  value: string;
  delta?: string;
  tone?: "positive" | "negative" | "neutral";
};

export type ChartPoint = {
  label?: string;
  date?: string;
  value: number;
};

export type SeriesPoint = ChartPoint & {
  secondaryValue?: number;
};

export type AllocationSlice = {
  label: string;
  value: number;
  color?: string;
};

export type AssetRow = {
  id: string;
  name: string;
  symbol: string;
  href?: string;
  linkState?: unknown;
  subtitle?: string;
  value?: string;
  allocation?: string;
  delta?: string;
  tone?: "positive" | "negative" | "neutral";
};

export type Insight = {
  title: string;
  body: string;
  actionLabel?: string;
  tone?: "positive" | "negative" | "neutral";
};

export function normalizeMarket(market: Market = "us"): MarketCode {
  return "us";
}
