import { createPrivateKey } from "node:crypto";
import api from "../src/index";
import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { GITHUB_APP_READ_PERMISSIONS } from "../src/github-permissions";
import { GitHubRequest } from "../src/github-contracts";
import { GitHub } from "../src/github";
import { storeImages } from "../src/images";
import * as Effect from "effect/Effect";
import { headers, signIn } from "./session";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SavedSession } from "../src/session-contracts";

const repository = "example/project";
const sha = "a".repeat(40);

const setup = {
  owner: "example",
  ownerType: "organization",
  ingress: "https://ingress.example/hooks/github",
  repositories: [repository],
};

const keys = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);

if (!("privateKey" in keys)) throw new Error("Expected an RSA key pair");

const exported = await crypto.subtle.exportKey("pkcs8", keys.privateKey);

if (!(exported instanceof ArrayBuffer)) throw new Error("Expected PKCS8 bytes");

const der = new Uint8Array(exported);
const pkcs8 = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
const pem = createPrivateKey(pkcs8).export({ type: "pkcs1", format: "pem" }).toString();

const app = {
  id: 42,
  slug: "dolly-test",
  pem,
  client_id: "client-id",
  client_secret: "private-client-secret",
  webhook_secret: "private-webhook-secret-at-least-32-characters",
  owner: { login: "example" },
};

async function post<A>(path: string, body: A) {
  return SELF.fetch(`https://worker${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** The setup callback redirects back to the app; this returns where it sent the browser. */
async function callback(query: string) {
  const response = await SELF.fetch(`https://worker/api/setup/github/callback?${query}`, {
    redirect: "manual",
  });

  return response.status === 303
    ? decodeURIComponent(response.headers.get("Location") ?? "")
    : await response.text();
}

async function start() {
  const response = await post("/api/integrations/github/setup", setup);
  const result = await response.json<{ setupUrl: string }>();

  return { url: result.setupUrl, state: result.setupUrl.split("/").at(-1) };
}

async function connect() {
  const started = await start();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(app));

  expect(await callback(`state=${started.state}&code=manifest-code`)).toBe("/");
  vi.restoreAllMocks();
  await SELF.fetch("https://worker/api/integrations/github/accounts", {
    method: "PUT",
    headers,
    body: JSON.stringify({ accounts: ["example", "another-owner", "third-owner", "other"] }),
  });

  return started;
}

async function execute(operation: typeof GitHubRequest.Type.operation) {
  return post("/api/integrations/github/execute", { operation });
}

it("persists session PR creation without a transcript and retains it after failure and restart", async () => {
  await connect();
  let fail = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;

    if (path.endsWith("/installation")) return Response.json({ id: 7 });

    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: "private-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

    if (path.endsWith("/pulls"))
      return fail
        ? Response.json({ message: "Unavailable" }, { status: 503 })
        : Response.json({ number: 8, html_url: "https://github.com/example/project/pull/8" });

    if (path.endsWith("/pulls/8"))
      return Response.json({ state: "open", draft: false, merged: false });

    if (path === "/repos/example/project") return Response.json({ default_branch: "main" });
    throw new Error(`Unexpected GitHub path ${path}`);
  });

  const id = await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const conversation = await agent["harness"].createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );

    const request = {
      operation: {
        action: "open_pull_request" as const,
        repository,
        branch: "dolly/fix",
        base: "main",
        title: "Fix",
        body: "Details",
      },
    };

    fail = true;
    expect(await agent["githubForSession"](conversation.id, request)).toMatchObject({ ok: false });
    expect(await state.storage.get(`session-created-pr:${conversation.id}`)).toBeUndefined();
    fail = false;
    expect(await agent["githubForSession"](conversation.id, request)).toMatchObject({ ok: true });
    fail = true;
    expect(await agent["githubForSession"](conversation.id, request)).toMatchObject({ ok: false });

    return String(conversation.id);
  });

  const expected = {
    repository,
    number: 8,
    url: "https://github.com/example/project/pull/8",
    state: "open",
  };

  const sessions = () => env.AGENT.getByName("owner").sessions();
  expect(
    (await sessions()).find((session: SavedSession) => session.id === id)?.pullRequest,
  ).toEqual(expected);
  await abortAllDurableObjects();
  expect(
    (await sessions()).find((session: SavedSession) => session.id === id)?.pullRequest,
  ).toEqual(expected);
});

const publicFile = {
  type: "file",
  path: "src/main.ts",
  sha,
  encoding: "base64",
  content: btoa("public code"),
  size: 11,
};

const readPublic = async (target = "tellahq/opensession") =>
  (
    await execute({
      action: "read_file",
      repository: target,
      path: "src/main.ts",
      ref: "feature/read",
    })
  ).json();

// Fake GitHub for public reads through the App. `visibility` maps repositories to
// their privacy; `contents` overrides the contents response status.
function publicGitHub(options: {
  visibility?: Record<string, boolean>;
  contents?: number;
  installations?: { id: number }[];
}) {
  const minted: unknown[] = [];

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("Authorization");

    if (url.pathname === "/app/installations")
      return Response.json(options.installations ?? [{ id: 7 }]);

    if (url.pathname === "/app/installations/7/access_tokens") {
      minted.push(JSON.parse(String(init?.body)));

      return Response.json({ token: "public-token", expires_at: "2099-01-01T00:00:00Z" });
    }

    const repo = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname)?.[1];

    if (repo) {
      expect(auth).toBe("Bearer public-token");
      const isPrivate = options.visibility?.[repo];

      return isPrivate === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json({ private: isPrivate });
    }

    if (url.pathname.includes("/contents/")) {
      if (options.contents) return Response.json({ message: "x" }, { status: options.contents });

      return Response.json(publicFile);
    }

    throw new Error(`Unexpected ${url}`);
  });

  return { fetch, minted };
}

