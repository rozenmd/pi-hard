import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { headers, signIn } from "./session";

const token = `sk-ant-oat01-${"u".repeat(64)}`;
const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-usage" }, exp: 9_999_999_999 }))}.signature`;

function claudeReply(extra: Record<string, string>) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_usage",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream", ...extra } },
  );
}

type UsageRequest = { token: string } | { model: string } | { content: string; requestId: string };

const call = (path: string, method = "GET", body?: UsageRequest) =>
  SELF.fetch(`https://worker/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

type Report = {
  providerId: string;
  connected: boolean;
  usage: {
    windows: { label: string; usedPercent: number; resetsAt: number | null }[];
    source: string;
  } | null;
  error?: string;
};

const usage = async (refresh = false) => {
  const response = await call(refresh ? "/usage?refresh=1" : "/usage");
  expect(response.status).toBe(200);
  const { providers } = await response.json<{ providers: Report[] }>();

  return Object.fromEntries(providers.map((report) => [report.providerId, report]));
};

beforeEach(async () => {
  await reset();
  await signIn();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.delete("credential:anthropic");
    await state.storage.delete("credential:openai-codex");
  });
});

afterEach(async () => {
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it("requires sign-in and reports nothing for providers that are not connected", async () => {
  expect((await SELF.fetch("https://worker/api/usage")).status).toBe(401);
  const fetch = vi.spyOn(globalThis, "fetch");
  const reports = await usage(true);
  expect(reports["anthropic"]).toEqual({ providerId: "anthropic", connected: false, usage: null });
  expect(reports["openai-codex"]).toMatchObject({ connected: false, usage: null });
  expect(fetch).not.toHaveBeenCalled();
});

it("records Claude limits from inference headers and keeps them when the usage endpoint refuses a setup token", async () => {
  await call("/auth/anthropic", "PUT", { token });
  const reset5h = Math.floor(Date.now() / 1000) + 4 * 3600;
  const reset7d = Math.floor(Date.now() / 1000) + 2 * 86400;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("/api/oauth/usage"))
      return Response.json({ error: { message: `scope missing for ${token}` } }, { status: 403 });

    return claudeReply({
      "anthropic-ratelimit-unified-5h-utilization": "0.01",
      "anthropic-ratelimit-unified-5h-reset": String(reset5h),
      "anthropic-ratelimit-unified-7d-utilization": "0.12",
      "anthropic-ratelimit-unified-7d-reset": String(reset7d),
    });
  });

  const session = await (
    await call("/sessions", "POST", { model: "claude-haiku-5-5" })
  ).json<{ id: string }>();

  await call(`/sessions/${session.id}/messages`, "POST", {
    content: "hi",
    requestId: crypto.randomUUID(),
  });

  await expect
    .poll(async () => (await usage())["anthropic"]?.usage?.windows.length, { timeout: 4000 })
    .toBe(2);

  const refreshed = (await usage(true))["anthropic"];
  expect(refreshed?.usage).toMatchObject({
    source: "headers",
    windows: [
      { label: "5h", usedPercent: 1, resetsAt: reset5h * 1000 },
      { label: "7d", usedPercent: 12, resetsAt: reset7d * 1000 },
    ],
  });
  expect(refreshed?.error).toBe("Anthropic usage returned HTTP 403");
  expect(JSON.stringify(refreshed)).not.toContain(token);

  await call("/auth/anthropic", "DELETE");
  expect((await usage())["anthropic"]).toMatchObject({ connected: false, usage: null });
});

it("reads live Claude usage including model-scoped weekly limits", async () => {
  await call("/auth/anthropic", "PUT", { token });

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(init?.headers).get("anthropic-beta")).toBe("oauth-2025-04-20");

    return Response.json({
      seven_day_fable: { utilization: 0, resets_at: "2030-01-03T00:00:00Z" },
      seven_day: { utilization: 12, resets_at: "2030-01-03T00:00:00Z" },
      five_hour: { utilization: 1, resets_at: "2030-01-01T04:00:00Z" },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    });
  });

  expect((await usage(true))["anthropic"]?.usage).toMatchObject({
    source: "live",
    windows: [
      { label: "5h", usedPercent: 1, resetsAt: Date.parse("2030-01-01T04:00:00Z") },
      { label: "7d", usedPercent: 12 },
      { label: "Fable", usedPercent: 0 },
    ],
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  // Without refresh the stored snapshot is served with no upstream request.
  expect((await usage())["anthropic"]?.usage?.source).toBe("live");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("reads ChatGPT usage with the account id from the access token, and clears it on sign-out", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai-codex", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });

  const now = Date.now();

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("acct-usage");

    return Response.json({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 34, limit_window_seconds: 18000, reset_after_seconds: 600 },
        secondary_window: {
          used_percent: 71.6,
          limit_window_seconds: 604800,
          reset_at: 2_000_000_000,
        },
      },
    });
  });

  const report = (await usage(true))["openai-codex"];
  expect(report?.usage?.windows).toMatchObject([
    { label: "5h", usedPercent: 34 },
    { label: "7d", usedPercent: 71.6, resetsAt: 2_000_000_000_000 },
  ]);
  expect(report?.usage?.windows[0]?.resetsAt).toBeGreaterThanOrEqual(now + 600_000);

  fetch.mockResolvedValueOnce(
    Response.json({
      rate_limit: { primary_window: { used_percent: "not-a-number" } },
    }),
  );
  expect((await usage(true))["openai-codex"]).toMatchObject({
    usage: report?.usage,
    error: expect.any(String),
  });

  await call("/auth/codex", "DELETE");
  expect((await usage())["openai-codex"]).toMatchObject({ connected: false, usage: null });
});
