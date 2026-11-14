import { expect, test, type Page } from "@playwright/test";
import type { Live } from "../../src/transcript";

const app = {
  connected: true,
  owner: "octocat",
  appSlug: "dolly-test",
  installUrl: "https://github.com/apps/dolly-test/installations/new",
  settingsUrl: "https://github.com/settings/apps/dolly-test",
  ingress: "https://dolly-ingress.example.workers.dev/hooks/github",
  senders: ["octocat"],
};

const signedIn = { github: app, ownerClaimed: true, user: { login: "octocat" } };

for (const width of [1280, 320]) {
  test(`shows live progress and a ticking timer at ${width}px without manual expansion`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() =>
      localStorage.setItem(
        "dolly.sessions.v1",
        JSON.stringify([
          { id: "progress", model: "gpt-6-sol", title: "Run tests", repository: "", updatedAt: 1 },
        ]),
      ),
    );
    await page.route("**/api/**", (route) => {
      if (new URL(route.request().url()).pathname === "/api/auth")
        return route.fulfill({ json: signedIn });

      return route.fulfill({ json: { state: "connected" } });
    });
    let push: (live: typeof Live.Type, done?: boolean) => void = () => {};

    await page.routeWebSocket("**/api/sessions/progress/events", (socket) => {
      push = (live, done = false) =>
        socket.send(
          JSON.stringify({
            entries: [
              {
                id: 1,
                kind: "pi.user",
                model: [{ role: "user", content: "Run tests", timestamp: Date.now() - 5000 }],
              },
              ...(done
                ? [
                    {
                      id: 2,
                      kind: "pi.assistant",
                      model: [{ role: "assistant", content: "All passed." }],
                    },
                  ]
                : []),
            ],
            docs: { "pi.live": live },
          }),
        );
      push({
        run: {},
        generation: {
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Private reasoning" }],
          },
        },
      });
    });
    await page.goto("/", { waitUntil: "networkidle" });
    const status = page.locator(".running-footer");
    await expect(status).toContainText("Thinking");
    await expect(page.getByText("Private reasoning")).toHaveCount(0);
    const initial = await status.textContent();
    await expect.poll(() => status.textContent()).not.toBe(initial);
    push({
      run: {},
      tools: [{ callId: "test", name: "shell", status: "running", output: "Tests 3/10 passed" }],
    });
    await expect(status).toContainText("Running shell");
    await expect(page.getByText("Tests 3/10 passed")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`live-progress-${width}.png`) });
    push({
      run: {},
      generation: { message: { role: "assistant", content: "All passed" } },
    });
    await expect(status).toContainText("Responding");
    await expect(page.getByText("All passed", { exact: true })).toBeVisible();
    push({}, true);
    await expect(status).toHaveCount(0);
    await expect(page.getByRole("article", { name: "assistant message" })).toContainText(
      "All passed.",
    );
  });
}

// Main now streams transcripts over WebSockets. Reuse each test's HTTP snapshot fixture
// for the initial socket snapshot and push another only after a message/abort mutation.
test.beforeEach(async ({ page }) => {
  const updates = new Set<() => Promise<void>>();
  page.on("requestfinished", (request) => {
    if (
      request.method() === "POST" &&
      /\/(messages|abort|steer)$/.test(new URL(request.url()).pathname)
    )
      for (const update of updates) void update();
  });
  await page.routeWebSocket("**/api/sessions/*/events", (socket) => {
    let active = true;
    const path = new URL(socket.url()).pathname.replace(/\/events$/, "");

    const update = async () => {
      try {
        const text = await page.evaluate(async (path) => await (await fetch(path)).text(), path);

        if (active) socket.send(text);
      } catch {
        if (active) socket.close();
      }
    };

    updates.add(update);
    socket.onClose(() => {
      active = false;
      updates.delete(update);
    });
    void update();
  });
});