it("reads public files anonymously when no App is connected", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe(
      "https://api.github.com/repos/tellahq/opensession/contents/src/main.ts?ref=feature%2Fread",
    );
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);

    return Response.json(publicFile);
  });

  expect(await readPublic()).toEqual({
    ok: true,
    result: { kind: "file", path: "src/main.ts", sha, content: "public code" },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(["unapproved owner", "empty policy"])(
  "reads public files through a metadata-only App token with %s",
  async (mode) => {
    await connect();

    if (mode === "empty policy") await setAccounts([]);
    const { fetch, minted } = publicGitHub({ visibility: { "tellahq/opensession": false } });

    expect(await readPublic()).toEqual({
      ok: true,
      result: { kind: "file", path: "src/main.ts", sha, content: "public code" },
    });
    expect(minted).toEqual([{ permissions: { metadata: "read" } }]);
    const contents = fetch.mock.calls.find(([input]) => String(input).includes("/contents/"));

    expect(new Headers(contents?.[1]?.headers).get("Authorization")).toBe("Bearer public-token");

    // Token and visibility are cached: a second read is a single request.
    fetch.mockClear();
    expect(await readPublic()).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("refuses private repositories for unapproved owners even when the App can see them", async () => {
  await connect();
  const { fetch } = publicGitHub({ visibility: { "tellahq/opensession": true } });

  expect(await readPublic()).toMatchObject({ ok: false, message: "Provider returned HTTP 404" });
  expect(fetch.mock.calls.some(([input]) => String(input).includes("/contents/"))).toBe(false);
});

it("falls back to anonymous reads when the App has no installations", async () => {
  await connect();
  const { fetch } = publicGitHub({ installations: [] });

  expect(await readPublic()).toMatchObject({ ok: true });
  const contents = fetch.mock.calls.find(([input]) => String(input).includes("/contents/"));

  expect(new Headers(contents?.[1]?.headers).has("Authorization")).toBe(false);
});

it.each([403, 429, 500])(
  "preserves public-read HTTP %i even for approved owners",
  async (status) => {
    await connect();
    const { fetch } = publicGitHub({ visibility: { [repository]: false }, contents: status });

    expect(await readPublic(repository)).toMatchObject({
      ok: false,
      message: `Provider returned HTTP ${status}`,
    });
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes(`/repos/${repository}/installation`),
      ),
    ).toBe(false);
  },
);

it("keeps the file size limit for anonymous public reads", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      type: "file",
      path: "README.md",
      sha,
      encoding: "base64",
      content: btoa("x".repeat(32_769)),
      size: 32_769,
    }),
  );

  expect(
    await (
      await execute({ action: "read_file", repository, path: "README.md", ref: "main" })
    ).json(),
  ).toMatchObject({ ok: false, code: "file_too_large" });
});

it("explains an unset account policy without contacting GitHub or granting any accounts", async () => {
  await connect();
  await setAccounts([]);

  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("GitHub must not be contacted"));

  const response = await (await execute({ action: "repositories" })).json();
  expect(response).toMatchObject({ ok: false, code: "accounts_unconfigured" });
  expect(JSON.stringify(response)).toContain("Accounts dolly can work in");
  expect(fetch).not.toHaveBeenCalled();
  expect(
    await (await SELF.fetch("https://worker/api/integrations/github/accounts", { headers })).json(),
  ).toEqual({ accounts: [] });
});

it("does not treat empty installation discovery as an access denial for a known repository", async () => {
  await connect();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;

    if (path === "/app/installations") return Response.json([]);

    if (path === `/repos/${repository}/installation`) return Response.json({ id: 7 });

    if (path === "/app/installations/7/access_tokens")
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });

    if (path === `/repos/${repository}/contents/README.md`)
      return Response.json({
        type: "file",
        path: "README.md",
        sha,
        encoding: "base64",
        content: btoa("Repository is readable"),
        size: 22,
      });
    throw new Error(`Unexpected GitHub request: ${path}`);
  });
  const discovered = await (await execute({ action: "repositories" })).json();
  expect(discovered).toMatchObject({ ok: false, code: "no_repositories_discovered" });
  expect(JSON.stringify(discovered)).toContain("workspace checkout");
  expect(
    await (
      await execute({ action: "read_file", repository, path: "README.md", ref: "main" })
    ).json(),
  ).toMatchObject({ ok: true, result: { kind: "file", content: "Repository is readable" } });
});

beforeEach(async () => {
  await reset();
  const published = await env.PR_SCREENSHOTS.list();

  if (published.objects.length)
    await env.PR_SCREENSHOTS.delete(published.objects.map((object) => object.key));
  await signIn();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.delete("github:connected");
    await state.storage.delete("github:pending");
    await state.storage.delete("github:webhook");
    await state.storage.delete("github:accounts");
  });
});

afterEach(async () => {
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it("discovers App repositories and durably enrolls them without changing GitHub grants", async () => {
  await connect();

  const info = {
    fullName: repository,
    defaultBranch: "develop",
    private: true,
    description: "Example project",
  };

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (path === "/app/installations")
      return Response.json([
        { id: 7, account: { login: "example" } },
        { id: 8, account: { login: "denied" } },
      ]);

    if (path === "/app/installations/7/access_tokens") {
      expect(JSON.parse(String(init?.body))).toEqual({ permissions: GITHUB_APP_READ_PERMISSIONS });

      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }

    if (path === "/installation/repositories")
      return Response.json({
        repositories: [
          {
            full_name: repository,
            default_branch: info.defaultBranch,
            private: true,
            description: info.description,
          },
          { full_name: "denied/project" },
        ],
      });
    throw new Error(`Unexpected GitHub request: ${path}`);
  });

  const list = async (available = false) =>
    (
      await SELF.fetch(
        `https://worker/api/integrations/github/repositories${available ? "?available=true" : ""}`,
        { headers },
      )
    ).json();

  expect(await list()).toEqual({ repositories: [] });
  expect(fetch).not.toHaveBeenCalled();
  expect(await list(true)).toEqual({ repositories: [{ ...info, registered: false }] });
  expect(
    await (
      await post("/api/integrations/github/repositories", { repository: "EXAMPLE/PROJECT" })
    ).json(),
  ).toEqual({ repository: info });
  expect((await post("/api/integrations/github/repositories", { repository })).status).toBe(200);
  await abortAllDurableObjects();
  expect(await list()).toEqual({ repositories: [info] });
  expect(await list(true)).toEqual({ repositories: [{ ...info, registered: true }] });
  expect(
    (await post("/api/integrations/github/repositories", { repository: "denied/project" })).status,
  ).toBe(409);
  expect(
    (await post("/api/integrations/github/repositories", { repository: "../invalid" })).status,
  ).toBe(400);
  expect((await SELF.fetch("https://worker/api/integrations/github/repositories")).status).toBe(
    401,
  );

  await SELF.fetch("https://worker/api/integrations/github/accounts", {
    method: "PUT",
    headers,
    body: JSON.stringify({ accounts: [] }),
  });
  expect(await list()).toEqual({ repositories: [] });

  const removed = await SELF.fetch("https://worker/api/integrations/github/repositories", {
    method: "DELETE",
    headers,
    body: JSON.stringify({ repository }),
  });

  expect(removed.status).toBe(200);
  await SELF.fetch("https://worker/api/integrations/github/accounts", {
    method: "PUT",
    headers,
    body: JSON.stringify({ accounts: ["example"] }),
  });
  expect(await list()).toEqual({ repositories: [] });
});

