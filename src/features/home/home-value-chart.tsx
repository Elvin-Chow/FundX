"use client";

import { useState } from "react";
import { LineChart } from "@/components/charts";
import type { TimePoint, TimeRange } from "@/lib/types";
import { cn, filterHistoryByRange } from "@/lib/utils";

const ranges: TimeRange[] = ["1D", "1W", "1M", "3M", "6M", "1Y", "3Y", "5Y", "10Y", "ALL"];

export function HomeValueChart({ data }: { data: TimePoint[] }) {
  const [range, setRange] = useState<TimeRange>("ALL");
  const visibleData = filterHistoryByRange(data, range);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-1">
        {ranges.map((item) => (
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
      <LineChart data={visibleData} />
    </div>
  );
}
