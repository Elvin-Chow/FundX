"use client";

import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { useMemo } from "react";
import { useBackendConnectionStatus, type BackendConnectionStatus as ConnectionStatus } from "@/hooks/use-backend-connection-status";
import type { Language } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function BackendConnectionStatus({ language }: { language: Language }) {
  const connection = useBackendConnectionStatus();
  const label = t(language, `backendStatus.${connection.status}`);
  const shortLabel = t(language, `backendStatusShort.${connection.status}`);
  const visual = statusVisuals[connection.status];
  const lastCheckedTime = useMemo(() => {
    if (!connection.lastCheckedAt) return null;
    return new Intl.DateTimeFormat(language === "en" ? "en-US" : language, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(connection.lastCheckedAt));
  }, [connection.lastCheckedAt, language]);
  const title = [
    label,
    connection.latencyMs === null ? null : t(language, "backendStatus.latency", { latency: connection.latencyMs }),
    lastCheckedTime ? t(language, "backendStatus.lastChecked", { time: lastCheckedTime }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const Icon = connection.status === "offline" ? CloudOff : connection.status === "checking" || connection.status === "waking" ? LoaderCircle : Cloud;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={title || label}
      title={title || label}
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded border px-2.5 text-xs font-medium transition sm:min-w-[8.75rem]",
        visual.container
      )}
    >
      <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
        {visual.pulse ? <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-70", visual.dot)} /> : null}
        <span className={cn("relative inline-flex size-2.5 rounded-full", visual.dot)} />
      </span>
      <Icon size={14} className={cn("shrink-0", visual.icon, visual.spin ? "animate-spin" : "")} aria-hidden="true" />
      <span className="min-w-0 truncate sm:hidden">{shortLabel}</span>
      <span className="hidden min-w-0 truncate sm:inline">{label}</span>
    </div>
  );
}

const statusVisuals: Record<
  ConnectionStatus,
  {
    container: string;
    dot: string;
    icon: string;
    pulse?: boolean;
    spin?: boolean;
  }
> = {
  checking: {
    container: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-200",
    dot: "bg-sky-500",
    icon: "text-sky-700 dark:text-sky-200",
    pulse: true,
    spin: true,
  },
  waking: {
    container: "border-gold/30 bg-gold/10 text-amber-800 dark:border-gold/35 dark:bg-gold/15 dark:text-amber-100",
    dot: "bg-gold",
    icon: "text-amber-700 dark:text-amber-100",
    pulse: true,
    spin: true,
  },
  online: {
    container: "border-money/25 bg-money/10 text-emerald-800 dark:border-money/35 dark:bg-money/15 dark:text-emerald-100",
    dot: "bg-money",
    icon: "text-emerald-700 dark:text-emerald-100",
  },
  degraded: {
    container: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-300/25 dark:bg-amber-300/10 dark:text-amber-100",
    dot: "bg-amber-500",
    icon: "text-amber-700 dark:text-amber-100",
  },
  offline: {
    container: "border-loss/20 bg-loss/10 text-red-800 dark:border-loss/30 dark:bg-loss/15 dark:text-red-100",
    dot: "bg-loss",
    icon: "text-red-700 dark:text-red-100",
  },
};