it("resolves enrolled short names case-insensitively and asks instead of guessing on ambiguity", async () => {
  await connect();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const entry = { defaultBranch: "main", private: true, description: null };
    await state.storage.put("github:repositories", [
      { ...entry, fullName: repository },
      { ...entry, fullName: "another-owner/project" },
      { ...entry, fullName: "example/unique" },
      { ...entry, fullName: "denied/hidden" },
    ]);

    const resolve = (name: string) =>
      Effect.runPromise(
        Effect.flatMap(GitHub, (github) => github.resolveRepository(name)).pipe(
          Effect.provide(GitHub.layer(state.storage, env)),
          Effect.catchTag("OperationError", (error) => Effect.succeed(error.message)),
        ),
      );

    expect(await resolve("UNIQUE")).toBe("example/unique");
    expect(await resolve("project")).toContain("ambiguous: example/project, another-owner/project");
    expect(await resolve("hidden")).toContain("No enrolled repository matches");
    expect(await resolve("example/project")).toBe(repository);
  });
});

it("requires both existing API authentication gates and validates operation contracts", async () => {
  for (const path of ["/api/setup/github/callback", `/api/setup/github/${"a".repeat(43)}`])
    expect(
      (await api.request(`https://worker${path}`, {}, { ...env, ACCESS_LOCAL_DEV: "false" }))
        .status,
    ).toBe(503);

  for (const path of [
    "/api/integrations/github",
    "/api/integrations/github/setup",
    "/api/integrations/github/execute",
  ])
    expect(
      (
        await SELF.fetch(`https://worker${path}`, {
          method: path.endsWith("github") ? "GET" : "POST",
        })
      ).status,
    ).toBe(401);

  for (const operation of [
    { action: "merge_pull_request", repository },
    {
      action: "write_file",
      repository,
      branch: "main",
      path: "src/a.ts",
      message: "change",
      content: "x",
    },
    { action: "read_file", repository, path: "../secret", ref: "main" },
  ])
    expect((await post("/api/integrations/github/execute", { operation })).status).toBe(400);
});

it("keeps setup state through eviction, consumes it once and never returns credentials", async () => {
  const started = await start();
  expect(await start()).toEqual(started);
  await abortAllDurableObjects();
  const form = await SELF.fetch(started.url);
  expect(form.headers.get("Content-Security-Policy")).toContain("form-action https://github.com");
  const html = await form.text();
  expect(html).toContain("Create GitHub App");
  expect(html).toContain("/organizations/example/settings/apps/new");
  expect(html).not.toContain("private-client-secret");

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://api.github.com/app-manifests/manifest-code/conversions");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);

    return Response.json(app);
  });

  const query = `state=${started.state}&code=manifest-code`;
  expect(await callback(query)).toBe("/");

  const status = await (
    await SELF.fetch("https://worker/api/integrations/github", { headers })
  ).text();

  expect(status).toContain('"connected":true');

  for (const secret of [pem, app.client_secret, app.webhook_secret])
    expect(status).not.toContain(secret);
  expect(await callback(query)).not.toBe("/");
  expect(fetch).toHaveBeenCalledTimes(1);
  await abortAllDurableObjects();
  expect(await (await post("/api/integrations/github/setup", setup)).json()).toMatchObject({
    connected: true,
    setupUrl: null,
  });
});

it("rejects redirected manifest exchanges without connecting or following the redirect", async () => {
  const started = await start();

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://api.github.com/app-manifests/manifest-code/conversions");
    expect(init?.redirect).toBe("manual");

    return Response.json(app, {
      status: 302,
      headers: { Location: "https://attacker.example/conversions" },
    });
  });

  const result = await callback(`state=${started.state}&code=manifest-code`);
  expect(result).toContain("Provider returned HTTP 302");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    await (await SELF.fetch("https://worker/api/integrations/github", { headers })).json(),
  ).toEqual({ connected: false });
});

it("rejects forged, expired, and wrong-owner setup callbacks without connecting", async () => {
  const started = await start();

  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ ...app, owner: { login: "other" } }));

  expect(await callback(`state=${"x".repeat(43)}&code=bad`)).toContain("already used");
  expect(fetch).not.toHaveBeenCalled();
  expect(await callback(`state=${started.state}&code=wrong-owner`)).toContain("does not match");
  expect(
    await (await SELF.fetch("https://worker/api/integrations/github", { headers })).json(),
  ).toEqual({ connected: false });
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const pending = await state.storage.get<{ expires: number }>("github:pending");
    await state.storage.put("github:pending", { ...pending, expires: 0, phase: "pending" });
  });
  expect(await callback(`state=${started.state}&code=expired`)).toContain("expired");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("mints repository-scoped tokens with a valid App signature and reads UTF-8 files", async () => {
  await connect();

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (path.endsWith("/installation")) {
      const jwt = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
      const parts = jwt.split(".");

      const signature = Uint8Array.from(
        atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
        (char) => char.charCodeAt(0),
      );

      expect(
        await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          keys.publicKey,
          signature,
          new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
        ),
      ).toBe(true);

      return Response.json({ id: 7 });
    }

    if (path.endsWith("/access_tokens")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        repositories: ["project"],
        permissions: GITHUB_APP_READ_PERMISSIONS,
      });

      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }

    expect(path).toBe("/repos/example/project/contents/src/main.ts");

    if (!new Headers(init?.headers).has("Authorization"))
      return Response.json({ message: "Not Found" }, { status: 404 });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer private-installation-token",
    );

    return Response.json({
      type: "file",
      path: "src/main.ts",
      sha,
      encoding: "base64",
      content: btoa("export const answer = 42;"),
      size: 25,
    });
  });

  const operation = { action: "read_file", repository, path: "src/main.ts", ref: "main" } as const;
  const result = await (await execute(operation)).json();
  expect(result).toEqual({
    ok: true,
    result: { kind: "file", path: "src/main.ts", sha, content: "export const answer = 42;" },
  });
  expect(await (await execute(operation)).json()).toEqual(result);
  expect(fetch).toHaveBeenCalledTimes(7);
  fetch.mockImplementation(async () => Response.json({ message: "Not Found" }, { status: 404 }));
  expect(await (await execute({ ...operation, repository: "other/project" })).text()).toContain(
    "HTTP 404",
  );
  expect(fetch).toHaveBeenCalledTimes(9);
});

