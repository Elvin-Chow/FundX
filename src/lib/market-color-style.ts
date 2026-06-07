import type { Tone } from "./types";

export type MarketColorStyle = "greenUpRedDown" | "redUpGreenDown";

export const DEFAULT_MARKET_COLOR_STYLE: MarketColorStyle = "greenUpRedDown";

export function parseMarketColorStyle(value: string | null | undefined): MarketColorStyle {
  if (value === "redUpGreenDown") return value;
  return DEFAULT_MARKET_COLOR_STYLE;
}

export function marketColorStyleLabelKey(style: MarketColorStyle) {
  return style === "redUpGreenDown" ? "settings.marketColorStyleRedUpGreenDown" : "settings.marketColorStyleGreenUpRedDown";
}

export function marketColorStyleDescriptionKey(style: MarketColorStyle) {
  return style === "redUpGreenDown" ? "settings.marketColorStyleRedUpGreenDownDesc" : "settings.marketColorStyleGreenUpRedDownDesc";
}

export function marketToneTextClass(tone: Tone | undefined, style: MarketColorStyle) {
  if (tone === "positive") {
    return style === "redUpGreenDown" ? "text-red-500 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400";
  }
  if (tone === "negative") {
    return style === "redUpGreenDown" ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400";
  }
  return "text-zinc-500 dark:text-zinc-400";
}

export function marketToneBadgeClass(tone: Tone | undefined, style: MarketColorStyle) {
  if (tone === "positive") {
    return style === "redUpGreenDown"
      ? "bg-red-50 text-red-600 dark:bg-red-400/10 dark:text-red-300"
      : "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300";
  }
  if (tone === "negative") {
    return style === "redUpGreenDown"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300"
      : "bg-red-50 text-red-600 dark:bg-red-400/10 dark:text-red-300";
  }
  return "bg-zinc-100 text-zinc-500 dark:bg-white/10 dark:text-zinc-400";
}

export function marketToneColor(tone: Tone | undefined, style: MarketColorStyle) {
  if (tone === "positive") return style === "redUpGreenDown" ? "#ef4444" : "#00c805";
  if (tone === "negative") return style === "redUpGreenDown" ? "#00c805" : "#ef4444";
  return "#71717a";
}
