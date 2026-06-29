"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import type { BackendHealthResponse } from "@/lib/api-contracts";

export type BackendConnectionStatus = "checking" | "waking" | "online" | "degraded" | "offline";

export type BackendConnectionState = {
  status: BackendConnectionStatus;
  checking: boolean;
  latencyMs: number | null;
  lastCheckedAt: string | null;
};

const WAKE_NOTICE_AFTER_MS = 2_400;
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTED_CHECK_INTERVAL_MS = 30_000;
const RETRY_CHECK_INTERVAL_MS = 6_000;

export function useBackendConnectionStatus(): BackendConnectionState {
  const [state, setState] = useState<BackendConnectionState>({
    status: "checking",
    checking: true,
    latencyMs: null,
    lastCheckedAt: null,
  });

  useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;
    let nextCheckTimer = 0;
    let wakeNoticeTimer = 0;
    let requestTimeoutTimer = 0;

    function clearRequestTimers() {
      window.clearTimeout(wakeNoticeTimer);
      window.clearTimeout(requestTimeoutTimer);
    }

    function scheduleNextCheck(delayMs: number) {
      window.clearTimeout(nextCheckTimer);
      nextCheckTimer = window.setTimeout(checkBackend, delayMs);
    }

    async function checkBackend() {
      if (stopped) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        scheduleNextCheck(CONNECTED_CHECK_INTERVAL_MS);
        return;
      }

      const startedAt = typeof performance === "undefined" ? Date.now() : performance.now();
      controller = new AbortController();

      setState((current) => ({
        ...current,
        status: current.status === "online" || current.status === "degraded" ? current.status : "checking",
        checking: true,
      }));

      wakeNoticeTimer = window.setTimeout(() => {
        if (stopped || controller?.signal.aborted) return;
        setState((current) => ({
          ...current,
          status: "waking",
          checking: true,
        }));
      }, WAKE_NOTICE_AFTER_MS);

      requestTimeoutTimer = window.setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);

      try {
        const health = await apiGet<BackendHealthResponse>("/api/health", undefined, controller.signal);
        if (stopped) return;
        const endedAt = typeof performance === "undefined" ? Date.now() : performance.now();
        setState({
          status: health.status === "healthy" ? "online" : "degraded",
          checking: false,
          latencyMs: Math.max(0, Math.round(endedAt - startedAt)),
          lastCheckedAt: new Date().toISOString(),
        });
        scheduleNextCheck(CONNECTED_CHECK_INTERVAL_MS);
      } catch {
        if (stopped) return;
        setState((current) => ({
          ...current,
          status: "offline",
          checking: false,
          latencyMs: null,
          lastCheckedAt: new Date().toISOString(),
        }));
        scheduleNextCheck(RETRY_CHECK_INTERVAL_MS);
      } finally {
        clearRequestTimers();
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(nextCheckTimer);
      controller?.abort();
      void checkBackend();
    }

    void checkBackend();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopped = true;
      controller?.abort();
      window.clearTimeout(nextCheckTimer);
      clearRequestTimers();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return state;
}