it("creates only feature branches, preserves optimistic file writes, and opens but never merges PRs", async () => {
  await connect();
  const writes: string[] = [];
  let defaultBranch = "main";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (path.endsWith("/installation")) return Response.json({ id: 7 });

    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });

    if (path === "/repos/example/project") return Response.json({ default_branch: defaultBranch });

    if (init?.method !== "GET") writes.push(`${init?.method} ${path}`);

    if (path.endsWith("/git/ref/heads/main") || path.endsWith("/git/refs"))
      return Response.json({ object: { sha } });

    if (path.includes("/contents/")) {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        branch: "dolly/fix",
        sha,
        content: btoa("changed"),
      });

      return Response.json({ commit: { sha } });
    }

    if (path.endsWith("/pulls"))
      return Response.json({ number: 8, html_url: "https://github.com/example/project/pull/8" });
    throw new Error(`Unexpected GitHub path ${path}`);
  });
  expect(
    await (
      await execute({ action: "create_branch", repository, base: "main", branch: "dolly/fix" })
    ).json(),
  ).toMatchObject({ ok: true, result: { kind: "branch" } });
  expect(
    await (
      await execute({
        action: "write_file",
        repository,
        branch: "dolly/fix",
        path: "src/main.ts",
        sha,
        content: "changed",
        message: "Fix",
      })
    ).json(),
  ).toMatchObject({ ok: true, result: { kind: "commit" } });
  expect(
    await (
      await execute({
        action: "open_pull_request",
        repository,
        branch: "dolly/fix",
        base: "main",
        title: "Fix",
        body: "Details",
      })
    ).json(),
  ).toMatchObject({ ok: true, result: { kind: "pull_request", number: 8 } });
  expect(
    await (
      await execute({
        action: "write_file",
        repository,
        branch: "dolly/fix",
        path: ".github/workflows/check.yml",
        sha,
        content: "changed",
        message: "Fix",
      })
    ).json(),
  ).toMatchObject({ ok: false, code: "workflow_denied" });
  defaultBranch = "dolly/fix";
  expect(
    await (
      await execute({
        action: "write_file",
        repository,
        branch: "dolly/fix",
        path: "a.ts",
        sha,
        content: "change",
        message: "Fix",
      })
    ).json(),
  ).toMatchObject({ ok: false, code: "default_branch" });
  expect(writes).toEqual([
    "POST /repos/example/project/git/refs",
    "PUT /repos/example/project/contents/src/main.ts",
    "POST /repos/example/project/pulls",
  ]);
});

it.each(["x".repeat(32_769), "漢".repeat(16_384), "漢🙂".repeat(65_536), ""])(
  "writes UTF-8 files without a dolly content-size limit (%#)",
  async (content) => {
    await connect();
    const writes: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;

      if (path.endsWith("/installation")) return Response.json({ id: 7 });

      if (path.endsWith("/access_tokens"))
        return Response.json({
          token: "private-installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });

      if (path === "/repos/example/project") return Response.json({ default_branch: "main" });

      if (path === "/repos/example/project/contents/large.txt" && init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));

        return Response.json({ commit: { sha } });
      }

      throw new Error(`Unexpected GitHub path ${path}`);
    });

    expect(
      await (
        await execute({
          action: "write_file",
          repository,
          branch: "dolly/fix",
          path: "large.txt",
          sha,
          content,
          message: "Write file",
        })
      ).json(),
    ).toEqual({ ok: true, result: { kind: "commit", sha } });
    expect(writes).toEqual([
      {
        branch: "dolly/fix",
        sha,
        message: "Write file",
        content: Buffer.from(content).toString("base64"),
      },
    ]);
  },
);

it("rejects expired installation tokens, bounds responses and removes credentials from fetch failures", async () => {
  await connect();
  const operation = { action: "read_file", repository, ref: "main", path: "a.ts" } as const;
  let mode = "expired";

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (path.includes("/contents/") && !new Headers(init?.headers).has("Authorization"))
      return Response.json({ message: "Not Found" }, { status: 404 });

    if (path.endsWith("/installation")) return Response.json({ id: 7 });

    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(mode === "expired" ? 0 : Date.now() + 3_600_000).toISOString(),
      });

    if (mode === "large") return new Response("x".repeat(1_048_577));
    throw new Error(
      `Connection failed using ${new Headers(init?.headers).get("authorization")?.slice(7)}`,
    );
  });

  expect(await (await execute(operation)).text()).toContain(
    "expired or invalid installation token",
  );
  expect(fetch).toHaveBeenCalledTimes(4);
  mode = "large";
  expect(await (await execute(operation)).text()).toContain("exceeds 1 MiB");
  mode = "failure";
  const result = await (await execute(operation)).text();
  expect(result).toContain("Connection failed using [redacted]");
  expect(result).not.toContain("private-installation-token");
});

