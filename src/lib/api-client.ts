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
  let data: unknown;
  try {
    data = contentType.includes("application/json") ? await response.json() : await response.text();
  } catch {
    throw new Error(response.ok ? "FundX received an unreadable API response. Please retry." : httpErrorMessage(response, null));
  }

  if (!response.ok) {
    if (isApiErrorPayload(data)) {
      throw new FundXApiError(data, response.status);
    }
    throw new Error(httpErrorMessage(response, data));
  }

  if (!contentType.includes("application/json")) {
    throw new Error(unexpectedContentMessage(response, data));
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
    return safeErrorText(error.message) ?? "Unable to complete the request.";
  }
  if (error instanceof Error) return safeErrorText(error.message) ?? "Unable to complete the request.";
  return "Unable to complete the request.";
}

function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ApiErrorPayload>;
  return candidate.ok === false && typeof candidate.error === "string" && typeof candidate.message === "string";
}

function httpErrorMessage(response: Response, data: unknown) {
  const status = responseStatusLabel(response);
  const text = safeErrorText(data);
  if (text) return text;
  if (response.status >= 500) return `FundX service is temporarily unavailable (${status}). Please retry shortly.`;
  if (response.status === 404) return `FundX API endpoint was not found (${status}).`;
  if (response.status === 401) return `FundX API request needs authentication (${status}).`;
  if (response.status === 403) return `This session cannot access the requested FundX API resource (${status}).`;
  return `FundX API request failed (${status}).`;
}

function unexpectedContentMessage(response: Response, data: unknown) {
  const status = responseStatusLabel(response);
  const text = safeErrorText(data);
  if (text) return text;
  return `FundX received an unexpected API response (${status}). Please retry.`;
}

function safeErrorText(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || looksLikeHtml(text)) return null;
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

function looksLikeHtml(value: string) {
  return /<!doctype\s+html/i.test(value) || /<\/?(html|head|body|script|style|main|div|p|h[1-6])[\s>]/i.test(value);
}

function responseStatusLabel(response: Response) {
  const status = response.status ? `HTTP ${response.status}` : "network error";
  return response.statusText ? `${status} ${response.statusText}` : status;
}
