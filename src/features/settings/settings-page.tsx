"use client";

import type { ComponentType, ReactNode } from "react";
import { useState } from "react";
import { CandlestickChart, Check, ChevronLeft, ChevronRight, Database, KeyRound, Languages, Moon, SlidersHorizontal, Sun, Timer } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { MARKET_CONFIGS } from "@/lib/constants";
import { getMarketCopy, LANGUAGE_OPTIONS, t, type Language } from "@/lib/i18n";
import { marketColorStyleDescriptionKey, marketColorStyleLabelKey, type MarketColorStyle } from "@/lib/market-color-style";
import type { MarketId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useMarketStore, type AccountCurrency, type ThemeMode } from "@/stores/market-store";
import { normalizeMarket, type Market } from "../../components/types";
import { ImportExportPanel } from "./import-export-panel";
import { LanguageSettings } from "./language-settings";
import { ProviderAccountsPanel } from "./provider-accounts-panel";

type SettingsPanel = "root" | "defaults" | "defaultMarket" | "currency" | "benchmark" | "language" | "theme" | "marketStyle" | "providers" | "data";

type SettingsRowProps = {
  title: string;
  subtitle?: string;
  value?: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
  iconClassName?: string;
  selected?: boolean;
  onClick?: () => void;
  children?: ReactNode;
};

const panelTitles: Record<Exclude<SettingsPanel, "root">, string> = {
  defaults: "settings.accountDefaults",
  defaultMarket: "settings.defaultMarket",
  currency: "common.currency",
  benchmark: "common.benchmark",
  language: "language.cardTitle",
  theme: "settings.theme",
  marketStyle: "settings.marketColorStyle",
  providers: "settings.providerAccounts",
  data: "settings.importExport",
};