it("runs the registered github tool through Pi and persists its result without App secrets", async () => {
  await connect();
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai-codex", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (new URL(String(url)).pathname === "/app/installations")
      return Response.json([{ id: 7, account: { login: "example" } }]);

    if (new URL(String(url)).pathname.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

    if (new URL(String(url)).pathname === "/installation/repositories")
      return Response.json({ repositories: [{ full_name: repository }] });
    expect(String(url)).toContain("chatgpt.com");

    const item =
      requests++ === 0
        ? {
            type: "function_call",
            id: "fc_github",
            call_id: "call_github",
            name: "github",
            arguments: JSON.stringify({ operation: { action: "repositories" } }),
          }
        : {
            type: "message",
            id: "msg_github",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Approved repository: example/project",
                annotations: [],
              },
            ],
          };

    const events = [
      {
        type: "response.created",
        response: { id: "resp_github", status: "in_progress", output: [] },
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_github",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        },
      },
    ];

    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const created = await (await post("/api/sessions", {})).json<{ id: string }>();

  try {
    expect(
      (
        await post(`/api/sessions/${created.id}/messages`, {
          content: "List approved repositories",
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(202);
    await expect
      .poll(async () =>
        (await SELF.fetch(`https://worker/api/sessions/${created.id}`, { headers })).text(),
      )
      .toContain("Approved repository: example/project");

    const transcript = await (
      await SELF.fetch(`https://worker/api/sessions/${created.id}`, { headers })
    ).text();

    const decoded = JSON.parse(transcript);
    expect(decoded.entries).toContainEqual(
      expect.objectContaining({
        model: [
          expect.objectContaining({
            role: "toolResult",
            toolName: "github",
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  result: { kind: "repositories", repositories: [repository] },
                }),
              },
            ],
          }),
        ],
      }),
    );
    expect(transcript).not.toContain("private-client-secret");
    expect(transcript).not.toContain("PRIVATE KEY");
    expect(requests).toBe(2);
    await abortAllDurableObjects();
    expect(
      await (await SELF.fetch(`https://worker/api/sessions/${created.id}`, { headers })).text(),
    ).toContain("Approved repository: example/project");
  } finally {
    await post(`/api/sessions/${created.id}/abort`, {});
    await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
      await state.storage.delete("credential:openai-codex");
    });
  }
});

it("enables ingress in the manifest and configures allowed senders without replacing App credentials", async () => {
  const started = await start();
  const form = await (await SELF.fetch(started.url)).text();
  expect(form).toContain("https://ingress.example/hooks/github");
  expect(form).toContain("issue_comment");
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(app));
  expect(await callback(`state=${started.state}&code=manifest-code`)).toBe("/");
  vi.restoreAllMocks();

  let subscribed = true;

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(String(url)).toBe("https://api.github.com/app");

    return Response.json({
      id: 7,
      permissions: { issues: "read" },
      events: subscribed ? ["issue_comment"] : [],
    });
  });

  const configure = () =>
    SELF.fetch("https://worker/api/integrations/github/webhook", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        senders: ["trusted", ...Array.from({ length: 16 }, (_, i) => `trusted-${i}`)],
      }),
    });

  expect((await configure()).status).toBe(200);
  expect((await configure()).status).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(2);
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const connected = await state.storage.get<{ app: { pem: string; webhook_secret: string } }>(
      "github:connected",
    );

    expect(connected?.app.pem).toBe(pem);

    const profile = await state.storage.get<{
      secret: string;
      senders: string[];
    }>("github:webhook");

    expect(profile?.secret).toBe(app.webhook_secret);
    expect(profile?.senders).toHaveLength(17);
  });

  const cleared = await SELF.fetch("https://worker/api/integrations/github/webhook", {
    method: "PUT",
    headers,
    body: JSON.stringify({ senders: [] }),
  });

  expect(await cleared.json()).toMatchObject({ configured: true, senders: [] });
  expect(
    await (await SELF.fetch("https://worker/api/integrations/github", { headers })).json(),
  ).toMatchObject({ senders: [] });
  expect((await configure()).status).toBe(200);
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("github:connected", {
      app: { id: app.id, slug: app.slug, pem, owner: app.owner },
      repositories: [repository],
    });
    await state.storage.delete("github:webhook");
  });
  expect((await configure()).status).toBe(409);
  expect(
    (
      await SELF.fetch("https://worker/api/integrations/github/webhook", {
        method: "PUT",
        headers,
        body: JSON.stringify({ senders: ["trusted"], secret: app.webhook_secret }),
      })
    ).status,
  ).toBe(200);
  expect((await configure()).status).toBe(200);
  subscribed = false;
  expect((await configure()).status).toBe(409);
  expect(
    (
      await SELF.fetch("https://worker/api/integrations/github/webhook", {
        method: "PUT",
        body: "{}",
      })
    ).status,
  ).toBe(401);
});

it("accepts more than sixteen explicitly approved repositories", async () => {
  const repositories = Array.from({ length: 17 }, (_, i) => `example/project-${i}`);
  const response = await post("/api/integrations/github/setup", { ...setup, repositories });
  expect(response.status).toBe(200);
  const result = await response.json<{ setupUrl: string }>();
  const form = await SELF.fetch(result.setupUrl);
  expect(form.status).toBe(200);
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const pending = await state.storage.get<{ setup: { repositories: string[] } }>(
      "github:pending",
    );

    expect(pending?.setup.repositories).toEqual(repositories);
  });
  expect(
    (await post("/api/integrations/github/setup", { ...setup, repositories: [] })).status,
  ).toBe(400);
});

it("discovers repositories across App installations and paginates GitHub's repository list", async () => {
  await connect();

  const first = Array.from({ length: 100 }, (_, i) => ({
    full_name: `another-owner/project-${i}`,
  }));

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));

    if (url.pathname === "/app/installations")
      return Response.json([
        { id: 7, account: { login: "another-owner" } },
        { id: 8, account: { login: "third-owner" } },
      ]);

    if (url.pathname.endsWith("/access_tokens"))
      return Response.json({
        token: url.pathname.includes("/7/") ? "installation-seven" : "installation-eight",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    expect(url.pathname).toBe("/installation/repositories");

    if (url.searchParams.get("page") === "2")
      return Response.json({ repositories: [{ full_name: "third-owner/newly-granted" }] });

    return Response.json({ repositories: first });
  });

  const result = await (
    await execute({ action: "repositories" })
  ).json<{ ok: boolean; result: { repositories: string[] } }>();

  expect(result.ok).toBe(true);
  expect(result.result.repositories).toContain("another-owner/project-99");
  expect(result.result.repositories).toContain("third-owner/newly-granted");
});

