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
        <div key={point.label} className="grid grid-cols-[5rem_1fr_3rem] items-center gap-3 text-sm">
          <span className="truncate text-zinc-500">{point.label}</span>
          <div className="h-2 rounded-full bg-zinc-100">
            <div className="h-2 rounded-full" style={{ width: `${(point.value / max) * 100}%`, backgroundColor: accent }} />
          </div>
          <span className="text-right font-medium text-zinc-950">{point.value.toFixed(0)}%</span>
        </div>
      ))}
    </div>
  );
}
