"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CustomSelect } from "@/components/custom-select";
import { useCustomFunds } from "@/hooks/use-custom-funds";
import { useDca } from "@/hooks/use-dca";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useReports } from "@/hooks/use-reports";
import { useWatchlist } from "@/hooks/use-watchlist";
import type { SettingsExportPayload, SettingsImportMode, SettingsImportResponse } from "@/lib/api-contracts";
import { t, type Language } from "@/lib/i18n";
import { exportLocalSettings, importLocalSettings } from "@/lib/local-user-data";
import type { MarketId } from "@/lib/types";

type ImportExportPanelProps = {
  marketId: MarketId;
  language: Language;
};

export function ImportExportPanel({ marketId, language }: ImportExportPanelProps) {
  const portfolio = usePortfolio(marketId);
  const watchlist = useWatchlist(marketId);
  const dca = useDca(marketId);
  const customFunds = useCustomFunds(marketId);
  const reports = useReports(marketId);
  const [exportPayload, setExportPayload] = useState<SettingsExportPayload | null>(null);
  const exportJson = useMemo(() => exportPayload ? JSON.stringify(exportPayload, null, 2) : "", [exportPayload]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState(t(language, "settings.exportReady"));
  const [exportLoading, setExportLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<SettingsImportMode>("merge");
  const loading = portfolio.loading || watchlist.loading || dca.loading || customFunds.loading || reports.loading || exportLoading || importing;

  const refreshExport = useCallback(async (options: { quiet?: boolean } = {}) => {
    setExportLoading(true);
    try {
      const payload = exportLocalSettings(marketId);
      setExportPayload(payload);
      if (!options.quiet) setStatus(t(language, "settings.exportReady"));
      return payload;
    } catch (error) {
      if (!options.quiet) setStatus(error instanceof Error ? error.message : t(language, "settings.importInvalidJson"));
      return null;
    } finally {
      setExportLoading(false);
    }
  }, [language, marketId]);

  useEffect(() => {
    void refreshExport();
  }, [refreshExport]);

  useEffect(() => {
    if (exportJson) setDraft(exportJson);
  }, [exportJson]);

  useEffect(() => {
    setStatus(t(language, "settings.exportReady"));
  }, [language]);

  function validateImport() {
    try {
      const parsed = JSON.parse(draft) as Partial<SettingsExportPayload>;
      if (parsed.marketId !== marketId) {
        setStatus(t(language, "settings.importMarketBlocked"));
        return;
      }
      const counts = {
        portfolios: parsed.portfolios?.length ?? 0,
        customFunds: parsed.customFunds?.length ?? 0,
        dcaPlans: parsed.dcaPlans?.length ?? 0,
        watchlist: parsed.watchlist?.length ?? 0,
      };
      setStatus(t(language, "settings.importValidated", { market: marketId.toUpperCase(), portfolios: counts.portfolios, customFunds: counts.customFunds, dcaPlans: counts.dcaPlans, watchlist: counts.watchlist }));
    } catch {
      setStatus(t(language, "settings.importInvalidJson"));
    }
  }

  function resetDraft() {
    if (!exportPayload) {
      void refreshExport();
      return;
    }
    setDraft(exportJson);
    setStatus(t(language, "settings.exportRestored"));
  }

  async function importJson() {
    let parsed: SettingsExportPayload;
    try {
      parsed = JSON.parse(draft) as SettingsExportPayload;
    } catch {
      setStatus(t(language, "settings.importInvalidJson"));
      return;
    }
    if (parsed.marketId !== marketId) {
      setStatus(t(language, "settings.importMarketBlocked"));
      return;
    }

    setImporting(true);
    setStatus(t(language, "settings.importing"));
    try {
      const result: SettingsImportResponse = importLocalSettings(marketId, parsed, importMode);
      await Promise.all([
        portfolio.refresh("reload"),
        watchlist.refresh("reload"),
        dca.refresh("reload"),
        customFunds.refresh("reload"),
        reports.refresh("reload"),
        refreshExport({ quiet: true }),
      ]);
      setStatus(t(language, "settings.importCompleted", {
        mode: t(language, importMode === "merge" ? "settings.merge" : "settings.replace"),
        portfolios: result.imported.portfolios,
        customFunds: result.imported.customFunds,
        dcaPlans: result.imported.dcaPlans,
        watchlist: result.imported.watchlist,
        reports: result.imported.reports,
      }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t(language, "settings.importInvalidJson"));
    } finally {
      setImporting(false);
    }
  }

  function downloadJson() {
    const blob = new Blob([draft], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `fundx-${marketId}-configuration.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setStatus(t(language, "settings.jsonDownloaded"));
  }

  return (
    <div className="border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">{t(language, "settings.dataPortability")}</div>
          <h3 className="mt-2 text-xl font-semibold tracking-tight text-zinc-950 dark:text-white">{t(language, "settings.exportTitle")}</h3>
          <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{loading ? t(language, "settings.loadingApiResources") : status}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={resetDraft} className="h-10 rounded border border-zinc-200 px-4 text-sm font-medium text-zinc-950 hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/10">
            {t(language, "common.reset")}
          </button>
          <button type="button" onClick={validateImport} className="h-10 rounded border border-zinc-200 px-4 text-sm font-medium text-zinc-950 hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/10">
            {t(language, "settings.validate")}
          </button>
          <CustomSelect
            ariaLabel="Import mode"
            className="w-32"
            value={importMode}
            options={[
              { value: "merge", label: t(language, "settings.merge") },
              { value: "replace", label: t(language, "settings.replace") },
            ]}
            onChange={setImportMode}
          />
          <button type="button" onClick={importJson} disabled={importing} className="h-10 rounded bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60">
            {t(language, "settings.import")}
          </button>
          <button type="button" onClick={downloadJson} className="h-10 rounded bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200">
            {t(language, "common.download")}
          </button>
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        className="mt-4 h-64 w-full resize-y rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-5 text-zinc-700 outline-none focus:border-emerald-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-200"
      />
    </div>
  );
}