it("brokers real Worker RPC Git requests without exposing credentials or allowing other branch updates", async () => {
  await connect();
  const { workspaceConfig } = await import("../src/workspace");
  const config = workspaceConfig({ repository: "another-owner/project" }, "42");
  const backendName = crypto.randomUUID();
  let upstream = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));

    if (url.hostname === "github.com") {
      await runInDurableObject(env.SANDBOX.getByName(backendName), async (_, state) => {
        await state.storage.put("git-request", true);
      });
      upstream++;
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Basic ${btoa("x-access-token:private-installation-token")}`,
      );
      expect(init?.redirect).toBe("manual");

      return new Response("Git response without credentials");
    }

    if (url.pathname.endsWith("/installation")) return Response.json({ id: 7 });

    if (url.pathname.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

    return Response.json({ default_branch: "main" });
  });
  const agent = env.AGENT.getByName("owner");

  const read = await agent.gitTransport(
    new Request(
      "http://github.workspace/another-owner/project.git/info/refs?service=git-upload-pack",
    ),
    config,
  );

  expect(await read.text()).toBe("Git response without credentials");

  for (const branch of ["main", "dolly/someone-else", config.branch]) {
    const command = `${"a".repeat(40)} ${"b".repeat(40)} refs/heads/${branch}\0report-status\n`;
    const body = (command.length + 4).toString(16).padStart(4, "0") + command + "0000PACK";

    const response = await agent.gitTransport(
      new Request("http://github.workspace/another-owner/project.git/git-receive-pack", {
        method: "POST",
        body,
      }),
      config,
    );

    expect(response.status).toBe(branch === config.branch ? 200 : 403);
    await response.body?.cancel();
  }

  expect(upstream).toBe(2);
});

async function setAccounts(accounts: string[]) {
  return SELF.fetch("https://worker/api/integrations/github/accounts", {
    method: "PUT",
    headers,
    body: JSON.stringify({ accounts }),
  });
}

it("persists a user-configured account allowlist, validates it, and defaults to deny all", async () => {
  const url = "https://worker/api/integrations/github/accounts";
  expect((await SELF.fetch(url)).status).toBe(401);
  expect((await SELF.fetch(url, { method: "PUT", body: '{"accounts":[]}' })).status).toBe(401);
  expect(await (await SELF.fetch(url, { headers })).json()).toEqual({ accounts: [] });
  expect((await setAccounts(["not/an-account"])).status).toBe(400);
  expect(await (await setAccounts(["Example", "EXAMPLE", "another-owner"])).json()).toEqual({
    accounts: ["example", "another-owner"],
  });
  await abortAllDurableObjects();
  expect(await (await SELF.fetch(url, { headers })).json()).toEqual({
    accounts: ["example", "another-owner"],
  });
  expect(await (await setAccounts([])).json()).toEqual({ accounts: [] });
});

it("skips disallowed installations before minting tokens and continues pagination", async () => {
  await connect();
  await setAccounts(["EXAMPLE"]);

  const blocked = Array.from({ length: 100 }, (_, i) => ({
    id: i + 100,
    account: { login: "stranger" },
  }));

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));

    if (url.pathname === "/app/installations")
      return Response.json(
        url.searchParams.get("page") === "1" ? blocked : [{ id: 7, account: { login: "Example" } }],
      );

    if (url.pathname.endsWith("/access_tokens")) {
      expect(url.pathname).toBe("/app/installations/7/access_tokens");

      return Response.json({
        token: "allowed-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }

    expect(url.pathname).toBe("/installation/repositories");

    return Response.json({
      repositories: [{ full_name: repository }, { full_name: "stranger/hidden" }],
    });
  });

  expect(await (await execute({ action: "repositories" })).json()).toEqual({
    ok: true,
    result: { kind: "repositories", repositories: [repository] },
  });
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("blocks revoked accounts from authenticated reads, writes, and Git transport", async () => {
  await connect();

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;

    if (path.includes("/contents/") && !new Headers(init?.headers).has("Authorization"))
      return Response.json({ message: "Not Found" }, { status: 404 });

    if (path.endsWith("/installation")) return Response.json({ id: 7 });

    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: "cached-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

    return Response.json({
      type: "file",
      path: "README.md",
      sha,
      encoding: "base64",
      content: btoa("hello"),
      size: 5,
    });
  });

  const operation = { action: "read_file" as const, repository, path: "README.md", ref: "main" };
  expect(await (await execute(operation)).json()).toMatchObject({ ok: true });
  await setAccounts([]);
  fetch.mockClear();

  expect(await (await execute(operation)).json()).toMatchObject({
    ok: false,
    message: "Provider returned HTTP 404",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(new Headers(fetch.mock.calls[0][1]?.headers).has("Authorization")).toBe(false);
  fetch.mockClear();

  for (const op of [
    { action: "create_branch" as const, repository, branch: "dolly/test", base: "main" },
    {
      action: "write_file" as const,
      repository,
      branch: "dolly/test",
      path: "README.md",
      content: "change",
      message: "Update",
    },
    {
      action: "open_pull_request" as const,
      repository,
      branch: "dolly/test",
      base: "main",
      title: "Update",
      body: "Details",
    },
  ]) {
    expect(await (await execute(op)).json()).toMatchObject({
      ok: false,
      message:
        "GitHub repository owner is not allowed. Add example to Settings → Accounts dolly can work in. Installing the GitHub App alone does not set this allowlist.",
    });
  }

  const { workspaceConfig } = await import("../src/workspace");

  const response = await env.AGENT.getByName("owner").gitTransport(
    new Request(`http://github.workspace/${repository}.git/info/refs?service=git-upload-pack`),
    workspaceConfig({ repository }, "policy"),
  );

  expect(response.status).toBe(502);
  expect(fetch).not.toHaveBeenCalled();
});

const head = "b".repeat(40);

