import type { ApiErrorPayload } from "./api-contracts";

export type ApiParams = Record<string, boolean | number | string | null | undefined>;

const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;

export type ApiRequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  params?: ApiParams;
};

export class FundXApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields?: Record<string, string[] | undefined>;
  readonly details?: Record<string, unknown>;

  constructor(payload: ApiErrorPayload, fallbackStatus: number) {
    super(payload.message || "FundX API request failed.");
    this.name = "FundXApiError";
    this.code = payload.error;
    this.status = payload.status || fallbackStatus;
    this.fields = payload.fields;
    this.details = payload.details;
  }
}

export function buildApiUrl(path: string, params: ApiParams = {}) {
  const baseUrl = configuredApiBaseUrl || (typeof window === "undefined" ? "http://localhost" : window.location.origin);
  const url = new URL(path, baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") return;
    url.searchParams.set(key, String(value));
  });

  return configuredApiBaseUrl ? url.toString() : `${url.pathname}${url.search}`;
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { body, headers, params, ...init } = options;
  const response = await fetch(buildApiUrl(path, params), {
    cache: "no-store",
    ...init,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    if (isApiErrorPayload(data)) {
      throw new FundXApiError(data, response.status);
    }
    throw new Error(typeof data === "string" && data ? data : `FundX API request failed with ${response.status}.`);
  }

  return data as T;
}

export function apiGet<T>(path: string, params?: ApiParams, signal?: AbortSignal) {
  return apiFetch<T>(path, { method: "GET", params, signal });
}

export function apiPost<T>(path: string, body?: unknown, params?: ApiParams) {
  return apiFetch<T>(path, { method: "POST", body, params });
}

export function apiPatch<T>(path: string, body?: unknown, params?: ApiParams) {
  return apiFetch<T>(path, { method: "PATCH", body, params });
}

export function apiDelete<T>(path: string, params?: ApiParams) {
  return apiFetch<T>(path, { method: "DELETE", params });
}

export async function apiDownload(path: string, params?: ApiParams) {
  const response = await fetch(buildApiUrl(path, params), { cache: "no-store" });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    if (isApiErrorPayload(data)) throw new FundXApiError(data, response.status);
    throw new Error(`Download failed with ${response.status}.`);
  }
  return response.blob();
}

export function apiErrorMessage(error: unknown) {
  if (error instanceof FundXApiError) {
    if (error.code === "validation_error") return "Some fields need attention before saving.";
    if (error.code === "market_mismatch") return "The request market does not match the active market.";
    if (error.code === "market_forbidden") return "This market is not available for the current session.";
    if (error.code === "rate_limited") return "Too many requests. Please retry shortly.";
    if (error.code === "forbidden") return "This session is read-only.";
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Unable to complete the request.";
}

function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ApiErrorPayload>;
  return candidate.ok === false && typeof candidate.error === "string" && typeof candidate.message === "string";
}
