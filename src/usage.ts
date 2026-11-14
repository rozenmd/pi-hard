import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Credentials } from "./credentials";

/** One rolling subscription limit, e.g. Claude's 5-hour window or Codex's weekly window. */
export type UsageWindow = {
  /** Short label: 5h, 7d, Opus, … */
  label: string;
  /** 0–100. */
  usedPercent: number;
  /** Epoch milliseconds, when known. */
  resetsAt: number | null;
};

export type ProviderUsage = {
  providerId: "openai-codex" | "anthropic";
  windows: UsageWindow[];
  /** When these numbers were observed (live fetch or last inference response). */
  observedAt: number;
  source: "live" | "headers";
};

export type UsageReport = {
  providerId: ProviderUsage["providerId"];
  connected: boolean;
  usage: ProviderUsage | null;
  error?: string;
};

const PROVIDERS = ["openai-codex", "anthropic"] as const;
const key = (providerId: string) => `usage:${providerId}`;

const clamp = (value: number) => Math.min(100, Math.max(0, value));

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const numeric = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
};

/** Label a window by its length: 300 min → 5h, 10080 min → 7d. */
export function windowLabel(minutes: number | null, fallback: string) {
  if (!minutes || minutes <= 0) return fallback;

  if (minutes % 1440 === 0) return `${minutes / 1440}d`;

  if (minutes % 60 === 0) return `${minutes / 60}h`;

  return `${minutes}m`;
}

const anthropicLabel = (name: string) =>
  ({ "5h": "5h", "7d": "7d", five_hour: "5h", seven_day: "7d" })[name] ??
  name
    .replace(/^(7d|seven_day)_/, "")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());

/**
 * Claude subscription responses carry `anthropic-ratelimit-unified-<window>-utilization` (0–1)
 * and `…-<window>-reset` (epoch seconds) headers on every inference response.
 */
export function anthropicHeaderWindows(headers: Record<string, string>): UsageWindow[] {
  const windows: UsageWindow[] = [];

  for (const [name, value] of Object.entries(headers)) {
    const match = /^anthropic-ratelimit-unified-([a-z0-9_]+)-utilization$/i.exec(name);
    const utilization = numeric(value);

    if (!match?.[1] || utilization === null) continue;
    const reset = numeric(headers[`anthropic-ratelimit-unified-${match[1]}-reset`]);
    windows.push({
      label: anthropicLabel(match[1].toLowerCase()),
      usedPercent: clamp(utilization * 100),
      resetsAt: reset === null ? null : reset * 1000,
    });
  }

  return sortWindows(windows);
}

/** Codex responses carry `x-codex-{primary,secondary}-used-percent` and window/reset headers. */
export function codexHeaderWindows(headers: Record<string, string>, now: number): UsageWindow[] {
  const windows: UsageWindow[] = [];

  for (const slot of ["primary", "secondary"] as const) {
    const used = numeric(headers[`x-codex-${slot}-used-percent`]);

    if (used === null) continue;
    const minutes = numeric(headers[`x-codex-${slot}-window-minutes`]);
    const resetAt = numeric(headers[`x-codex-${slot}-reset-at`]);
    const resetAfter = numeric(headers[`x-codex-${slot}-reset-after-seconds`]);
    windows.push({
      label: windowLabel(minutes, slot === "primary" ? "5h" : "7d"),
      usedPercent: clamp(used),
      resetsAt:
        resetAt !== null ? resetAt * 1000 : resetAfter !== null ? now + resetAfter * 1000 : null,
    });
  }

  return windows;
}

/** GET api.anthropic.com/api/oauth/usage: `{ five_hour: { utilization: 0–100, resets_at } , … }`. */
export function anthropicUsageWindows(body: unknown): UsageWindow[] {
  if (!body || typeof body !== "object") return [];
  const windows: UsageWindow[] = [];

  for (const [name, value] of Object.entries(body)) {
    if (!value || typeof value !== "object") continue;
    const utilization = finite((value as { utilization?: unknown }).utilization);

    if (utilization === null) continue;
    const resets = (value as { resets_at?: unknown }).resets_at;
    const resetsAt = typeof resets === "string" ? Date.parse(resets) : NaN;
    windows.push({
      label: anthropicLabel(name),
      usedPercent: clamp(utilization),
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    });
  }

  return sortWindows(windows);
}

type CodexWindow = {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_after_seconds?: unknown;
  reset_at?: unknown;
};

/** GET chatgpt.com/backend-api/wham/usage: `{ rate_limit: { primary_window, secondary_window } }`. */
export function codexUsageWindows(body: unknown, now: number): UsageWindow[] {
  const limit = (body as { rate_limit?: Record<string, CodexWindow | null> } | null)?.rate_limit;

  if (!limit || typeof limit !== "object") return [];
  const windows: UsageWindow[] = [];

  for (const slot of ["primary_window", "secondary_window"] as const) {
    const window = limit[slot];
    const used = finite(window?.used_percent);

    if (!window || used === null) continue;
    const seconds = finite(window.limit_window_seconds);
    const resetAt = finite(window.reset_at);
    const resetAfter = finite(window.reset_after_seconds);
    windows.push({
      label: windowLabel(
        seconds === null ? null : Math.round(seconds / 60),
        slot === "primary_window" ? "5h" : "7d",
      ),
      usedPercent: clamp(used),
      resetsAt:
        resetAt !== null ? resetAt * 1000 : resetAfter !== null ? now + resetAfter * 1000 : null,
    });
  }

  return windows;
}