const pullDetails = {
  number: 49,
  html_url: "https://github.com/example/project/pull/49",
  title: "Add feature",
  body: "Description",
  state: "open",
  draft: false,
  user: { login: "author" },
  base: { ref: "main", sha },
  head: { ref: "feature", sha: head },
  labels: [{ name: "enhancement" }],
  requested_reviewers: [{ login: "reviewer" }],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

it("reads public pull requests, files, comment threads and checks anonymously", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    const { pathname, searchParams } = new URL(String(url));

    if (pathname === "/repos/example/project/pulls/49") return Response.json(pullDetails);

    if (pathname.endsWith("/pulls/49/files"))
      return Response.json(
        Array.from({ length: 30 }, (_, index) => ({
          filename: `f${index}.ts`,
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: `@@ -1 +1 @@\n+${"x".repeat(index === 0 ? 50_000 : 10)}`,
        })),
      );

    if (pathname.endsWith("/issues/49/comments"))
      return Response.json([{ id: 1, user: { login: "a" }, body: "hi", html_url: "u1" }]);

    if (pathname.endsWith("/pulls/49/comments")) {
      expect(searchParams.get("page")).toBe("1");

      return Response.json([
        {
          id: 10,
          user: { login: "a" },
          body: "nit",
          path: "f.ts",
          line: 3,
          side: "RIGHT",
          html_url: "u10",
        },
        {
          id: 11,
          user: { login: "b" },
          body: "ok",
          path: "f.ts",
          line: null,
          in_reply_to_id: 10,
          html_url: "u11",
        },
      ]);
    }

    if (pathname.endsWith("/pulls/49/reviews"))
      return Response.json([
        { id: 5, user: { login: "r" }, body: "", state: "APPROVED", commit_id: sha },
      ]);

    if (pathname.endsWith(`/commits/${head}/check-runs`))
      return Response.json({
        check_runs: [
          { name: "test", status: "completed", conclusion: "failure", details_url: "d" },
        ],
      });

    if (pathname.endsWith(`/commits/${head}/status`))
      return Response.json({ state: "success", statuses: [{ context: "ci", state: "success" }] });
    throw new Error(`Unexpected GitHub path ${pathname}`);
  });

  const number = 49;

  expect(
    await (await execute({ action: "read_pull_request", repository, number })).json(),
  ).toMatchObject({
    ok: true,
    result: {
      kind: "pull_request_details",
      data: {
        author: "author",
        head: { ref: "feature", sha: head },
        labels: ["enhancement"],
        requested_reviewers: ["reviewer"],
      },
    },
  });

  const files = await (
    await execute({ action: "list_pull_request_files", repository, number })
  ).json<{ result: { data: { next_page: number; files: Array<{ patch_truncated: boolean }> } } }>();

  expect(files.result.data.next_page).toBe(2);
  expect(files.result.data.files[0].patch_truncated).toBe(true);
  expect(files.result.data.files[1].patch_truncated).toBe(false);

  expect(
    await (await execute({ action: "list_pull_request_comments", repository, number })).json(),
  ).toMatchObject({
    ok: true,
    result: {
      data: {
        next_page: null,
        discussion: [{ id: 1, body: "hi" }],
        threads: [{ id: 10, comments: [{ id: 10 }, { id: 11, outdated: true }] }],
        reviews: [{ id: 5, state: "APPROVED" }],
      },
    },
  });
  expect(
    await (await execute({ action: "read_pull_request_checks", repository, number })).json(),
  ).toMatchObject({
    ok: true,
    result: {
      data: {
        head_sha: head,
        combined_state: "success",
        check_runs: [{ name: "test", conclusion: "failure" }],
      },
    },
  });
  expect(fetch).toHaveBeenCalledTimes(8);
});

it("posts inline reviews only against the current head and diff, and never approves", async () => {
  await connect();
  const writes: Array<{ path: string; body: unknown }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (path.endsWith("/installation")) return Response.json({ id: 7 });

    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });

    if (init?.method === "POST") {
      writes.push({ path, body: JSON.parse(String(init.body)) });

      return path.endsWith("/replies")
        ? Response.json({ id: 99, user: null, body: "", path: "a.ts", html_url: "reply" })
        : Response.json({ id: 77, user: null, state: "PENDING", html_url: "review" });
    }

    if (path === "/repos/example/project/pulls/49") return Response.json(pullDetails);

    if (path.endsWith("/pulls/49/files"))
      return Response.json([
        {
          filename: "a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1,2 +1,2 @@\n ctx\n-old\n+new",
        },
      ]);
    throw new Error(`Unexpected GitHub path ${path}`);
  });

  const review = {
    action: "create_review" as const,
    repository,
    number: 49,
    commit_id: head,
    body: "Looks close",
    event: "PENDING" as const,
    comments: [{ path: "a.ts", line: 2, side: "RIGHT" as const, body: "Use a constant" }],
  };

  expect(await (await execute({ ...review, commit_id: sha })).json()).toMatchObject({
    ok: false,
    code: "stale_commit",
  });
  expect(
    await (await execute({ ...review, comments: [{ ...review.comments[0], line: 9 }] })).json(),
  ).toMatchObject({ ok: false, code: "invalid_comment_anchor" });
  expect(writes).toEqual([]);

  expect(await (await execute(review)).json()).toMatchObject({
    ok: true,
    result: { kind: "review", data: { id: 77, state: "PENDING", comments: 1 } },
  });
  expect(await (await execute({ ...review, event: "COMMENT" })).json()).toMatchObject({ ok: true });
  expect(
    await (
      await execute({
        action: "reply_to_review_comment",
        repository,
        number: 49,
        comment_id: 10,
        body: "Done",
      })
    ).json(),
  ).toMatchObject({ ok: true, result: { kind: "review_comment", data: { id: 99 } } });

  expect(writes.map((write) => write.path)).toEqual([
    "/repos/example/project/pulls/49/reviews",
    "/repos/example/project/pulls/49/reviews",
    "/repos/example/project/pulls/49/comments/10/replies",
  ]);
  expect(writes[0].body).not.toHaveProperty("event");
  expect(writes[0].body).toMatchObject({
    commit_id: head,
    comments: [
      { path: "a.ts", line: 2, side: "RIGHT", body: expect.stringContaining("posted by Dolly") },
    ],
  });
  expect(writes[1].body).toMatchObject({ event: "COMMENT" });

  for (const event of ["APPROVE", "REQUEST_CHANGES"])
    expect(
      (await post("/api/integrations/github/execute", { operation: { ...review, event } })).ok,
    ).toBe(false);
});