export function SettingsPage({ market = "us", marketId, language = "en" }: { market?: Market; marketId?: Market; language?: Language }) {
  const activeMarket = normalizeMarket(marketId ?? market);
  const config = MARKET_CONFIGS[activeMarket];
  const marketCopy = getMarketCopy(language, activeMarket);
  const [panel, setPanel] = useState<SettingsPanel>("root");
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const [searchParams] = useSearchParams();
  const setMarket = useMarketStore((state) => state.setMarket);
  const accountCurrency = useMarketStore((state) => state.accountCurrency);
  const setAccountCurrency = useMarketStore((state) => state.setAccountCurrency);
  const benchmarkByMarket = useMarketStore((state) => state.benchmarkByMarket);
  const setBenchmark = useMarketStore((state) => state.setBenchmark);
  const themeMode = useMarketStore((state) => state.themeMode);
  const setThemeMode = useMarketStore((state) => state.setThemeMode);
  const marketColorStyle = useMarketStore((state) => state.marketColorStyle);
  const setMarketColorStyle = useMarketStore((state) => state.setMarketColorStyle);
  const currentLanguage = LANGUAGE_OPTIONS.find((option) => option.value === language)?.label ?? language;
  const activeBenchmark = benchmarkByMarket[activeMarket] ?? config.benchmarks[0];
  const activeCurrency = accountCurrency === "market" ? `${config.currency} ${config.currencySymbol}` : accountCurrency;

  function selectMarket(nextMarket: MarketId) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("market", nextMarket);
    params.set("lang", language);
    setMarket(nextMarket);
    navigate(`${pathname}?${params.toString()}`);
  }

  if (panel !== "root") {
    return (
      <SettingsDetail
        title={t(language, panelTitles[panel])}
        subtitle={detailSubtitle(panel, language)}
        onBack={() => setPanel("root")}
        backLabel={t(language, "settings.title")}
      >
        {panel === "defaults" ? (
          <SettingsGroup label={t(language, "settings.accountDefaults")}>
            <SettingsRow title={t(language, "settings.defaultMarket")} subtitle={t(language, "settings.defaultMarketDesc")} value={marketCopy.name} onClick={() => setPanel("defaultMarket")} />
            <SettingsRow title={t(language, "common.currency")} subtitle={t(language, "settings.currencyDesc")} value={activeCurrency} onClick={() => setPanel("currency")} />
            <SettingsRow title={t(language, "common.benchmark")} subtitle={t(language, "settings.benchmarkDesc")} value={activeBenchmark} onClick={() => setPanel("benchmark")} />
          </SettingsGroup>
        ) : null}

        {panel === "defaultMarket" ? <DefaultMarketSettings language={language} activeMarket={activeMarket} onSelect={selectMarket} /> : null}
        {panel === "currency" ? <CurrencySettings language={language} marketCurrency={`${config.currency} ${config.currencySymbol}`} accountCurrency={accountCurrency} onSelect={setAccountCurrency} /> : null}
        {panel === "benchmark" ? <BenchmarkSettings language={language} benchmarks={config.benchmarks} activeBenchmark={activeBenchmark} onSelect={(benchmark) => setBenchmark(activeMarket, benchmark)} /> : null}
        {panel === "language" ? <LanguageSettings language={language} marketId={activeMarket} /> : null}
        {panel === "theme" ? <ThemeSettings language={language} themeMode={themeMode} onThemeModeChange={setThemeMode} /> : null}
        {panel === "marketStyle" ? <MarketColorStyleSettings language={language} marketColorStyle={marketColorStyle} onMarketColorStyleChange={setMarketColorStyle} /> : null}
        {panel === "providers" ? <ProviderAccountsPanel marketId={activeMarket} language={language} /> : null}
        {panel === "data" ? <ImportExportPanel marketId={activeMarket} language={language} /> : null}
      </SettingsDetail>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="pb-5">
        <div className="text-xs font-medium uppercase tracking-wide text-emerald-600">{t(language, "settings.title")}</div>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight text-zinc-950 dark:text-white">{t(language, "settings.preferences")}</h1>
      </div>

      <div className="space-y-6">
        <SettingsGroup label={t(language, "common.market")}>
          <SettingsRow
            title={t(language, "settings.accountDefaults")}
            subtitle={`${activeCurrency} · ${activeBenchmark}`}
            value={activeCurrency}
            icon={SlidersHorizontal}
            iconClassName="bg-sky-600 text-white"
            onClick={() => setPanel("defaults")}
          />
        </SettingsGroup>

        <SettingsGroup label={t(language, "settings.visibility")}>
          <SettingsRow
            title={t(language, "settings.theme")}
            subtitle={t(language, "settings.themeDescription")}
            value={t(language, themeLabelKey(themeMode))}
            icon={themeMode === "dark" ? Moon : themeMode === "auto" ? Timer : Sun}
            iconClassName="bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
            onClick={() => setPanel("theme")}
          />
          <SettingsRow
            title={t(language, "settings.marketColorStyle")}
            subtitle={t(language, "settings.marketColorStyleDescription")}
            value={t(language, marketColorStyleLabelKey(marketColorStyle))}
            icon={CandlestickChart}
            iconClassName={marketColorStyle === "redUpGreenDown" ? "bg-red-600 text-white" : "bg-emerald-600 text-white"}
            onClick={() => setPanel("marketStyle")}
          />
          <SettingsRow
            title={t(language, "language.cardTitle")}
            subtitle={t(language, "language.cardDescription")}
            value={currentLanguage}
            icon={Languages}
            iconClassName="bg-violet-600 text-white"
            onClick={() => setPanel("language")}
          />
        </SettingsGroup>

        <SettingsGroup label={t(language, "settings.dataPortability")}>
          <SettingsRow
            title={t(language, "settings.providerAccounts")}
            subtitle={t(language, "settings.providerAccountsDescription")}
            value={t(language, "settings.providerAccountsEyebrow")}
            icon={KeyRound}
            iconClassName="bg-zinc-950 text-white"
            onClick={() => setPanel("providers")}
          />
          <SettingsRow
            title={t(language, "settings.importExport")}
            subtitle={t(language, "settings.exportTitle")}
            value="JSON"
            icon={Database}
            iconClassName="bg-amber-600 text-white"
            onClick={() => setPanel("data")}
          />
        </SettingsGroup>
      </div>
    </div>
  );
}

function SettingsDetail({
  title,
  subtitle,
  backLabel,
  onBack,
  children,
}: {
  title: string;
  subtitle: string;
  backLabel: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-4xl">
      <button
        type="button"
        onClick={onBack}
        className="-ml-4 mb-4 inline-flex h-9 items-center gap-1 rounded-full px-1 pr-3 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-400/10"
      >
        <ChevronLeft size={20} />
        {backLabel}
      </button>
      <div className="pb-5">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500 dark:text-slate-400">{subtitle}</p>
      </div>
      <div>{children}</div>
    </div>
  );
}

function SettingsGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <section>
      {label ? <div className="mb-2 px-4 text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-slate-500">{label}</div> : null}
      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm shadow-zinc-950/[0.02] dark:border-white/10 dark:bg-white/[0.04]">
        <div className="divide-y divide-zinc-100 dark:divide-white/10">{children}</div>
      </div>
    </section>
  );
}

