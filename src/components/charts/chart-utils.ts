import type { ChartPoint } from "../types";

export function normalizePoints(points: ChartPoint[], width: number, height: number, padding = 8) {
  if (!points.length) return [];

  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const xStep = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;

  return points.map((point, index) => ({
    ...point,
    label: point.label ?? point.date ?? String(index + 1),
    x: padding + index * xStep,
    y: height - padding - ((point.value - min) / range) * (height - padding * 2),
  }));
}

export function toPath(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

export function formatCompactNumber(value: number) {
  return Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
