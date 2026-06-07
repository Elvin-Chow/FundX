import type { ReactNode } from "react";
import { Loader2, X } from "lucide-react";
import type { CalculationWarning } from "@/lib/api-contracts";
import type { AssetRecord } from "@/lib/types";
import { assetDisplayName, assetPrimaryCategory, quoteStatusLabel } from "@/lib/asset-display";
import { t, type Language } from "@/lib/i18n";
import { StatusBanner } from "./feature-shell";

export function WorkbenchLayout({
  pool,
  controls,
  results,
  actions,
  align = "stretch",
}: {
  pool: ReactNode;
  controls: ReactNode;
  results?: ReactNode;
  actions?: ReactNode;
  align?: "stretch" | "start";
}) {
  return (
    <div className="space-y-5">
      <div className={`grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(24rem,1.05fr)] ${align === "start" ? "items-start" : "items-stretch"}`}>
        <div className="min-w-0">{pool}</div>
        <div className="min-w-0">{controls}</div>
      </div>
      {results ? <div className="min-w-0">{results}</div> : null}
      {actions ? <div className="sticky bottom-20 z-20 rounded-lg border border-zinc-200 bg-white/95 p-3 shadow-soft backdrop-blur dark:border-white/10 dark:bg-[#050706]/92 lg:bottom-4">{actions}</div> : null}
    </div>
  );
}

export function WorkbenchPanel({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.03] ${className ?? ""}`}>
      <div className="mb-4 flex min-h-10 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight text-zinc-950 dark:text-white">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function CalculationStatus({
  running,
  error,
  warnings,
  idle,
  success,
  runningLabel,
  warningsLabel,
}: {
  running: boolean;
  error?: string | null;
  warnings?: CalculationWarning[];
  idle: string;
  success?: string;
  runningLabel?: string;
  warningsLabel?: string;
}) {
  if (error) return <StatusBanner title={error} tone="negative" />;
  if (running) return <StatusBanner title={runningLabel ?? "Calculating with latest market data..."} tone="neutral" />;
  if (warnings?.length) return <StatusBanner title={success ?? warningsLabel ?? "Calculation completed with warnings."} body={warnings.map((item) => item.message).join(" ")} tone="neutral" />;
  return <StatusBanner title={success ?? idle} tone={success ? "positive" : "neutral"} />;
}

export function CalculateButton({
  disabled,
  running,
  children,
  onClick,
}: {
  disabled?: boolean;
  running?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || running}
      className="inline-flex h-10 min-w-32 items-center justify-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
    >
      {running ? <Loader2 size={16} className="animate-spin" /> : null}
      {children}
    </button>
  );
}

export function SecondaryButton({
  disabled,
  children,
  onClick,
}: {
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-10 items-center justify-center rounded border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-300 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-200 dark:hover:bg-white/10"
    >
      {children}
    </button>
  );
}

export function SelectedAssetList({
  assets,
  language,
  emptyLabel,
  onRemove,
}: {
  assets: AssetRecord[];
  language: Language;
  emptyLabel: string;
  onRemove: (assetId: string) => void;
}) {
  if (!assets.length) {
    return <div className="rounded-lg border border-dashed border-zinc-200 p-5 text-sm text-zinc-500 dark:border-white/10 dark:text-zinc-400">{emptyLabel}</div>;
  }

  return (
    <div className="space-y-2">
      {assets.map((asset) => (
        <div key={asset.id} className="flex min-h-14 items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-white/10">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{assetDisplayName(asset, language)}</div>
            <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
              {[asset.symbol, assetPrimaryCategory(asset, language), quoteStatusLabel(asset, language)].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onRemove(asset.id)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-zinc-400 transition hover:bg-zinc-50 hover:text-zinc-950 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label={`${t(language, "common.remove")} ${asset.symbol}`}
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function FieldLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

export const inputClassName = "h-10 w-full rounded border border-zinc-200 bg-white px-3 text-sm text-zinc-950 outline-none transition focus:border-emerald-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-white";