function SettingsRow({ title, subtitle, value, icon: Icon, iconClassName, selected, onClick, children }: SettingsRowProps) {
  const interactive = Boolean(onClick);
  const content = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {Icon ? (
          <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", iconClassName ?? "bg-zinc-100 text-zinc-600")}>
            <Icon size={18} />
          </span>
        ) : null}
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium text-zinc-950 dark:text-white">{title}</div>
          {subtitle ? <div className="mt-1 line-clamp-2 text-sm leading-5 text-zinc-500 dark:text-slate-400">{subtitle}</div> : null}
          {children}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {value ? <span className="max-w-32 truncate text-sm font-medium text-zinc-500 dark:text-slate-400">{value}</span> : null}
        {selected ? (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
            <Check size={16} />
          </span>
        ) : null}
        {interactive ? <ChevronRight size={18} className="text-zinc-300 dark:text-slate-600" /> : null}
      </div>
    </>
  );

  if (interactive) {
    return (
      <button type="button" onClick={onClick} className="flex min-h-[4.25rem] w-full items-center justify-between gap-4 px-4 py-3 text-left transition hover:bg-zinc-50 dark:hover:bg-white/[0.06]">
        {content}
      </button>
    );
  }

  return <div className="flex min-h-[4.25rem] items-center justify-between gap-4 px-4 py-3">{content}</div>;
}

function ThemeSettings({
  language,
  themeMode,
  onThemeModeChange,
}: {
  language: Language;
  themeMode: ThemeMode;
  onThemeModeChange: (themeMode: ThemeMode) => void;
}) {
  const options: Array<{ value: ThemeMode; icon: ComponentType<{ size?: number; className?: string }>; subtitleKey: string }> = [
    { value: "light", icon: Sun, subtitleKey: "settings.themeLightDesc" },
    { value: "dark", icon: Moon, subtitleKey: "settings.themeDarkDesc" },
    { value: "auto", icon: Timer, subtitleKey: "settings.themeAutoDesc" },
  ];

  return (
    <SettingsGroup label={t(language, "settings.theme")}>
      {options.map((option) => {
        const active = option.value === themeMode;
        const Icon = option.icon;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onThemeModeChange(option.value)}
            className="flex min-h-[4.25rem] w-full items-center justify-between gap-4 px-4 py-3 text-left transition hover:bg-zinc-50 dark:hover:bg-white/[0.06]"
            aria-pressed={active}
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-600 dark:bg-white/10 dark:text-slate-300">
                <Icon size={18} />
              </span>
              <div className="min-w-0">
                <div className="truncate text-[15px] font-medium text-zinc-950 dark:text-white">{t(language, themeLabelKey(option.value))}</div>
                <div className="mt-1 text-sm leading-5 text-zinc-500 dark:text-slate-400">{t(language, option.subtitleKey)}</div>
              </div>
            </div>
            {active ? (
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                <Check size={16} />
              </span>
            ) : null}
          </button>
        );
      })}
    </SettingsGroup>
  );
}

function MarketColorStyleSettings({
  language,
  marketColorStyle,
  onMarketColorStyleChange,
}: {
  language: Language;
  marketColorStyle: MarketColorStyle;
  onMarketColorStyleChange: (marketColorStyle: MarketColorStyle) => void;
}) {
  const options: MarketColorStyle[] = ["redUpGreenDown", "greenUpRedDown"];

  return (
    <SettingsGroup label={t(language, "settings.marketColorStyle")}>
      {options.map((option) => {
        const active = option === marketColorStyle;
        const preview = marketColorStylePreview(option);

        return (
          <button
            key={option}
            type="button"
            onClick={() => onMarketColorStyleChange(option)}
            className="flex min-h-[4.25rem] w-full items-center justify-between gap-4 px-4 py-3 text-left transition hover:bg-zinc-50 dark:hover:bg-white/[0.06]"
            aria-pressed={active}
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 grid-cols-2 overflow-hidden rounded-xl text-[11px] font-semibold text-white">
                <span className={`flex items-center justify-center ${preview.up}`}>{t(language, "settings.marketColorStyleUp")}</span>
                <span className={`flex items-center justify-center ${preview.down}`}>{t(language, "settings.marketColorStyleDown")}</span>
              </span>
              <div className="min-w-0">
                <div className="truncate text-[15px] font-medium text-zinc-950 dark:text-white">{t(language, marketColorStyleLabelKey(option))}</div>
                <div className="mt-1 line-clamp-2 text-sm leading-5 text-zinc-500 dark:text-slate-400">{t(language, marketColorStyleDescriptionKey(option))}</div>
              </div>
            </div>
            {active ? (
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                <Check size={16} />
              </span>
            ) : null}
          </button>
        );
      })}
    </SettingsGroup>
  );
}

