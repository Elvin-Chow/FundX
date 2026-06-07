"use client";

import { useCallback, useEffect, useState } from "react";
import type { JobsResponse } from "@/lib/api-contracts";
import type { BackgroundJob, MarketId } from "@/lib/types";
import { buildLocalJobsResponse, recordLocalJob } from "@/lib/local-user-data";
import { useApiResource } from "./use-api-resource";

export function useJobs(marketId?: MarketId) {
  const [polling, setPolling] = useState(false);
  const load = useCallback(
    (_signal: AbortSignal) => Promise.resolve(buildLocalJobsResponse(marketId) satisfies JobsResponse),
    [marketId],
  );
  const resource = useApiResource(load, [load], { keepPreviousData: true });

  async function runJob(type: BackgroundJob["type"]) {
    setPolling(true);
    const job = recordLocalJob(type, marketId, { source: "browser-local" });
    await resource.refresh("reload");
    return job;
  }

  useEffect(() => {
    if (!polling) return undefined;
    const timer = window.setInterval(async () => {
      const data = await resource.refresh("reload");
      const hasRunning = data?.jobs?.some((job) => job.status === "queued" || job.status === "running");
      if (!hasRunning) setPolling(false);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [polling, resource]);

  return { ...resource, jobs: resource.data?.jobs ?? [], polling, runJob };
}