test("queues a message while running and promotes it with Send now, including after reload", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "dolly.sessions.v1",
      JSON.stringify([
        {
          id: "queue-session",
          model: "gpt-6-luna",
          title: "Queue test",
          repository: "",
          updatedAt: 1,
        },
      ]),
    ),
  );
  const items: { id: number; mode: string; content: string }[] = [];
  let submissions = 0;
  let promotions = 0;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/auth/codex") return route.fulfill({ json: { state: "connected" } });

    if (path === "/api/auth/anthropic") return route.fulfill({ json: { connected: false } });

    if (path === "/api/sessions/queue-session/messages") {
      submissions++;
      items.push({ id: 42, mode: "followUp", content: route.request().postDataJSON().content });

      return route.fulfill({ status: 202, json: { submissionId: 42 } });
    }

    if (path === "/api/sessions/queue-session/queue/42/steer") {
      promotions++;

      if (promotions === 1) return route.fulfill({ status: 502, json: { error: "Try again" } });
      items[0]!.mode = "steer";

      return route.fulfill({ status: 202, json: { state: "steering" } });
    }

    if (path === "/api/sessions/queue-session")
      return route.fulfill({
        json: {
          entries: [
            { id: 1, kind: "pi.user", model: [{ role: "user", content: "Original task" }] },
          ],
          docs: { "pi.live": { run: {} }, "pi.inbox": { items } },
        },
      });

    return route.fulfill({ json: {} });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByLabel("Message your agent").fill("Use pnpm instead");
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue).toContainText("Use pnpm instead");
  await expect(page.getByLabel("Message your agent")).toHaveValue("");
  await page.reload();
  await expect(queue).toContainText("Use pnpm instead");
  await queue.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Try again");
  await queue.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(queue).toContainText("Sending after the current step");
  await expect(queue.getByRole("button", { name: "Send now", exact: true })).toHaveCount(0);
  expect(submissions).toBe(1);
  expect(promotions).toBe(2);
});

test("connects Claude without Codex, explicitly tests Worker inference, and starts a Claude conversation", async ({
  page,
}) => {
  const token = `sk-ant-oat01-${"a".repeat(64)}`;
  let connected = false;
  let probes = 0;
  let selectedModel = "";
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/auth/codex") return route.fulfill({ json: { state: "not_connected" } });

    if (path === "/api/auth/anthropic") {
      if (route.request().method() === "PUT") {
        expect(route.request().postDataJSON()).toEqual({ token });
        connected = true;
      }

      return route.fulfill({ json: { connected } });
    }

    if (path === "/api/auth/anthropic/test") {
      probes++;

      return route.fulfill({
        json: {
          ok: probes > 1,
          model: "claude-haiku-5-5",
          durationMs: 25,
          message:
            probes === 1
              ? "Anthropic returned HTTP 403 HTML instead of a model response. This may be an upstream edge block."
              : "Claude returned a live inference response from this Worker.",
          upstream: {
            status: probes === 1 ? 403 : 200,
            contentType: probes === 1 ? "text/html" : "text/event-stream",
            requestId: "request-test",
            rayId: "ray-test",
          },
        },
      });
    }

    if (path === "/api/integrations/github/repositories")
      return route.fulfill({ json: { repositories: [] } });

    if (path === "/api/sessions") {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: selectedModel
            ? [
                {
                  id: "claude-session",
                  model: selectedModel,
                  title: "Say hello",
                  repository: "",
                  updatedAt: 1,
                },
              ]
            : [],
        });

      selectedModel = route.request().postDataJSON().model;

      return route.fulfill({ status: 201, json: { id: "claude-session", model: selectedModel } });
    }

    if (path === "/api/sessions/claude-session/messages")
      return route.fulfill({ status: 202, json: {} });

    if (path === "/api/sessions/claude-session")
      return route.fulfill({
        json: {
          entries: [
            { id: 1, kind: "pi.user", model: [{ role: "user", content: "Say hello" }] },
            {
              id: 2,
              kind: "pi.assistant",
              model: [
                { role: "assistant", content: [{ type: "text", text: "Hello from Claude" }] },
              ],
            },
          ],
          docs: {},
        },
      });

    return route.fulfill({ json: {} });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  const connect = page.getByRole("dialog", { name: "Connect a model" });
  await connect.getByRole("button", { name: "Use Claude instead" }).click();
  await connect.getByLabel("Claude setup token").fill(token);
  await connect.getByRole("button", { name: "Save token" }).click();
  await expect(connect.getByLabel("Claude setup token")).toHaveValue("");
  expect(probes).toBe(0);
  await connect.getByRole("button", { name: "Test connection" }).click();
  await expect(connect.getByRole("alert")).toContainText("upstream edge block");
  await connect.getByRole("button", { name: "Test connection" }).click();
  await expect(connect.getByRole("status")).toContainText("live inference response");
  await page.screenshot({ path: test.info().outputPath("claude-connection.png") });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await connect.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("claude-connection-mobile.png") });
  await connect.getByRole("button", { name: "Continue with Claude" }).click();
  const composer = page.getByRole("dialog", { name: "New session" });
  await expect(composer.getByRole("button", { name: "Model", exact: true })).toHaveAttribute(
    "data-value",
    "claude-sonnet-5-5",
  );
  await composer.getByRole("button", { name: "Model", exact: true }).click();
  await composer.getByRole("option", { name: "Claude Haiku 5.5" }).click();
  await composer.getByLabel("Task", { exact: true }).fill("Say hello");
  expect(await composer.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await expect(composer.getByRole("button", { name: "Create", exact: true })).toBeInViewport();
  await composer.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText(
    "Hello from Claude",
  );
  expect(selectedModel).toBe("claude-haiku-5-5");
  expect(await page.evaluate(() => localStorage.getItem("dolly.sessions.v1"))).not.toContain(token);
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText(
    "Hello from Claude",
  );
});

