import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WorkspaceRequest } from "./workspace";
import { rpc } from "./operations";
import { githubRoutes, githubSetupRoutes } from "./github-routes";
import { authorizeAccess } from "./access";
import { AgentApi } from "./api";
import { ChildRequest, NewSession } from "./models";
import { OperationError } from "./operations";
import { exceptionDetails } from "./diagnostics";
import { AnthropicSetup, AnthropicProbe } from "./anthropic";
import type { Env } from "./env";
import { PromptImage, MAX_IMAGES, MAX_PROMPT_BYTES } from "./images";
import { SavedSession } from "./session-contracts";

export { Agent } from "./agent";

export { Sandbox } from "./sandbox";

export { PreviewOutbound } from "./preview";

class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  message: Schema.String,
}) {}

const Message = Schema.Struct({
  content: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
  requestId: Schema.String.check(Schema.isUUID()),
});

const PromptMessage = Schema.Struct({
  ...Message.fields,
  images: Schema.optional(Schema.Array(PromptImage).check(Schema.isMaxLength(MAX_IMAGES))),
});

/** Hono owns HTTP; Effect programs run once at the request boundary. */
function handle(
  c: Context<{ Bindings: Env }>,
  program: Effect.Effect<Response, OperationError | InvalidInput, AgentApi>,
) {
  const layer = AgentApi.layer(c.env);

  return Effect.runPromise(
    program.pipe(
      Effect.provide(layer),
      Effect.catchTag("InvalidInput", (error) =>
        Effect.succeed(c.json({ error: error.message }, 400)),
      ),
      Effect.catchTag("OperationError", (error) =>
        Effect.logError({
          event: "request_failed",
          path: c.req.routePath,
          operation: error.operation,
          error: exceptionDetails(error),
          details: error.details,
        }).pipe(Effect.as(c.json({ error: "Request failed; check Worker logs" }, 502))),
      ),
      Effect.catchCause((cause) =>
        Effect.logError({
          event: "request_defect",
          error: Cause.pretty(cause),
        }).pipe(Effect.as(c.json({ error: "Request failed; check Worker logs" }, 502))),
      ),
    ),
    { signal: c.req.raw.signal },
  );
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

// Browser redirects cannot supply a bearer token; these routes enforce Access themselves.
app.route("/", githubSetupRoutes);

app.use("/api/*", async (c, next) => {
  const access = await Effect.runPromise(authorizeAccess(c.req.raw, c.env), {
    signal: c.req.raw.signal,
  });

  if (access === "unconfigured")
    return c.json({ error: "Configure Cloudflare Access before using the API" }, 503);

  if (access === "denied")
    return c.json({ error: "Cloudflare Access authentication required" }, 401);
  await next();
});

const owner = (c: Context<{ Bindings: Env }>) => c.env.AGENT.getByName("owner");

// Signing in needs only Cloudflare Access. So does creating the GitHub App, until someone owns it.
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/auth" || c.req.path === "/api/auth/github") return next();

  if (
    c.req.path === "/api/integrations/github/setup" &&
    !(await Effect.runPromise(rpc("auth.owner", async () => await owner(c).authOwnerClaimed())))
  )
    return next();

  const signedIn = await Effect.runPromise(
    rpc("auth.session", async () => await owner(c).authSession(getCookie(c, SESSION_COOKIE) ?? "")),
  );

  if (!signedIn) return c.json({ error: "Sign in with GitHub" }, 401);
  await next();
});

app.use("/api/*", (c, next) => {
  // File writes are bounded by GitHub and platform request limits, not the general API cap.
  if (c.req.path === "/api/integrations/github/execute") return next();

  const prompt = c.req.method === "POST" && /^\/api\/sessions\/[^/]+\/messages$/.test(c.req.path);

  return bodyLimit({
    maxSize: prompt ? MAX_PROMPT_BYTES : 65_536,
    onError: (context) =>
      context.json({ error: prompt ? "Prompt body is too large" : "Body exceeds 64 KiB" }, 413),
  })(c, next);
});

const SESSION_COOKIE = "__Host-dolly-session";

const DEVICE_COOKIE = "__Host-dolly-github-device";

const cookie = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" } as const;

