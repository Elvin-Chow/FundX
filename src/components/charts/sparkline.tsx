import type { ChartPoint } from "../types";
import { marketToneColor } from "@/lib/market-color-style";
import { useMarketStore } from "@/stores/market-store";
import { normalizePoints, toPath } from "./chart-utils";

type SparklineProps = {
  data: ChartPoint[];
  tone?: "positive" | "negative" | "neutral";
};

export function Sparkline({ data, tone = "positive" }: SparklineProps) {
  const marketColorStyle = useMarketStore((state) => state.marketColorStyle);
  const color = marketToneColor(tone, marketColorStyle);
  const points = normalizePoints(data, 128, 44, 4);

  return (
    <svg viewBox="0 0 128 44" className="h-11 w-32">
      <path d={toPath(points)} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
    </svg>
  );
}