for (const outcome of ["answered", "failed", "retrying"] as const) {
  test(`renders an actual-shaped ${outcome} model response instead of a silent user-only transcript`, async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        "dolly.sessions.v1",
        JSON.stringify([
          {
            id: "response-session",
            model: "gpt-6.1-terra",
            title: "hi",
            repository: "octocat/project",
            updatedAt: 1,
          },
        ]),
      ),
    );

    const message =
      outcome === "answered"
        ? {
            role: "assistant",
            content: [{ type: "text", text: "Hi! How can I help?" }],
            stopReason: "stop",
          }
        : {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "The selected model is unavailable for this account",
          };

    let live: typeof Live.Type = {};

    if (outcome === "failed") {
      const failure = {
        first: 22,
        taskId: 26,
        inputs: [21],
        reason: "model_error",
        detail: message.errorMessage,
      };

      live = { runFailure: failure };
    } else if (outcome === "retrying")
      live = {
        run: { taskId: 26, inputs: [21], turns: 0 },
        generation: {
          attempt: 1,
          retry: { at: Date.now() + 60_000, error: "Provider is temporarily unavailable" },
        },
      };

    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;

      if (path === "/api/auth") return route.fulfill({ json: signedIn });

      if (path === "/api/sessions")
        return route.fulfill({
          json: [
            {
              id: "response-session",
              model: "gpt-6.1-terra",
              title: "hi",
              repository: "octocat/project",
              updatedAt: 1,
            },
          ],
        });

      if (path === "/api/sessions/response-session")
        return route.fulfill({
          json: {
            conversation: { id: 15 },
            entries: [
              {
                id: 22,
                kind: "pi.user",
                model: [{ role: "user", content: "hi", timestamp: 1_000 }],
              },
              {
                id: 25,
                kind: "pi.system",
                model: [{ role: "system", content: "Hidden internal prompt" }],
              },
              { id: 27, kind: "pi.assistant", model: [{ ...message, timestamp: 2_000 }] },
            ],
            docs: { "pi.live": live },
          },
        });

      return route.fulfill({ json: { state: "connected" } });
    });
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByRole("article", { name: "user message" })).toContainText("hi");
    await expect(page.getByText("Hidden internal prompt")).toHaveCount(0);

    if (outcome === "answered") {
      await expect(page.getByRole("article", { name: "assistant message" })).toContainText(
        "Hi! How can I help?",
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
    } else if (outcome === "failed") {
      await expect(page.getByRole("alert")).toContainText(
        "The selected model is unavailable for this account",
      );
      await expect(page.getByRole("complementary", { name: "Session details" })).toContainText(
        "Failed",
      );
      await page.reload();
      await expect(page.getByRole("alert")).toContainText(
        "The selected model is unavailable for this account",
      );
      await page.screenshot({ path: test.info().outputPath("model-failure.png") });
    } else {
      await expect(page.getByText(/Retrying in/)).toContainText(
        "Provider is temporarily unavailable",
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByRole("complementary", { name: "Session details" })).toContainText(
        "Working",
      );
    }
  });
}