it("publishes selected screenshots to public R2 and embeds them in a PR comment", async () => {
  await connect();
  const image = { mimeType: "image/png" as const, data: "iVBORw0KGgo=" };
  const [stored] = await storeImages(env.SCREENSHOTS, [image]);

  const [privateImage] = await storeImages(env.SCREENSHOTS, [
    { mimeType: "image/png", data: btoa("not selected for publication") },
  ]);

  const writes: Array<{ path: string; body: Record<string, string> }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (path.endsWith("/installation")) return Response.json({ id: 7 });

    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });

    if (path.endsWith("/pulls/49")) return Response.json(pullDetails);
    const body = JSON.parse(String(init?.body));
    writes.push({ path, body });

    if (path.endsWith("/issues/49/comments"))
      return Response.json({
        id: 123,
        user: null,
        body: body.body,
        html_url: "https://github.com/example/project/pull/49#issuecomment-123",
      });
    throw new Error(`Unexpected GitHub path ${path}`);
  });

  const response = await post("/api/integrations/github/execute", {
    operation: {
      action: "upload_screenshot",
      repository,
      number: 49,
      image: stored.data,
      caption: "After: desktop [1280×800]",
    },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    result: {
      kind: "screenshot",
      data: {
        comment_url: "https://github.com/example/project/pull/49#issuecomment-123",
        image_url: expect.stringMatching(/^https:\/\/public-test\.r2\.dev\/[a-f0-9-]+\.png$/),
      },
    },
  });
  expect(writes).toHaveLength(1);
  expect(writes[0].body.body).toContain("After: desktop \\[1280×800\\]");
  expect(writes[0].body.body).toContain("posted by Dolly");
  expect(writes[0].body.body).toContain("expires after 30 days");
  const published = await env.PR_SCREENSHOTS.list();
  expect(published.objects).toHaveLength(1);
  const object = await env.PR_SCREENSHOTS.get(published.objects[0].key);
  expect(object?.httpMetadata?.contentType).toBe("image/png");
  expect(btoa(String.fromCharCode(...new Uint8Array(await object!.arrayBuffer())))).toBe(
    image.data,
  );
  expect(await env.SCREENSHOTS.get(stored.data.slice(5))).not.toBeNull();
  expect(await env.SCREENSHOTS.get(privateImage.data.slice(5))).not.toBeNull();
});

it.each(["missing", "oversized", "closed", "denied", "comment failure"] as const)(
  "handles screenshot publishing failure: %s",
  async (scenario) => {
    await connect();

    if (scenario === "denied") await setAccounts([]);
    const key = `screenshots/png/${"a".repeat(64)}`;

    if (scenario !== "missing")
      await env.SCREENSHOTS.put(
        key,
        scenario === "oversized" ? new Uint8Array(5 * 1024 * 1024 + 1) : "image bytes",
      );
    const comments: string[] = [];

    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;

      if (path.endsWith("/installation")) return Response.json({ id: 7 });

      if (path.endsWith("/access_tokens"))
        return Response.json({
          token: "private-installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });

      if (path.endsWith("/pulls/49"))
        return Response.json({ ...pullDetails, state: scenario === "closed" ? "closed" : "open" });

      if (path.endsWith("/issues/49/comments")) {
        comments.push(String(init?.body));

        return Response.json({ message: "Comment forbidden" }, { status: 403 });
      }

      throw new Error(`Unexpected GitHub path ${path}`);
    });

    const response = await post("/api/integrations/github/execute", {
      operation: {
        action: "upload_screenshot",
        repository,
        number: 49,
        image: `r2://${key}`,
        caption: "Before — phone",
      },
    });

    const result = await response.json();

    if (scenario === "comment failure") {
      expect(result).toMatchObject({
        ok: true,
        result: {
          kind: "screenshot",
          data: {
            comment_url: null,
            comment_error: expect.any(String),
            image_url: expect.stringContaining("https://public-test.r2.dev/"),
            markdown: expect.stringContaining("Before — phone"),
          },
        },
      });
      expect(comments).toHaveLength(1);
      expect((await env.PR_SCREENSHOTS.list()).objects).toHaveLength(1);
    } else {
      const codes = {
        missing: "screenshot_missing",
        oversized: "screenshot_size",
        closed: "pull_request_closed",
        denied: "provider_error",
      };

      expect(result).toMatchObject({ ok: false, code: codes[scenario] });
      expect(comments).toHaveLength(0);
      expect((await env.PR_SCREENSHOTS.list()).objects).toHaveLength(0);

      if (scenario === "denied") expect(fetch).not.toHaveBeenCalled();
    }
  },
);

it("rejects non-screenshot references before publishing", async () => {
  await connect();
  const fetch = vi.spyOn(globalThis, "fetch");

  for (const image of [
    "https://example.com/image.png",
    "r2://other/private",
    "r2://screenshots/png/../secret",
  ])
    expect(
      (
        await post("/api/integrations/github/execute", {
          operation: {
            action: "upload_screenshot",
            repository,
            number: 49,
            image,
            caption: "After",
          },
        })
      ).status,
    ).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  expect((await env.PR_SCREENSHOTS.list()).objects).toHaveLength(0);
});

it("lists one public directory level anonymously without fetching the recursive tree", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));

    if (url.pathname === `/repos/${repository}`)
      return Response.json({ default_branch: "main", private: false });

    expect(url.searchParams.get("ref")).toBe("feature/x");

    if (url.pathname === `/repos/${repository}/contents/packages/core/server%20src`)
      return Response.json([
        { path: "packages/core/server src/index.ts", type: "file" },
        { path: "packages/core/server src/usage", type: "dir" },
      ]);

    if (url.pathname === `/repos/${repository}/contents/`)
      return Response.json(
        Array.from({ length: 205 }, (_, i) => ({ path: `f${i}.ts`, type: "file" })),
      );

    if (url.pathname === `/repos/${repository}/contents/README.md`)
      return Response.json({ type: "file", path: "README.md" });

    throw new Error(`Unexpected GitHub request: ${url.pathname}`);
  });

  expect(
    await (
      await execute({
        action: "list_files",
        repository,
        ref: "feature/x",
        path: "packages/core/server src",
      })
    ).json(),
  ).toMatchObject({
    ok: true,
    result: {
      kind: "files",
      data: {
        page: 1,
        next_page: null,
        total: 2,
        paths: ["packages/core/server src/index.ts", "packages/core/server src/usage/"],
      },
    },
  });

  const second = await (
    await execute({ action: "list_files", repository, ref: "feature/x", page: 2 })
  ).json();

  expect(second).toMatchObject({
    ok: true,
    result: { data: { page: 2, next_page: null, total: 205 } },
  });
  expect(JSON.stringify(second)).toContain('["f200.ts","f201.ts","f202.ts","f203.ts","f204.ts"]');
  expect(
    await (
      await execute({ action: "list_files", repository, ref: "feature/x", path: "README.md" })
    ).json(),
  ).toMatchObject({ ok: false, code: "not_a_directory" });
  expect(fetch.mock.calls.some(([input]) => String(input).includes("/git/trees/"))).toBe(false);
  expect(fetch.mock.calls.some(([input]) => String(input).includes("/installation"))).toBe(false);
});
