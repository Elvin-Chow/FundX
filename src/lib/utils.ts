import type { MarketId, TimePoint, TimeRange } from "./types";

export function cn(...inputs: Array<string | false | null | undefined>): string {
  return inputs.filter(Boolean).join(" ");
}

export function parseMarket(value?: string | null): MarketId {
  return "us";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function sumBy<T>(items: T[], getValue: (item: T) => number): number {
  return items.reduce((total, item) => total + getValue(item), 0);
}

export function weightedAverage(items: Array<{ value: number; weight: number }>): number {
  const totalWeight = sumBy(items, (item) => item.weight);
  if (totalWeight === 0) return 0;
  return sumBy(items, (item) => item.value * item.weight) / totalWeight;
}

export function groupWeight(items: Array<{ name: string; weight: number }>) {
  const grouped = new Map<string, number>();
  items.forEach((item) => grouped.set(item.name, (grouped.get(item.name) ?? 0) + item.weight));
  return Array.from(grouped.entries())
    .map(([name, weight]) => ({ name, weight: round(weight, 4) }))
    .sort((a, b) => b.weight - a.weight);
}

export function filterHistoryByRange(history: TimePoint[], range: TimeRange): TimePoint[] {
  if (range === "ALL") return history;
  const windows: Record<Exclude<TimeRange, "ALL">, number> = {
    "1D": 2,
    "1W": 7,
    "1M": 30,
    "3M": 90,
    "6M": 126,
    "1Y": 252,
    "3Y": 756,
    "5Y": 1260,
    "10Y": 2520,
  };
  return history.slice(-windows[range]);
}

export function normalizeWeights<T extends { weight: number }>(items: T[]): T[] {
  const total = sumBy(items, (item) => item.weight) || 1;
  return items.map((item) => ({ ...item, weight: item.weight / total }));
}

export function daysBetween(start: string, end: string): number {
  const diff = new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime();
  return Math.max(1, Math.round(diff / 86_400_000));
}

export function yearsBetween(start: string, end: string): number {
  return daysBetween(start, end) / 365.25;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function addMonths(date: Date, months: number): Date {
  const monthIndex = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function sortHistory(history: TimePoint[]): TimePoint[] {
  return [...history].sort((a, b) => a.date.localeCompare(b.date));
}

export function filterHistoryByDateRange(history: TimePoint[], startDate: string, endDate: string): TimePoint[] {
  return sortHistory(history).filter((point) => point.date >= startDate && point.date <= endDate);
}

export function buildContributionDates(startDate: string, endDate: string, frequency: string): string[] {
  const dates: string[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  let cursor = start;
  const end = new Date(`${endDate}T00:00:00Z`);
  let monthOffset = 0;

  while (cursor <= end) {
    dates.push(isoDate(cursor));
    if (frequency === "weekly") cursor = addDays(cursor, 7);
    else if (frequency === "biweekly") cursor = addDays(cursor, 14);
    else if (frequency === "quarterly") {
      monthOffset += 3;
      cursor = addMonths(start, monthOffset);
    } else if (frequency === "yearly") {
      monthOffset += 12;
      cursor = addMonths(start, monthOffset);
    } else {
      monthOffset += 1;
      cursor = addMonths(start, monthOffset);
    }
  }

  return dates;
}

export function assertSameMarket(marketId: MarketId, items: Array<{ marketId: MarketId }>): void {
  if (items.some((item) => item.marketId !== marketId)) {
    throw new Error(`Mixed-market data is not supported. Expected ${marketId}.`);
  }
}