for (const repository of ["octocat/project", ""]) {
  test(`plus opens a task composer in the current ${repository ? "repository" : "repo-less"} context and retries without duplicating sessions`, async ({
    page,
  }) => {
    const source = {
      id: "current",
      model: "gpt-6.1-terra",
      title: "Current task",
      repository,
      updatedAt: 1,
    };

    await page.addInitScript(
      (session) => localStorage.setItem("dolly.sessions.v1", JSON.stringify([session])),
      source,
    );
    const creates: unknown[] = [];
    const messages: { content: string; requestId: string }[] = [];

    const config = repository
      ? { repository, ref: "develop", networkHosts: ["registry.npmjs.org"] }
      : null;

    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;

      if (path === "/api/auth") return route.fulfill({ json: signedIn });

      if (path === "/api/integrations/github/repositories")
        return route.fulfill({
          json: {
            repositories: [
              {
                fullName: "octocat/project",
                defaultBranch: "main",
                private: true,
                description: null,
              },
            ],
          },
        });

      if (path === "/api/sessions/current")
        return route.fulfill({
          json: {
            entries: [],
            docs: { "app.workspace": { config, activeRepository: "octocat/other" } },
          },
        });

      if (path === "/api/sessions") {
        if (route.request().method() === "GET") return route.fulfill({ json: [source] });
        creates.push(route.request().postDataJSON());

        return route.fulfill({ json: { id: "created", model: source.model } });
      }

      if (path === "/api/sessions/created/messages") {
        messages.push(route.request().postDataJSON());

        return route.fulfill(
          messages.length === 1
            ? { status: 502, json: { error: "Temporary failure" } }
            : { status: 202, json: {} },
        );
      }

      if (path === "/api/sessions/created")
        return route.fulfill({ json: { entries: [], docs: {} } });

      return route.fulfill({ json: { state: "connected" } });
    });

    if (!repository) await page.setViewportSize({ width: 320, height: 740 });
    await page.goto("/", { waitUntil: "networkidle" });

    const navigation = repository
      ? page.getByRole("complementary", { name: "Workspace navigation" })
      : page.locator(".header-actions");

    await navigation.getByRole("button", { name: "New session" }).click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await expect(dialog.getByLabel("Repository", { exact: true })).toHaveAttribute(
      "data-value",
      repository,
    );
    await expect(dialog.getByLabel("Model", { exact: true })).toHaveAttribute(
      "data-value",
      source.model,
    );
    await expect(dialog.getByLabel("Workspace name")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
    expect(creates).toHaveLength(0);
    await dialog.getByLabel("Task", { exact: true }).fill("Fix the failing tests");
    await page.screenshot({ path: test.info().outputPath("new-session-composer.png") });
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Temporary failure");
    await expect(dialog.getByLabel("Task", { exact: true })).toHaveValue("Fix the failing tests");
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(creates).toEqual([
      config
        ? { model: source.model, thinkingLevel: "low", workspace: config }
        : { model: source.model, thinkingLevel: "low" },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(messages[1]);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fix the failing tests");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test("enrolls an App repository and anchors a new workspace to its default branch", async ({
  page,
}) => {
  let enrolled = false;
  let created: unknown;

  const repository = {
    fullName: "octocat/project",
    defaultBranch: "develop",
    private: true,
    description: "Our project",
  };

  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === "/api/auth") return route.fulfill({ json: signedIn });

    if (url.pathname === "/api/integrations/github/repositories") {
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toEqual({ repository: repository.fullName });
        enrolled = true;

        return route.fulfill({ json: { repository } });
      }

      return route.fulfill({
        json: {
          repositories: url.searchParams.has("available")
            ? [{ ...repository, registered: enrolled }]
            : enrolled
              ? [repository]
              : [],
        },
      });
    }

    if (url.pathname === "/api/sessions") {
      created = route.request().postDataJSON();

      return route.fulfill({ json: { id: "new-session", model: "gpt-6-sol" } });
    }

    if (url.pathname === "/api/sessions/new-session")
      return route.fulfill({ json: { entries: [], docs: {} } });

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog", { name: "New session" });
  await dialog.getByLabel("Task").fill("Cross-repo task");
  await dialog.getByRole("button", { name: "Repository", exact: true }).click();
  await dialog.getByRole("button", { name: "New repository…" }).click();
  await dialog.getByLabel("Find a repository").fill("project");
  await expect(dialog).toContainText("Private · develop · Our project");
  await dialog.getByRole("button", { name: "Enroll", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Repository", exact: true })).toHaveAttribute(
    "data-value",
    "octocat/project",
  );
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(created).toEqual({
    thinkingLevel: "low",
    workspace: { repository: "octocat/project", ref: "develop" },
  });
});