/** Shortest windows first, so 5h precedes 7d and model-specific weekly limits come last. */
function sortWindows(windows: UsageWindow[]) {
  const rank = (label: string) => (label === "5h" ? 0 : label === "7d" ? 1 : 2);

  return windows.sort((a, b) => rank(a.label) - rank(b.label));
}

/** The ChatGPT account id lives in the access token's `https://api.openai.com/auth` claim. */
export function chatgptAccountId(accessToken: string): string | null {
  try {
    const payload = accessToken.split(".")[1];

    if (!payload) return null;

    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<
      string,
      unknown
    >;

    const auth = json["https://api.openai.com/auth"] as
      | { chatgpt_account_id?: unknown }
      | undefined;

    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null;
  } catch {
    return null;
  }
}

/** Remember limits reported on a real inference response; costs no extra requests. */
export async function recordUsageHeaders(
  storage: DurableObjectStorage,
  providerId: string,
  headers: Record<string, string>,
  now = Date.now(),
) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

  const windows =
    providerId === "anthropic"
      ? anthropicHeaderWindows(lower)
      : providerId === "openai-codex"
        ? codexHeaderWindows(lower, now)
        : [];

  if (windows.length === 0) return;

  const usage: ProviderUsage = {
    providerId: providerId as ProviderUsage["providerId"],
    windows,
    observedAt: now,
    source: "headers",
  };

  await storage.put(key(providerId), usage);
}

async function fetchLive(
  providerId: ProviderUsage["providerId"],
  token: string,
  now: number,
): Promise<UsageWindow[]> {
  const signal = AbortSignal.timeout(10_000);

  if (providerId === "anthropic") {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      redirect: "manual",
      signal,
    });

    if (!response.ok) throw new Error(`Anthropic usage returned HTTP ${response.status}`);

    return anthropicUsageWindows(await response.json());
  }

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const account = chatgptAccountId(token);

  if (account) headers["chatgpt-account-id"] = account;

  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers,
    redirect: "manual",
    signal,
  });

  if (!response.ok) throw new Error(`ChatGPT usage returned HTTP ${response.status}`);

  return codexUsageWindows(await response.json(), now);
}

/**
 * Current subscription limits per provider. With `refresh`, query each provider's usage
 * endpoint; otherwise (or when that fails, e.g. a setup token without the profile scope)
 * report the limits last seen on an inference response.
 */
export async function usageReport(
  credentials: Credentials,
  { refresh }: { refresh: boolean },
): Promise<UsageReport[]> {
  const reports: UsageReport[] = [];

  for (const providerId of PROVIDERS) {
    const credential = Option.getOrUndefined(await Effect.runPromise(credentials.get(providerId)));

    if (!credential) {
      reports.push({ providerId, connected: false, usage: null });
      continue;
    }

    const stored = (await credentials.storage.get<ProviderUsage>(key(providerId))) ?? null;
    const now = Date.now();

    const token =
      credential.type === "oauth"
        ? credential.expires > now
          ? credential.access
          : null
        : (credential.key ?? null);

    if (!refresh || !token) {
      reports.push({ providerId, connected: true, usage: stored });
      continue;
    }

    try {
      const windows = await fetchLive(providerId, token, now);

      if (windows.length === 0) throw new Error("No usage limits reported");
      const usage: ProviderUsage = { providerId, windows, observedAt: now, source: "live" };
      await credentials.storage.put(key(providerId), usage);
      reports.push({ providerId, connected: true, usage });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Usage request failed";
      reports.push({
        providerId,
        connected: true,
        usage: stored,
        error: message.replaceAll(token, "[redacted]").slice(0, 256),
      });
    }
  }

  return reports;
}

export async function forgetUsage(storage: DurableObjectStorage, providerId: string) {
  await storage.delete(key(providerId));
}

type Observable<O> = (model: never, context: never, options?: O) => unknown;

/** Wrap a Pi stream function so every provider response reports its limit headers. */
export function observeUsage<
  F extends Observable<{
    onResponse?: (response: { headers: Record<string, string> }, model: never) => unknown;
  }>,
>(fn: F, onHeaders: (headers: Record<string, string>) => void): F {
  return ((model: never, context: never, options?: Parameters<F>[2]) =>
    fn(model, context, {
      ...options,
      onResponse: async (response: { headers: Record<string, string> }, m: never) => {
        try {
          onHeaders(response.headers);
        } catch {
          // Usage is informational; never fail inference because of it.
        }

        await options?.onResponse?.(response, m);
      },
    })) as F;
}
