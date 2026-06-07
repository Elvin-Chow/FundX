import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { t, type Language } from "@/lib/i18n";
import { marketToneTextClass } from "@/lib/market-color-style";
import { useMarketStore } from "@/stores/market-store";
import type { AssetRow, Insight, Metric } from "../../components/types";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  showDivider = true,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  showDivider?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between ${showDivider ? "border-b border-zinc-200 pb-6 dark:border-white/10" : "pb-5"}`}>
      <div className="max-w-2xl">
        {eyebrow ? <div className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">{eyebrow}</div> : null}
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-white sm:text-4xl">{title}</h1>
        {description ? <p className="mt-3 text-sm leading-6 text-zinc-500 dark:text-zinc-400 sm:text-base">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Section({
  title,
  subtitle,
  children,
  action,
  flushTop = false,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
  flushTop?: boolean;
}) {
  return (
    <section className={`min-w-0 ${flushTop ? "pb-6" : "py-6"}`}>
      {title ? (
        <div className="mb-4 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-zinc-950 dark:text-white">{title}</h2>
            {subtitle ? <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function MetricStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {metrics.map((metric) => (
        <div key={metric.label} className="min-w-0 rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="truncate text-sm text-zinc-500 dark:text-zinc-400">{metric.label}</div>
          <div className="mt-2 truncate text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">{metric.value}</div>
          {metric.delta ? <ToneText tone={metric.tone} marketTone>{metric.delta}</ToneText> : null}
        </div>
      ))}
    </div>
  );
}

export function AssetList({ assets }: { assets: AssetRow[] }) {
  return (
    <div className="w-full max-w-full overflow-hidden divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.03]">
      {assets.map((asset) => {
        const rowClass = "flex min-w-0 flex-col gap-3 p-4 transition hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950/20 dark:hover:bg-white/[0.06] dark:focus-visible:ring-white/30 sm:flex-row sm:items-center sm:justify-between";
        const rowContent = (
          <>
          <div className="flex min-w-0 flex-1 items-center gap-3 self-stretch">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-xs font-semibold text-white">
              {asset.symbol.slice(0, 2)}
            </div>
            <div className="min-w-0">
              <div className="truncate font-medium text-zinc-950 dark:text-white">{asset.name}</div>
              <div className="truncate text-sm text-zinc-500 dark:text-zinc-400">{asset.subtitle ?? asset.symbol}</div>
            </div>
          </div>
          <div className="min-w-0 max-w-full shrink-0 text-left sm:max-w-36 sm:text-right">
            {asset.value ? <div className="font-medium text-zinc-950 dark:text-white">{asset.value}</div> : null}
            {asset.delta ? <ToneText tone={asset.tone} marketTone>{asset.delta}</ToneText> : asset.allocation ? <div className="text-sm text-zinc-500 dark:text-zinc-400">{asset.allocation}</div> : null}
          </div>
          </>
        );
        return asset.href ? (
          <Link key={asset.id} to={asset.href} state={asset.linkState} className={rowClass}>
            {rowContent}
          </Link>
        ) : (
          <div key={asset.id} className={rowClass}>
            {rowContent}
          </div>
        );
      })}
    </div>
  );
}

export function InsightCard({ insight, language = "en" }: { insight: Insight; language?: Language }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-950 p-5 text-white">
      <div className="text-xs font-medium uppercase tracking-wide text-emerald-400">{t(language, "nav.insights")}</div>
      <h3 className="mt-3 text-xl font-semibold tracking-tight">{insight.title}</h3>
      <p className="mt-2 text-sm leading-6 text-zinc-300">{insight.body}</p>
      {insight.actionLabel ? (
        <button type="button" className="mt-5 rounded-full bg-white px-4 py-2 text-sm font-medium text-zinc-950">
          {insight.actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function ToneText({ tone = "neutral", children, marketTone = false }: { tone?: Metric["tone"]; children: ReactNode; marketTone?: boolean }) {
  const marketColorStyle = useMarketStore((state) => state.marketColorStyle);
  const toneClass = marketTone
    ? marketToneTextClass(tone, marketColorStyle)
    : tone === "positive"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "negative"
        ? "text-red-500 dark:text-red-400"
        : "text-zinc-500 dark:text-zinc-400";
  return <div className={`mt-1 text-sm font-medium ${toneClass}`}>{children}</div>;
}

export function StatusBanner({
  title,
  body,
  tone = "neutral",
  action,
}: {
  title: string;
  body?: string;
  tone?: "positive" | "negative" | "neutral";
  action?: ReactNode;
}) {
  const toneClass = tone === "negative"
    ? "border-red-200 bg-red-50 text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-300"
    : tone === "positive"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300"
      : "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300";

  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${toneClass}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="font-medium">{title}</div>
          {body ? <div className="mt-1 text-current/80">{body}</div> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.03]">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="grid gap-3 p-4 md:grid-cols-[1fr_8rem_7rem] md:items-center">
          <div>
            <div className="h-4 w-40 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
            <div className="mt-2 h-3 w-24 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
          </div>
          <div className="h-10 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
          <div className="h-9 animate-pulse rounded bg-zinc-100 dark:bg-white/10" />
        </div>
      ))}
    </div>
  );
}