/** A browser that is already signed in with GitHub and ChatGPT, with no saved workspaces. */
async function signedInWorkspace(page: Page) {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    return route.fulfill({ json: { state: "connected" } });
  });
}

test("first run creates the GitHub App from dolly with the ingress URL filled in", async ({
  page,
}) => {
  const errors: string[] = [];
  let setup: unknown;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth")
      return route.fulfill({
        json: { github: { connected: false }, ownerClaimed: false, user: null },
      });

    if (path === "/api/integrations/github/setup") {
      setup = route.request().postDataJSON();

      return route.fulfill({
        json: { connected: false, setupUrl: "http://127.0.0.1:3000/api/setup/github/test-state" },
      });
    }

    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Connect GitHub</title><h1>Create GitHub App</h1>",
    });
  });
  await page.goto("/?github=GitHub%20App%20owner%20does%20not%20match", {
    waitUntil: "networkidle",
  });
  await expect(page.getByRole("heading", { name: "Set up dolly" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("GitHub App owner does not match");
  expect(new URL(page.url()).search).toBe("");
  await expect(page.getByText("API token")).toHaveCount(0);
  await page.getByLabel("Your GitHub username").fill("octocat");
  await page.getByLabel("Ingress URL").fill("https://dolly-ingress.example.workers.dev/");
  await page.getByRole("button", { name: "Create GitHub App" }).click();
  await expect(page.getByRole("heading", { name: "Create GitHub App" })).toBeVisible();
  expect(setup).toEqual({
    owner: "octocat",
    ownerType: "personal",
    ingress: "https://dolly-ingress.example.workers.dev/hooks/github",
  });
  expect(errors).toEqual([]);
});

test("GitHub device sign-in claims dolly, then continues to ChatGPT", async ({ page }) => {
  let polls = 0;

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth")
      return route.fulfill({ json: { github: app, ownerClaimed: false, user: null } });

    if (path === "/api/auth/github" && method === "POST")
      return route.fulfill({
        json: {
          state: "awaiting_code",
          verificationUri: "https://github.com/login/device",
          userCode: "WDJB-MJHT",
          expiresAt: Date.now() + 900_000,
          pollAfterSeconds: 1,
        },
      });

    if (path === "/api/auth/github") {
      polls += 1;

      if (polls === 1)
        return route.fulfill({ status: 502, json: { error: "Request failed; check Worker logs" } });

      return route.fulfill({ json: { state: "signed_in", login: "octocat" } });
    }

    return route.fulfill({ json: { state: "not_connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Sign in to dolly" })).toBeVisible();
  await expect(page.getByRole("link", { name: "its settings" })).toHaveAttribute(
    "href",
    app.settingsUrl,
  );
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page.getByRole("button", { name: "Copy code WDJB-MJHT" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/login/device",
  );
  await expect(page.getByRole("dialog", { name: "Connect a model" })).toBeVisible({
    timeout: 10_000,
  });
  expect(polls).toBe(2);
});

test("GitHub sign-in as someone other than the owner is refused with the reason", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth")
      return route.fulfill({ json: { github: app, ownerClaimed: true, user: null } });

    if (method === "POST")
      return route.fulfill({
        json: {
          state: "awaiting_code",
          verificationUri: "https://github.com/login/device",
          userCode: "WDJB-MJHT",
          expiresAt: Date.now() + 900_000,
          pollAfterSeconds: 1,
        },
      });

    return route.fulfill({
      status: 403,
      json: {
        state: "denied",
        message: "You signed in as @intruder, but this dolly belongs to @octocat.",
      },
    });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "You signed in as @intruder, but this dolly belongs to @octocat.",
  );
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
});

