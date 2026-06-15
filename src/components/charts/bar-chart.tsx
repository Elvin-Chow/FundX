import type { ChartPoint } from "../types";

type BarChartProps = {
  data: ChartPoint[];
  accent?: string;
};

export function BarChart({ data, accent = "#00c805" }: BarChartProps) {
  const max = Math.max(...data.map((point) => point.value), 1);

  return (
    <div className="space-y-3">
      {data.map((point) => (
        <div key={point.label} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-2 text-sm sm:grid-cols-[5rem_1fr_3rem] sm:gap-3">
          <span className="order-1 truncate text-zinc-500 sm:order-none">{point.label}</span>
          <div className="order-3 col-span-2 h-2 rounded-full bg-zinc-100 sm:order-none sm:col-span-1">
            <div className="h-2 rounded-full" style={{ width: `${(point.value / max) * 100}%`, backgroundColor: accent }} />
          </div>
          <span className="order-2 text-right font-medium text-zinc-950 sm:order-none">{point.value.toFixed(0)}%</span>
        </div>
      ))}
    </div>
  );
}
