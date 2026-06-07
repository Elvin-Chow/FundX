"use client";

import { create } from "zustand";
import { MARKET_CONFIGS } from "@/lib/constants";
import { DEFAULT_LANGUAGE, parseLanguage, type Language } from "@/lib/i18n";
import { DEFAULT_MARKET_COLOR_STYLE, parseMarketColorStyle, type MarketColorStyle } from "@/lib/market-color-style";
import type { MarketId, TimeRange } from "@/lib/types";

export type ThemeMode = "light" | "dark" | "auto";
export type AccountCurrency = "market" | "USD";

type PreferencesState = {
  marketId: MarketId;
  timeRange: TimeRange;
  themeMode: ThemeMode;
  darkMode: boolean;
  accountCurrency: AccountCurrency;
  benchmarkByMarket: Record<MarketId, string>;
  language: Language;
  marketColorStyle: MarketColorStyle;
  compactHoldings: boolean;
  setMarket: (marketId: MarketId) => void;
  setTimeRange: (timeRange: TimeRange) => void;
  setLanguage: (language: Language) => void;
  setThemeMode: (themeMode: ThemeMode) => void;
  setMarketColorStyle: (marketColorStyle: MarketColorStyle) => void;
  setAccountCurrency: (accountCurrency: AccountCurrency) => void;
  setBenchmark: (marketId: MarketId, benchmark: string) => void;
  syncThemeMode: () => void;
  toggleCompactHoldings: () => void;
};

function readStoredMarket(): MarketId {
  return "us";
}

function readStoredThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const value = window.localStorage.getItem("fundx-theme");
  if (value === "dark" || value === "auto") return value;
  return "light";
}

function readStoredAccountCurrency(): AccountCurrency {
  if (typeof window === "undefined") return "market";
  const value = window.localStorage.getItem("fundx-account-currency");
  if (value === "USD") return value;
  return "market";
}

function readStoredMarketColorStyle(): MarketColorStyle {
  if (typeof window === "undefined") return DEFAULT_MARKET_COLOR_STYLE;
  return parseMarketColorStyle(window.localStorage.getItem("fundx-market-color-style"));
}

function defaultBenchmarks(): Record<MarketId, string> {
  return {
    us: MARKET_CONFIGS.us.benchmarks[0],
  };
}

function readStoredBenchmarks(): Record<MarketId, string> {
  if (typeof window === "undefined") return defaultBenchmarks();
  try {
    const parsed = JSON.parse(window.localStorage.getItem("fundx-benchmarks") ?? "{}") as Partial<Record<MarketId, string>>;
    return {
      us: MARKET_CONFIGS.us.benchmarks.includes(parsed.us ?? "") ? parsed.us ?? MARKET_CONFIGS.us.benchmarks[0] : MARKET_CONFIGS.us.benchmarks[0],
    };
  } catch {
    return defaultBenchmarks();
  }
}

function shouldUseDarkByTime() {
  if (typeof window === "undefined") return false;
  const hour = new Date().getHours();
  return hour < 7 || hour >= 19;
}

function resolveDarkMode(themeMode: ThemeMode) {
  if (themeMode === "dark") return true;
  if (themeMode === "auto") return shouldUseDarkByTime();
  return false;
}

function applyDocumentTheme(darkMode: boolean) {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", darkMode);
  }
}

function readStoredLanguage(): Language {
  if (typeof window === "undefined") return DEFAULT_LANGUAGE;
  return parseLanguage(window.localStorage.getItem("fundx-language"));
}

export const useMarketStore = create<PreferencesState>((set) => ({
  marketId: readStoredMarket(),
  timeRange: "ALL",
  themeMode: readStoredThemeMode(),
  darkMode: resolveDarkMode(readStoredThemeMode()),
  accountCurrency: readStoredAccountCurrency(),
  benchmarkByMarket: readStoredBenchmarks(),
  language: readStoredLanguage(),
  marketColorStyle: readStoredMarketColorStyle(),
  compactHoldings: false,
  setMarket: (marketId) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("fundx-market", "us");
    }
    set({ marketId: "us" });
  },
  setTimeRange: (timeRange) => set({ timeRange }),
  setLanguage: (language) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("fundx-language", language);
    }
    set({ language });
  },
  setThemeMode: (themeMode) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("fundx-theme", themeMode);
    }
    const darkMode = resolveDarkMode(themeMode);
    applyDocumentTheme(darkMode);
    set({ themeMode, darkMode });
  },
  setMarketColorStyle: (marketColorStyle) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("fundx-market-color-style", marketColorStyle);
    }
    set({ marketColorStyle });
  },
  setAccountCurrency: (accountCurrency) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("fundx-account-currency", accountCurrency);
    }
    set({ accountCurrency });
  },
  setBenchmark: (marketId, benchmark) =>
    set((state) => {
      const next = { ...state.benchmarkByMarket, [marketId]: benchmark };
      if (typeof window !== "undefined") {
        window.localStorage.setItem("fundx-benchmarks", JSON.stringify(next));
      }
      return { benchmarkByMarket: next };
    }),
  syncThemeMode: () =>
    set((state) => {
      const darkMode = resolveDarkMode(state.themeMode);
      applyDocumentTheme(darkMode);
      return state.darkMode === darkMode ? {} : { darkMode };
    }),
  toggleCompactHoldings: () => set((state) => ({ compactHoldings: !state.compactHoldings }))
}));