test("device flow turned off links straight to the GitHub App's settings", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth")
      return route.fulfill({ json: { github: app, ownerClaimed: true, user: null } });

    return route.fulfill({
      status: 409,
      json: { error: "Device flow is turned off for this GitHub App, so nobody can sign in." },
    });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page.getByRole("link", { name: "Open the app's settings" })).toHaveAttribute(
    "href",
    app.settingsUrl,
  );
});

test("settings show who is signed in and update the ingress URL and GitHub access", async ({
  page,
}) => {
  let ingress: unknown;
  let accounts: unknown;
  let senders: unknown;
  let signedOut = false;

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth")
      return route.fulfill({ json: signedOut ? { ...signedIn, user: null } : signedIn });

    if (path === "/api/auth/anthropic") return route.fulfill({ json: { connected: false } });

    if (path === "/api/integrations/github/ingress") {
      ingress = route.request().postDataJSON();

      return route.fulfill({ json: { ingress: "https://new-ingress.example/hooks/github" } });
    }

    if (path === "/api/integrations/github/accounts") {
      if (route.request().method() === "PUT") accounts = route.request().postDataJSON();

      return route.fulfill({ json: { accounts: ["octocat"] } });
    }

    if (path === "/api/integrations/github/webhook") {
      senders = route.request().postDataJSON();

      return route.fulfill({ json: { configured: true } });
    }

    if (path === "/api/auth/session") {
      signedOut = true;

      return route.fulfill({ json: { signedIn: false } });
    }

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("dialog", { name: "New session" }).press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  // Settings is a page, and each section has its own URL.
  await expect(page).toHaveURL(/\/settings\/account$/);
  const nav = page.getByRole("navigation", { name: "Settings" });
  const main = page.locator("main");
  await expect(main).toContainText("Signed in as @octocat");
  await nav.getByRole("link", { name: "Repositories" }).click();
  await expect(page).toHaveURL(/\/settings\/repositories$/);
  await expect(main.getByRole("link", { name: "Add repositories" })).toHaveAttribute(
    "href",
    app.installUrl,
  );
  await nav.getByRole("link", { name: "GitHub" }).click();
  await expect(page).toHaveURL(/\/settings\/github$/);
  await main.getByLabel("Ingress URL").fill("https://new-ingress.example");
  await main.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(main).toContainText("GitHub now sends comments to this URL.");
  expect(ingress).toEqual({ url: "https://new-ingress.example/hooks/github" });
  await expect(main.getByLabel("Accounts dolly can work in")).toHaveValue("octocat");
  await expect(main.getByLabel("Who can run /pi commands")).toHaveValue("octocat");
  await main.getByLabel("Accounts dolly can work in").fill("octocat, @acme");
  await main.getByLabel("Who can run /pi commands").fill("octocat hubot");
  await main.getByRole("button", { name: "Save", exact: true }).last().click();
  await expect(main.getByText("Saved.", { exact: true })).toBeVisible();
  expect(accounts).toEqual({ accounts: ["octocat", "acme"] });
  expect(senders).toEqual({ senders: ["octocat", "hubot"] });
  // Leaving and returning keeps what was saved, and clearing the list saves an empty list.
  await nav.getByRole("link", { name: "Account" }).click();
  await nav.getByRole("link", { name: "GitHub" }).click();
  await expect(main.getByLabel("Who can run /pi commands")).toHaveValue("octocat, hubot");
  await main.getByLabel("Who can run /pi commands").fill("");
  await main.getByRole("button", { name: "Save", exact: true }).last().click();
  await expect(main.getByText("Saved.", { exact: true })).toBeVisible();
  expect(senders).toEqual({ senders: [] });
  // Loading /settings directly opens the first section.
  await page.goto("/settings", { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/settings\/account$/);
  await main.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to dolly" })).toBeVisible();
  expect(signedOut).toBe(true);
});

test("mobile navigation and 320px layout", async ({ page }) => {
  await signedInWorkspace(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("dialog", { name: "New session" }).press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).not.toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Feed" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).not.toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Feed");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("authenticated create, send, stop, reload, and error recovery", async ({ page }) => {
  const entries: { id: number; kind: string; model: { role: string; content: string }[] }[] = [];
  let working = false;
  const requestIds: string[] = [];
  let failMessage = true;
  let stopped = false;
  await page.route("**/api/**", async (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/auth/codex") return route.fulfill({ json: { state: "connected" } });

    if (path === "/api/sessions")
      return route.fulfill({ status: 201, json: { id: "test-session", model: "gpt-6-sol" } });

    if (path.endsWith("/messages")) {
      const body = route.request().postDataJSON();

      if (body.content === "Run tests") requestIds.push(body.requestId);

      if (failMessage && body.content === "Run tests") {
        failMessage = false;

        return route.fulfill({ status: 502, json: { error: "Temporary failure. Try again." } });
      }

      entries.push({
        id: entries.length + 1,
        kind: "pi.input",
        model: [{ role: "user", content: body.content }],
      });

      working = body.content === "Run tests";

      return route.fulfill({ status: 202, json: { submissionId: "submission-1" } });
    }

    if (path.endsWith("/abort")) {
      stopped = true;

      return route.fulfill({ json: { ok: true } });
    }

    return route.fulfill({ json: { entries, docs: working ? { "pi.live": { run: {} } } : {} } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByLabel("Task").fill("Fix flaky tests");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fix flaky tests");
  await page.getByLabel("Message your agent").fill("Run tests");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Temporary failure. Try again.");
  await expect(page.getByLabel("Message your agent")).toHaveValue("Run tests");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByLabel("Message your agent")).toHaveValue("");
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  await expect(page.getByRole("article", { name: "user message" }).last()).toContainText(
    "Run tests",
  );
  await page.getByRole("button", { name: "Stop agent" }).click();
  await expect.poll(() => stopped).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fix flaky tests");
});

test("ChatGPT device sign-in shows the code, polls until approved, then opens a new workspace", async ({
  page,
}) => {
  const calls: string[] = [];
  let polls = 0;

  const awaiting = {
    state: "awaiting_code",
    verificationUri: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
    expiresAt: Date.now() + 900_000,
    pollAfterSeconds: 1,
  };

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path !== "/api/auth/codex") return route.fulfill({ status: 404, json: { error: "x" } });

    calls.push(method);

    if (method === "POST") return route.fulfill({ json: awaiting });

    if (calls.filter((call) => call === "POST").length === 0)
      return route.fulfill({ json: { state: "not_connected" } });

    polls += 1;

    if (polls === 2) return route.fulfill({ status: 502, json: { error: "Temporary failure" } });

    return route.fulfill({ json: polls < 3 ? awaiting : { state: "connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog", { name: "Connect a model" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(page.getByRole("button", { name: "Copy code ABCD-1234" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open ChatGPT" })).toHaveAttribute(
    "href",
    "https://auth.openai.com/codex/device",
  );
  await expect(page.getByRole("dialog", { name: "New session" })).toBeVisible({
    timeout: 10_000,
  });
  expect(polls).toBe(3);
});

test("cancelling ChatGPT sign-in ignores an approval that was already in flight", async ({
  page,
}) => {
  let started = false;
  let deleted = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (method === "DELETE") {
      deleted = true;
      // The Worker serialises DELETE behind the approval already holding the account lock.
      await held;
      await new Promise((resolve) => setTimeout(resolve, 300));

      return route.fulfill({ json: { state: "not_connected" } });
    }

    if (method === "POST") {
      started = true;

      return route.fulfill({
        json: {
          state: "awaiting_code",
          verificationUri: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
          expiresAt: Date.now() + 900_000,
          pollAfterSeconds: 1,
        },
      });
    }

    if (!started) return route.fulfill({ json: { state: "not_connected" } });

    await held;

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog", { name: "Connect a model" });
  await dialog.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(dialog.getByRole("button", { name: "Copy code ABCD-1234" })).toBeVisible();
  await page.waitForTimeout(1_500);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => deleted).toBe(true);
  release();
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
});
