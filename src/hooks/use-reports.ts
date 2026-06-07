"use client";

import { useCallback } from "react";
import type { ReportsResponse } from "@/lib/api-contracts";
import type { MarketId, ReportRecord } from "@/lib/types";
import { buildLocalReportsResponse, createLocalReport, localReportBlob } from "@/lib/local-user-data";
import { useApiResource } from "./use-api-resource";

export function useReports(marketId: MarketId) {
  const load = useCallback(
    (_signal: AbortSignal) => Promise.resolve(buildLocalReportsResponse(marketId) satisfies ReportsResponse),
    [marketId],
  );
  const resource = useApiResource(load, [load], { keepPreviousData: false });

  async function generateReport(type: ReportRecord["type"], params: Record<string, unknown> = {}) {
    createLocalReport(marketId, type, params);
    await resource.refresh("reload");
  }

  async function downloadReport(reportId: string, format: "csv" | "json" | "pdf") {
    const blob = localReportBlob(reportId, format);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `fundx-${reportId}.${format}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return { ...resource, generateReport, downloadReport };
}
