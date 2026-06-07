export type ReturnToNavigationState = {
  returnTo?: string;
};

export function createReturnToState(returnTo: string): ReturnToNavigationState {
  return { returnTo };
}

export function locationToReturnTo(location: { pathname: string; search: string; hash: string }) {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function readReturnToState(state: unknown, fallback: string) {
  if (!state || typeof state !== "object") return fallback;
  const returnTo = (state as ReturnToNavigationState).returnTo;
  return isSafeLocalPath(returnTo) ? returnTo : fallback;
}

function isSafeLocalPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}