// Private image bytes use the same Access + GitHub-owner authentication as transcripts.
app.get("/api/screenshots/:format/:hash", async (c) => {
  const { format, hash } = c.req.param();

  if (!/^(png|jpeg|gif|webp)$/.test(format) || !/^[a-f0-9]{64}$/.test(hash)) return c.notFound();
  const object = await c.env.SCREENSHOTS.get(`screenshots/${format}/${hash}`);

  if (!object) return c.notFound();

  return new Response(object.body, {
    headers: {
      "Content-Type": `image/${format}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});

app.get("/api/auth", async (c) => {
  const [state, user] = await Promise.all([
    Effect.runPromise(rpc("auth.state", async () => await owner(c).authState())),
    Effect.runPromise(
      rpc(
        "auth.session",
        async () => await owner(c).authSession(getCookie(c, SESSION_COOKIE) ?? ""),
      ),
    ),
  ]);

  if ("error" in state) return c.json(state, 502);

  return c.json({ ...state, user });
});

app.post("/api/auth/github", async (c) => {
  const result = await Effect.runPromise(rpc("auth.start", async () => await owner(c).authStart()));

  if ("error" in result) return c.json(result, 409);
  setCookie(c, DEVICE_COOKIE, result.flow, { ...cookie, sameSite: "Strict", maxAge: 900 });

  return c.json(result.status);
});

app.get("/api/auth/github", async (c) => {
  const flow = getCookie(c, DEVICE_COOKIE);

  if (!flow) return c.json({ state: "expired" });

  const result = await Effect.runPromise(
    rpc("auth.poll", async () => await owner(c).authPoll(flow)),
  );

  if ("error" in result) return c.json(result, 502);

  if (result.state === "awaiting_code") return c.json(result);

  deleteCookie(c, DEVICE_COOKIE, { path: "/", secure: true });

  if (result.state === "denied") return c.json(result, 403);

  if (result.state === "expired") return c.json(result);
  setCookie(c, SESSION_COOKIE, result.session, { ...cookie, maxAge: 30 * 24 * 60 * 60 });

  return c.json({ state: "signed_in", login: result.login });
});

app.delete("/api/auth/session", async (c) => {
  await Effect.runPromise(
    rpc("auth.signout", async () => await owner(c).authSignOut(getCookie(c, SESSION_COOKIE) ?? "")),
  );
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });

  return c.json({ signedIn: false });
});

app.post("/api/auth/codex", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;

      return c.json(yield* agent.startLogin);
    }),
  ),
);

app.get("/api/auth/codex", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;

      return c.json(yield* agent.pollLogin);
    }),
  ),
);

app.delete("/api/auth/codex", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;

      return c.json(yield* agent.logout);
    }),
  ),
);

app.get("/api/usage", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const refresh = c.req.query("refresh") === "1";

      return c.json({
        providers: yield* rpc("usage.read", async () => await owner(c).usage(refresh)),
      });
    }),
  ),
);

app.get("/api/auth/anthropic", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      return c.json(yield* rpc("anthropic.status", async () => await owner(c).anthropicStatus()));
    }),
  ),
);

app.put("/api/auth/anthropic", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(() => c.req.json<unknown>()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AnthropicSetup)),
        Effect.mapError(() => new InvalidInput({ message: "Expected a Claude setup token" })),
      );

      const result = yield* rpc("anthropic.save", async () => await owner(c).anthropicSave(input));

      return c.json(result, "error" in result ? 400 : 200);
    }),
  ),
);

app.post("/api/auth/anthropic/test", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(() => c.req.text()).pipe(
        Effect.flatMap((body) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(AnthropicProbe))(body || "{}"),
        ),
        Effect.mapError(
          () =>
            new InvalidInput({ message: "Expected an optional model from the Anthropic catalog" }),
        ),
      );

      const result = yield* rpc("anthropic.test", async () => await owner(c).anthropicTest(input));

      return c.json(result, "error" in result ? 409 : 200);
    }),
  ),
);

app.delete("/api/auth/anthropic", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      return c.json(yield* rpc("anthropic.logout", async () => await owner(c).anthropicLogout()));
    }),
  ),
);

app.get("/api/sessions", (c) =>
  handle(
    c,
    rpc("sessions.list", async () => c.json(await owner(c).sessions())),
  ),
);

app.post("/api/sessions/import", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const sessions = yield* Effect.tryPromise(() => c.req.json<unknown>()).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              sessions: Schema.Array(SavedSession).check(Schema.isMaxLength(100)),
            }),
          ),
        ),
        Effect.mapError(() => new InvalidInput({ message: "Expected up to 100 saved sessions" })),
      );

      return yield* rpc("sessions.import", async () =>
        c.json(await owner(c).importSessions(sessions.sessions)),
      );
    }),
  ),
);

app.put("/api/sessions/:id", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(() => c.req.json<unknown>()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ archived: Schema.Boolean }))),
        Effect.mapError(() => new InvalidInput({ message: "Expected an archived boolean" })),
      );

      const result = yield* rpc("sessions.archive", async () =>
        owner(c).archiveSession(c.req.param("id"), input.archived),
      );

      return result ? c.json(result) : c.json({ error: "Session not found" }, 404);
    }),
  ),
);

app.post("/api/sessions", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const parsed = yield* Effect.tryPromise(() => c.req.text()).pipe(
        Effect.flatMap((body) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(NewSession))(body || "{}"),
        ),
        Effect.mapError(
          () =>
            new InvalidInput({
              message: "Expected an optional model from the Codex or Anthropic catalog",
            }),
        ),
      );

      const agent = yield* AgentApi;
      const result = yield* agent.createSession(parsed.model, parsed.workspace);

      return c.json(result, "error" in result ? 409 : 201);
    }),
  ),
);

app.post("/api/sessions/:id/workspace", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(() => c.req.json<unknown>()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(WorkspaceRequest)),
        Effect.mapError(() => new InvalidInput({ message: "Expected a workspace action" })),
      );

      const result = yield* rpc("workspace.execute", async () =>
        c.env.AGENT.getByName("owner").workspace(c.req.param("id"), input),
      );

      return c.json(result, "error" in result ? 409 : 200);
    }),
  ),
);

app.get("/api/sessions/:id/children", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;
      const result = yield* agent.children(c.req.param("id"));

      return result ? c.json(result) : c.json({ error: "Session not found" }, 404);
    }),
  ),
);

app.post("/api/sessions/:id/children", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const parsed = yield* Effect.tryPromise(() => c.req.json<unknown>()).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ ...ChildRequest.fields, requestId: Message.fields.requestId }),
          ),
        ),
        Effect.mapError(
          () =>
            new InvalidInput({
              message:
                "Expected content, a UUID requestId and an optional Codex or Anthropic model",
            }),
        ),
      );

      const agent = yield* AgentApi;
      const result = yield* agent.spawnChild(c.req.param("id"), parsed);

      if (!result) return c.json({ error: "Session not found" }, 404);

      return c.json(result, "error" in result ? 409 : 202);
    }),
  ),
);

app.post("/api/sessions/:id/children/:childId/messages", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const parsed = yield* Effect.tryPromise(() => c.req.json<unknown>()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Message)),
        Effect.mapError(
          () => new InvalidInput({ message: "Expected content and a UUID requestId" }),
        ),
      );

      const agent = yield* AgentApi;
      const result = yield* agent.sendChild(c.req.param("id"), c.req.param("childId"), parsed);

      if (!result) return c.json({ error: "Session not found" }, 404);

      return c.json(result, "error" in result ? 409 : 202);
    }),
  ),
);

app.get("/api/sessions/:id/tasks/:taskId", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;
      const result = yield* agent.childTask(c.req.param("id"), c.req.param("taskId"));

      return result && !("error" in result)
        ? c.json(result)
        : c.json({ error: "Task not found" }, 404);
    }),
  ),
);

app.get("/api/sessions/:id/events", async (c) => {
  const origin = c.req.header("Origin");

  if (origin && origin !== new URL(c.req.url).origin)
    return c.json({ error: "Cross-origin WebSocket connections are forbidden" }, 403);

  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
    return c.json({ error: "Expected a WebSocket upgrade" }, 426);

  const url = new URL("https://agent/");
  url.searchParams.set("session", c.req.param("id"));

  return owner(c).fetch(new Request(url, { headers: { Upgrade: "websocket" } }));
});

app.get("/api/sessions/:id", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;
      const result = yield* agent.transcript(c.req.param("id"));

      return result
        ? c.body(result, 200, { "Content-Type": "application/json" })
        : c.json({ error: "Session not found" }, 404);
    }),
  ),
);

app.post("/api/sessions/:id/messages", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const parsed = yield* Effect.tryPromise(() => c.req.json<unknown>()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PromptMessage)),
        Effect.mapError(
          () =>
            new InvalidInput({
              message:
                "Expected content, a UUID requestId and at most 4 PNG, JPEG, GIF or WebP images under 5 MB each",
            }),
        ),
      );

      const agent = yield* AgentApi;

      const result = yield* agent.prompt(
        c.req.param("id"),
        parsed.content,
        parsed.requestId,
        parsed.images,
      );

      if (!result) return c.json({ error: "Session not found" }, 404);

      return c.json(result, "error" in result ? 409 : 202);
    }),
  ),
);

app.post("/api/sessions/:id/queue/:submissionId/steer", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const submissionId = Number(c.req.param("submissionId"));

      if (!Number.isSafeInteger(submissionId) || submissionId <= 0)
        return c.json({ error: "Expected a positive submission ID" }, 400);

      const agent = yield* AgentApi;
      const result = yield* agent.steerQueued(c.req.param("id"), submissionId);

      if (!result) return c.json({ error: "Session not found" }, 404);

      return c.json(result, "error" in result ? 409 : 202);
    }),
  ),
);

app.post("/api/sessions/:id/abort", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;
      const result = yield* agent.abort(c.req.param("id"));

      return result ? c.json(result) : c.json({ error: "Session not found" }, 404);
    }),
  ),
);

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();

  return Effect.runPromise(
    Effect.logError({
      event: "http_failure",
      error: exceptionDetails(error),
    }).pipe(Effect.as(c.json({ error: "Request failed; check Worker logs" }, 502))),
  );
});

app.route("/", githubRoutes);

export default app;

export { GitHubIngress } from "./github-ingress";

export { WorkspaceOutbound } from "./git-transport";
