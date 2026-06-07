import type { TimePoint } from "@/lib/types";
import { marketToneColor, marketToneTextClass } from "@/lib/market-color-style";
import { cn } from "@/lib/utils";
import { useMarketStore } from "@/stores/market-store";

type LineChartProps = {
  data: TimePoint[];
  height?: number;
  color?: string;
  muted?: boolean;
  showArea?: boolean;
  showTooltip?: boolean;
  showAxes?: boolean;
  xAxisLabel?: string;
  yAxisLabel?: string;
  yValueFormatter?: (value: number) => string;
  className?: string;
};

function points(data: TimePoint[], width: number, height: number) {
  if (data.length === 0) return "";
  const values = data.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  return data
    .map((point, index) => {
      const x = data.length === 1 ? 0 : (index / (data.length - 1)) * width;
      const y = height - ((point.value - min) / span) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export function LineChart({
  data,
  height = 220,
  color: colorProp,
  muted = false,
  showArea = true,
  showAxes = false,
  xAxisLabel = "Date",
  yAxisLabel = "Value",
  yValueFormatter = formatAxisValue,
  className
}: LineChartProps) {
  const marketColorStyle = useMarketStore((state) => state.marketColorStyle);
  const color = colorProp ?? marketToneColor("positive", marketColorStyle);
  const width = 720;
  const chartHeight = showAxes ? Math.max(80, height - 46) : height;
  const values = data.map((point) => point.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const startDate = fullDateLabel(data[0]);
  const middleDate = fullDateLabel(data[Math.floor((data.length - 1) / 2)]);
  const endDate = fullDateLabel(data[data.length - 1]);

  if (showAxes) {
    return (
      <div className={cn("relative w-full overflow-hidden", className)} style={{ height }}>
        <div className="grid h-full grid-cols-[3.75rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_2.65rem] gap-x-2">
          <div className="grid min-h-0 grid-rows-[auto_1fr_auto] py-1 text-[10px] tabular-nums text-zinc-400">
            <span className="truncate text-right">{yValueFormatter(max)}</span>
            <span className="flex items-center justify-center text-[10px] font-medium text-zinc-500 [writing-mode:vertical-rl]">{yAxisLabel}</span>
            <span className="truncate text-right">{yValueFormatter(min)}</span>
          </div>
          <ChartSvg data={data} width={width} height={chartHeight} color={color} muted={muted} showArea={showArea} />
          <div />
          <div className="border-t border-zinc-200 pt-1">
            <div className="text-center text-[10px] font-medium text-zinc-500">{xAxisLabel}</div>
            <div className="mt-0.5 grid grid-cols-3 gap-2 text-[10px] tabular-nums text-zinc-400">
              <span className="truncate text-left">{startDate}</span>
              <span className="truncate text-center">{middleDate}</span>
              <span className="truncate text-right">{endDate}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative w-full overflow-hidden", className)} style={{ height }}>
      <ChartSvg data={data} width={width} height={chartHeight} color={color} muted={muted} showArea={showArea} />
    </div>
  );
}

function ChartSvg({
  data,
  width,
  height,
  color,
  muted,
  showArea,
}: {
  data: TimePoint[];
  width: number;
  height: number;
  color: string;
  muted: boolean;
  showArea: boolean;
}) {
  const chartPoints = points(data, width, height);
  const areaPoints = chartPoints ? `0,${height} ${chartPoints} ${width},${height}` : "";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block h-full w-full"
      role="img"
      aria-label="Value history chart"
    >
      <defs>
        <linearGradient id={`area-${color.replace("#", "")}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={muted ? 0.1 : 0.22} />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" x2={width} y1={height - 1} y2={height - 1} stroke="rgba(104,118,125,0.16)" />
      {showArea && areaPoints ? (
        <polygon points={areaPoints} fill={`url(#area-${color.replace("#", "")})`} />
      ) : null}
      {chartPoints ? (
        <polyline
          points={chartPoints}
          fill="none"
          stroke={color}
          strokeWidth={muted ? 2 : 3}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}

function fullDateLabel(point?: TimePoint) {
  return point?.date?.slice(0, 10) ?? "";
}

function formatAxisValue(value: number) {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(Math.abs(value) >= 10 ? 0 : 1);
}

type BarListProps = {
  data: Array<{ name: string; weight: number }>;
  color?: string;
  compact?: boolean;
};

export function AllocationBars({ data, color = "#00c805", compact = false }: BarListProps) {
  return (
    <div className="space-y-3">
      {data.map((item) => (
        <div key={item.name} className="space-y-1.5">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="truncate text-ink dark:text-white">{item.name}</span>
            <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{(item.weight * 100).toFixed(1)}%</span>
          </div>
          <div className={cn("overflow-hidden rounded-full bg-slate-100 dark:bg-white/10", compact ? "h-1.5" : "h-2")}>
            <div className="h-full rounded-full" style={{ width: `${Math.min(item.weight * 100, 100)}%`, backgroundColor: color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

type MiniMetricProps = {
  label: string;
  value: string;
  tone?: "positive" | "negative" | "neutral";
};

export function MiniMetric({ label, value, tone = "neutral" }: MiniMetricProps) {
  const marketColorStyle = useMarketStore((state) => state.marketColorStyle);

  return (
    <div className="border-t border-line py-4 dark:border-white/10">
      <p className="text-xs uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">{label}</p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums",
          tone !== "neutral" && marketToneTextClass(tone, marketColorStyle),
          tone === "neutral" && "text-ink dark:text-white"
        )}
      >
        {value}
      </p>
    </div>
  );
}
