"use client";

import { useEffect, useState } from "react";
import { LineChart } from "@/components/charts";
import type { TimePoint, TimeRange } from "@/lib/types";
import { cn } from "@/lib/utils";

const ranges: TimeRange[] = ["1D", "1W", "1M", "3M", "6M", "1Y", "3Y", "5Y", "10Y", "ALL"];
const rangeWindowDays: Record<Exclude<TimeRange, "ALL">, number> = {
  "1D": 1,
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "6M": 183,
  "1Y": 366,
  "3Y": 366 * 3,
  "5Y": 366 * 5,
  "10Y": 366 * 10,
};

export function HomeValueChart({ data, defaultRange }: { data: TimePoint[]; defaultRange?: TimeRange }) {
  const dataKey = `${data[0]?.date ?? ""}:${data.at(-1)?.date ?? ""}:${data.length}`;
  const availableRanges = availableRangesForHistory(data);
  const requestedDefaultRange = defaultRange ?? inferRangeFromHistory(data);
  const resolvedDefaultRange = availableRanges.includes(requestedDefaultRange) ? requestedDefaultRange : "ALL";
  const [range, setRange] = useState<TimeRange>(resolvedDefaultRange);
  const visibleData = filterHistoryByDateWindow(data, range);

  useEffect(() => {
    setRange(resolvedDefaultRange);
  }, [dataKey, resolvedDefaultRange]);

  return (
    <div className="space-y-4">
      {availableRanges.length > 1 ? (
        <div className="flex items-center justify-end gap-1 overflow-x-auto pb-1">
          {availableRanges.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setRange(item)}
              className={cn(
                "h-8 rounded px-3 text-sm font-medium transition",
                range === item ? "bg-ink text-white dark:bg-white dark:text-ink" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950"
              )}
            >
              {item}
            </button>
          ))}
        </div>
      ) : null}
      <LineChart data={visibleData} />
    </div>
  );
}

function inferRangeFromHistory(data: TimePoint[]): TimeRange {
  const days = historySpanDays(data);
  if (days == null) return "ALL";
  if (days <= 1) return "1D";
  if (days <= 7) return "1W";
  for (const range of ["1M", "3M", "6M", "1Y", "3Y", "5Y", "10Y"] as const) {
    const windowDays = rangeWindowDays[range];
    if (Math.abs(days - windowDays) <= Math.max(7, windowDays * 0.04)) return range;
  }
  return "ALL";
}

function availableRangesForHistory(data: TimePoint[]): TimeRange[] {
  const spanDays = historySpanDays(data);
  if (spanDays == null) return ["ALL"];
  const available = ranges.filter((range) => {
    if (range === "ALL") return true;
    if (rangeWindowDays[range] > spanDays + 1) return false;
    return filterHistoryByDateWindow(data, range).length >= 2;
  });
  return available.length ? available : ["ALL"];
}

function filterHistoryByDateWindow(data: TimePoint[], range: TimeRange): TimePoint[] {
  const history = [...data].sort((left, right) => left.date.localeCompare(right.date));
  if (range === "ALL" || history.length <= 1) return history;
  const endTime = Date.parse(`${history.at(-1)?.date ?? ""}T00:00:00Z`);
  if (!Number.isFinite(endTime)) return history;
  const startTime = endTime - rangeWindowDays[range] * 86_400_000;
  const filtered = history.filter((point) => {
    const pointTime = Date.parse(`${point.date}T00:00:00Z`);
    return Number.isFinite(pointTime) && pointTime >= startTime;
  });
  return filtered.length ? filtered : history.slice(-1);
}

function historySpanDays(data: TimePoint[]) {
  const history = [...data].sort((left, right) => left.date.localeCompare(right.date));
  const first = Date.parse(`${history[0]?.date ?? ""}T00:00:00Z`);
  const last = Date.parse(`${history.at(-1)?.date ?? ""}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return Math.max(1, Math.ceil((last - first) / 86_400_000));
}