function DefaultMarketSettings({
  language,
  activeMarket,
  onSelect,
}: {
  language: Language;
  activeMarket: MarketId;
  onSelect: (marketId: MarketId) => void;
}) {
  const copy = getMarketCopy(language, "us");

  return (
    <SettingsGroup label={t(language, "settings.defaultMarket")}>
      <SettingsChoiceRow
        title={copy.name}
        subtitle={copy.hint}
        value={MARKET_CONFIGS.us.currency}
        selected={activeMarket === "us"}
        onClick={() => onSelect("us")}
      />
    </SettingsGroup>
  );
}

function CurrencySettings({
  language,
  marketCurrency,
  accountCurrency,
  onSelect,
}: {
  language: Language;
  marketCurrency: string;
  accountCurrency: AccountCurrency;
  onSelect: (accountCurrency: AccountCurrency) => void;
}) {
  const options: Array<{ value: AccountCurrency; title: string; subtitle: string; detail: string }> = [
    { value: "market", title: t(language, "settings.currencyMarket"), subtitle: t(language, "settings.currencyMarketDesc"), detail: marketCurrency },
    { value: "USD", title: "USD $", subtitle: t(language, "settings.currencyUsdDesc"), detail: "USD" },
  ];

  return (
    <SettingsGroup label={t(language, "common.currency")}>
      {options.map((option) => (
        <SettingsChoiceRow
          key={option.value}
          title={option.title}
          subtitle={option.subtitle}
          value={option.detail}
          selected={option.value === accountCurrency}
          onClick={() => onSelect(option.value)}
        />
      ))}
    </SettingsGroup>
  );
}

function BenchmarkSettings({
  language,
  benchmarks,
  activeBenchmark,
  onSelect,
}: {
  language: Language;
  benchmarks: string[];
  activeBenchmark: string;
  onSelect: (benchmark: string) => void;
}) {
  return (
    <SettingsGroup label={t(language, "common.benchmark")}>
      {benchmarks.map((benchmark) => (
        <SettingsChoiceRow
          key={benchmark}
          title={benchmark}
          subtitle={t(language, "settings.benchmarkDesc")}
          selected={benchmark === activeBenchmark}
          onClick={() => onSelect(benchmark)}
        />
      ))}
    </SettingsGroup>
  );
}

function SettingsChoiceRow({
  title,
  subtitle,
  value,
  selected,
  onClick,
}: {
  title: string;
  subtitle?: string;
  value?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[4.25rem] w-full items-center justify-between gap-4 px-4 py-3 text-left transition hover:bg-zinc-50 dark:hover:bg-white/[0.06]"
      aria-pressed={selected}
    >
      <div className="min-w-0">
        <div className="truncate text-[15px] font-medium text-zinc-950 dark:text-white">{title}</div>
        {subtitle ? <div className="mt-1 line-clamp-2 text-sm leading-5 text-zinc-500 dark:text-slate-400">{subtitle}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {value ? <span className="max-w-32 truncate text-sm font-medium text-zinc-500 dark:text-slate-400">{value}</span> : null}
        {selected ? (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
            <Check size={16} />
          </span>
        ) : null}
      </div>
    </button>
  );
}

function themeLabelKey(themeMode: ThemeMode) {
  if (themeMode === "dark") return "settings.themeDark";
  if (themeMode === "auto") return "settings.themeAuto";
  return "settings.themeLight";
}

function marketColorStylePreview(style: MarketColorStyle) {
  if (style === "redUpGreenDown") {
    return { up: "bg-red-500", down: "bg-emerald-500" };
  }
  return { up: "bg-emerald-500", down: "bg-red-500" };
}

function detailSubtitle(panel: SettingsPanel, language: Language) {
  if (panel === "defaults") return t(language, "settings.description");
  if (panel === "defaultMarket") return t(language, "settings.defaultMarketDesc");
  if (panel === "currency") return t(language, "settings.currencyDesc");
  if (panel === "benchmark") return t(language, "settings.benchmarkDesc");
  if (panel === "language") return t(language, "language.cardDescription");
  if (panel === "theme") return t(language, "settings.themeDescription");
  if (panel === "marketStyle") return t(language, "settings.marketColorStyleDescription");
  if (panel === "providers") return t(language, "settings.providerAccountsDescription");
  if (panel === "data") return t(language, "settings.exportTitle");
  return t(language, "settings.description");
}
