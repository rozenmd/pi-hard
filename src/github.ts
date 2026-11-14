import { Buffer } from "node:buffer";
import { createPrivateKey } from "node:crypto";
import { flow } from "effect/Function";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  GitHubSetup,
  GitHubAccounts,
  GitHubRequest,
  GitHubReply,
  Repository,
  EnrolledRepository,
} from "./github-contracts";
import {
  WebhookSetup,
  WebhookProfile,
  verifyWebhook,
  GitHubEvent,
  WebhookUrl,
} from "./github-webhook";
import { exceptionDetails } from "./diagnostics";
import { integrationJson } from "./integration-http";
import { budgetPatches, invalidAnchors, REVIEW_FOOTER } from "./github-review";
import { attempt, OperationError } from "./operations";
import { MAX_IMAGE_BYTES } from "./images";
import type { Env } from "./env";

import {
  GITHUB_APP_GRANT_PERMISSIONS,
  GITHUB_APP_READ_PERMISSIONS,
  GITHUB_APP_WRITE_PERMISSIONS,
  GITHUB_APP_CODE_PERMISSIONS,
} from "./github-permissions";

const App = Schema.Struct({
  id: Schema.Number,
  slug: Schema.NonEmptyString,
  pem: Schema.NonEmptyString,
  client_id: Schema.optional(Schema.NonEmptyString),
  webhook_secret: Schema.optional(Schema.NonEmptyString),
  owner: Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) }),
});

const Connected = Schema.Struct({ app: App });

const Pending = Schema.Struct({
  state: Schema.String,
  expires: Schema.Number,
  origin: Schema.String,
  setup: GitHubSetup,
  phase: Schema.Literals(["pending", "converting"]),
});

const Token = Schema.Struct({ token: Schema.NonEmptyString, expires_at: Schema.String });
const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const RefResponse = Schema.Struct({ object: Schema.Struct({ sha: Sha }) });
const RepoResponse = Schema.Struct({ default_branch: Schema.String });

const FileResponse = Schema.Struct({
  type: Schema.Literal("file"),
  path: Schema.String,
  sha: Sha,
  encoding: Schema.Literal("base64"),
  content: Schema.String,
  size: Schema.Number,
});

const DirectoryResponse = Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.String }));

const TREE_ENTRIES_PER_PAGE = 200;

const CommitResponse = Schema.Struct({ commit: Schema.Struct({ sha: Sha }) });
const PullResponse = Schema.Struct({ number: Schema.Number, html_url: Schema.String });

const PullStateResponse = Schema.Struct({
  state: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  merged: Schema.optional(Schema.Boolean),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const FILES_PER_PAGE = 30;
const COMMENTS_PER_PAGE = 50;

const User = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const PullDetails = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  merged: Schema.optional(Schema.Boolean),
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable_state: Schema.optional(Schema.String),
  user: User,
  base: Schema.Struct({ ref: Schema.String, sha: Sha }),
  head: Schema.Struct({ ref: Schema.String, sha: Sha }),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  requested_reviewers: Schema.Array(Schema.Struct({ login: Schema.String })),
  commits: Schema.optional(Schema.Number),
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
  changed_files: Schema.optional(Schema.Number),
  created_at: Schema.String,
  updated_at: Schema.String,
});

const PullFile = Schema.Struct({
  filename: Schema.String,
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  previous_filename: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.String),
});

const IssueComment = Schema.Struct({
  id: Schema.Number,
  user: User,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.String,
});

const InlineComment = Schema.Struct({
  id: Schema.Number,
  user: User,
  body: Schema.String,
  path: Schema.String,
  line: Schema.optional(Schema.NullOr(Schema.Number)),
  start_line: Schema.optional(Schema.NullOr(Schema.Number)),
  side: Schema.optional(Schema.NullOr(Schema.String)),
  in_reply_to_id: Schema.optional(Schema.Number),
  html_url: Schema.String,
});

const Review = Schema.Struct({
  id: Schema.Number,
  user: User,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.String,
  commit_id: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.String),
});

const CheckRuns = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      details_url: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

const CombinedStatus = Schema.Struct({
  state: Schema.String,
  statuses: Schema.Array(
    Schema.Struct({
      context: Schema.String,
      state: Schema.String,
      description: Schema.optional(Schema.NullOr(Schema.String)),
      target_url: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

type ThreadComment = {
  id: number;
  author: string | null;
  body: string;
  path: string;
  line: number | null;
  start_line: number | null;
  side: string | null;
  outdated: boolean;
  url: string;
};

function truncate(text: string, limit: number) {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n…[truncated ${text.length - limit} characters]`;
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

const jwt = Effect.fn("GitHub.jwt")(function* (app: typeof App.Type) {
  const now = Math.floor(Date.now() / 1000);

  const part = (value: { alg: string; typ: string } | { iss: string; iat: number; exp: number }) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));

  const input = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: String(app.id), iat: now - 60, exp: now + 540 })}`;

  const privateKey = yield* attempt("github.key", async () => {
    const der = createPrivateKey(app.pem).export({ type: "pkcs8", format: "der" });

    return crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(der),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  });

  const signature = yield* attempt("github.sign", () =>
    crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input)),
  );

  return `${input}.${base64url(new Uint8Array(signature))}`;
});

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema, { reportInput: false }),
    Effect.mapError(
      (cause) =>
        new OperationError({
          operation: "github.decode",
          message: "Invalid GitHub response or stored configuration",
          details: exceptionDetails(cause),
        }),
    ),
  );

type GitHubBody =
  | {
      repositories?: readonly string[];
      permissions: Readonly<Record<string, string>>;
    }
  | { body: string }
  | { ref: string; sha: string }
  | { head: string; base: string; title: string; body: string }
  | { message: string; branch: string; content: string; sha?: string }
  | { url: string; content_type: "json"; secret: string; insecure_ssl: "0" }
  | {
      commit_id: string;
      body: string;
      event?: "COMMENT";
      comments: ReadonlyArray<Readonly<Record<string, string | number>>>;
    };

/** The ingress Worker's webhook URL for a base URL, with or without the `/hooks/github` path. */
export function ingressHook(url: string) {
  const base = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/hooks\/github$/, "");

  return Schema.decodeUnknownOption(WebhookUrl)(`${base}/hooks/github`);
}

function makeGitHub(
  storage: DurableObjectStorage,
  images: Pick<Env, "SCREENSHOTS" | "PR_SCREENSHOTS" | "PR_SCREENSHOTS_URL">,
) {
  const setupPermit = Semaphore.makeUnsafe(1);
  const tokens = new Map<string, { value: string; expires: number }>();

  // Stored policy is authoritative: absence or an empty list denies every owner.
  const accounts = Effect.gen(function* () {
    const raw = yield* attempt("github.accounts.read", () => storage.get("github:accounts"));

    return raw === undefined ? [] : yield* decode(GitHubAccounts.fields.accounts)(raw);
  });

  const accountAllowed = Effect.fn("GitHub.accountAllowed")(function* (owner: string) {
    const allowed = yield* accounts;

    return allowed.some((account) => account.toLowerCase() === owner.toLowerCase());
  });

  const configureAccounts = Effect.fn("GitHub.configureAccounts")(
    (input: typeof GitHubAccounts.Type) =>
      setupPermit.withPermit(
        Effect.gen(function* () {
          const allowed = Array.from(
            new Set(input.accounts.map((account) => account.toLowerCase())),
          );

          yield* attempt("github.accounts.save", () => storage.put("github:accounts", allowed));
          tokens.clear();

          return { accounts: allowed };
        }),
      ),
  );

  const ingress = Effect.gen(function* () {
    const raw = yield* attempt("github.ingress.read", () => storage.get("github:ingress"));

    return raw === undefined ? "" : yield* decode(WebhookUrl)(raw);
  });

  // Who may run /pi commands. The signing secret stays server-side.
  const senders = Effect.gen(function* () {
    const raw = yield* attempt("github.webhook.read", () => storage.get("github:webhook"));

    return raw === undefined ? [] : (yield* decode(WebhookProfile)(raw)).senders;
  });

  const read = Effect.fn("GitHub.configuration")(function* () {
    const raw = yield* attempt("github.read", () => storage.get("github:connected"));

    if (raw === undefined)
      return yield* new OperationError({
        operation: "github.setup",
        message: "Connect a GitHub App first",
        details: null,
      });

    return yield* decode(Connected)(raw);
  });

  const api = Effect.fn("GitHub.api")((
    path: string,
    token: string,
    body?: GitHubBody,
    method = body ? "POST" : "GET",
  ) => {
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dolly",
      "Content-Type": "application/json",
    });

    if (token) headers.set("Authorization", `Bearer ${token}`);

    return integrationJson(`https://api.github.com${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  });

  const tokenFor = Effect.fn("GitHub.token")(function* (
    connected: typeof Connected.Type,
    repository: string,
    scope: "read" | "write" | "code",
  ) {
    if (!(yield* accountAllowed(repository.split("/")[0])))
      return yield* new OperationError({
        operation: "github.account",
        message: `GitHub repository owner is not allowed. Add ${repository.split("/")[0]} to Settings → Accounts dolly can work in. Installing the GitHub App alone does not set this allowlist.`,
        details: null,
      });

    const key = `${repository}:${scope}`;
    const cached = tokens.get(key);

    if (cached && cached.expires > Date.now() + 300_000) return cached.value;
    const appToken = yield* jwt(connected.app);

    const installation = yield* api(`/repos/${repository}/installation`, appToken).pipe(
      Effect.flatMap(decode(Schema.Struct({ id: Schema.Number }))),
    );

    const name = repository.split("/")[1];

    const result = yield* api(`/app/installations/${installation.id}/access_tokens`, appToken, {
      repositories: [name],
      permissions: {
        read: GITHUB_APP_READ_PERMISSIONS,
        write: GITHUB_APP_WRITE_PERMISSIONS,
        code: GITHUB_APP_CODE_PERMISSIONS,
      }[scope],
    }).pipe(Effect.flatMap(decode(Token)));

    const expires = yield* decode(Schema.Finite)(Date.parse(result.expires_at));

    if (expires <= Date.now())
      return yield* new OperationError({
        operation: "github.token",
        message: "GitHub returned an expired or invalid installation token",
        details: null,
      });
    tokens.set(key, { value: result.token, expires });

    return result.token;
  });

  const repositories = Effect.fn("GitHub.repositories")(function* () {
    const connected = yield* read();
    const appToken = yield* jwt(connected.app);
    const found = new Map<string, typeof EnrolledRepository.Type>();

    for (let page = 1; ; page++) {
      const installations = yield* api(
        `/app/installations?per_page=100&page=${page}`,
        appToken,
      ).pipe(
        Effect.flatMap(
          decode(
            Schema.Array(
              Schema.Struct({
                id: Schema.Number,
                account: Schema.Struct({ login: Schema.String }),
              }),
            ),
          ),
        ),
      );

      for (const installation of installations) {
        if (!(yield* accountAllowed(installation.account.login))) continue;

        const token = yield* api(`/app/installations/${installation.id}/access_tokens`, appToken, {
          permissions: GITHUB_APP_READ_PERMISSIONS,
        }).pipe(Effect.flatMap(decode(Token)));

        for (let repositoryPage = 1; ; repositoryPage++) {
          const result = yield* api(
            `/installation/repositories?per_page=100&page=${repositoryPage}`,
            token.token,
          ).pipe(
            Effect.flatMap(
              decode(
                Schema.Struct({
                  repositories: Schema.Array(
                    Schema.Struct({
                      full_name: Repository,
                      default_branch: Schema.optional(Schema.String),
                      private: Schema.optional(Schema.Boolean),
                      description: Schema.optional(Schema.NullOr(Schema.String)),
                    }),
                  ),
                }),
              ),
            ),
          );

          for (const repository of result.repositories) {
            if (yield* accountAllowed(repository.full_name.split("/")[0]))
              found.set(repository.full_name.toLowerCase(), {
                fullName: repository.full_name,
                defaultBranch: repository.default_branch ?? "main",
                private: repository.private ?? false,
                description: repository.description ?? null,
              });
          }

          if (result.repositories.length < 100) break;
        }
      }

      if (installations.length < 100) break;
    }

    return [...found.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  });

  const enrolled = Effect.gen(function* () {
    const raw = yield* attempt("github.repositories.read", () =>
      storage.get("github:repositories"),
    );

    return raw === undefined ? [] : yield* decode(Schema.Array(EnrolledRepository))(raw);
  });

  const enrolledRepositories = Effect.gen(function* () {
    const allowed = new Set((yield* accounts).map((account) => account.toLowerCase()));

    return (yield* enrolled).filter((repo) =>
      allowed.has(repo.fullName.split("/")[0].toLowerCase()),
    );
  });

  const availableRepositories = Effect.gen(function* () {
    const registered = new Set((yield* enrolled).map((repo) => repo.fullName.toLowerCase()));

    return (yield* repositories()).map((repo) => ({
      ...repo,
      registered: registered.has(repo.fullName.toLowerCase()),
    }));
  });

  const resolveRepository = Effect.fn("GitHub.resolveRepository")(function* (name: string) {
    const fullName = Schema.decodeUnknownOption(Repository)(name);

    if (Option.isSome(fullName)) return fullName.value;

    const matches = (yield* enrolledRepositories).filter(
      (repo) => repo.fullName.split("/")[1].toLowerCase() === name.toLowerCase(),
    );

    if (matches.length !== 1)
      return yield* Effect.fail(
        new OperationError({
          operation: "github.repositories.resolve",
          message: matches.length
            ? `Repository name is ambiguous: ${matches.map((repo) => repo.fullName).join(", ")}. Ask which owner/repository to use.`
            : "No enrolled repository matches that name. List repositories or ask for owner/repository.",
          details: {},
        }),
      );

    return matches[0].fullName;
  });

  const enrollRepository = Effect.fn("GitHub.enrollRepository")((repository: string) =>
    setupPermit.withPermit(
      Effect.gen(function* () {
        const available = yield* repositories();

        const selected = available.find(
          (repo) => repo.fullName.toLowerCase() === repository.toLowerCase(),
        );

        if (!selected)
          return yield* Effect.fail(
            new OperationError({
              operation: "github.repositories.enroll",
              message: "Repository is not available to the GitHub App in an allowed account",
              details: {},
            }),
          );

        const current = (yield* enrolled).filter(
          (repo) => repo.fullName.toLowerCase() !== repository.toLowerCase(),
        );

        current.push(selected);
        yield* attempt("github.repositories.save", () =>
          storage.put("github:repositories", current),
        );

        return { repository: selected };
      }),
    ),
  );

  const removeRepository = Effect.fn("GitHub.removeRepository")((repository: string) =>
    setupPermit.withPermit(
      Effect.gen(function* () {
        const current = (yield* enrolled).filter(
          (repo) => repo.fullName.toLowerCase() !== repository.toLowerCase(),
        );

        yield* attempt("github.repositories.save", () =>
          storage.put("github:repositories", current),
        );

        return { removed: true };
      }),
    ),
  );

  const status = Effect.gen(function* () {
    const raw = yield* attempt("github.status", () => storage.get("github:connected"));

    if (raw === undefined) return { connected: false };
    const value = yield* decode(Connected)(raw);
    const slug = encodeURIComponent(value.app.slug);

    const settings =
      value.app.owner.type === "Organization"
        ? `https://github.com/organizations/${encodeURIComponent(value.app.owner.login)}/settings/apps/${slug}`
        : `https://github.com/settings/apps/${slug}`;

    return {
      connected: true,
      owner: value.app.owner.login,
      appSlug: value.app.slug,
      installUrl: `https://github.com/apps/${slug}/installations/new`,
      settingsUrl: settings,
      ingress: (yield* ingress) || null,
      senders: yield* senders,
    };
  });

  const uploadScreenshot = Effect.fn("GitHub.uploadScreenshot")(function* (
    op: Extract<typeof GitHubRequest.Type.operation, { action: "upload_screenshot" }>,
    connected: typeof Connected.Type,
  ) {
    const token = yield* tokenFor(connected, op.repository, "write");

    if (!/^https:\/\/[a-z0-9-]+\.r2\.dev$/.test(images.PR_SCREENSHOTS_URL))
      return {
        ok: false as const,
        code: "screenshots_unconfigured",
        message: "Provision the public PR screenshot bucket and export its URL before publishing",
      };
    const root = `/repos/${op.repository}`;

    const pull = yield* api(`${root}/pulls/${op.number}`, token).pipe(
      Effect.flatMap(decode(PullDetails)),
    );

    if (pull.state !== "open")
      return {
        ok: false as const,
        code: "pull_request_closed",
        message: "The pull request is not open",
      };

    const image = yield* attempt("github.screenshot.read", () =>
      images.SCREENSHOTS.get(op.image.slice(5)),
    );

    if (!image)
      return {
        ok: false as const,
        code: "screenshot_missing",
        message: "Screenshot is missing from R2",
      };

    if (!image.size || image.size > MAX_IMAGE_BYTES)
      return {
        ok: false as const,
        code: "screenshot_size",
        message: "Screenshot must be between 1 byte and 5 MiB",
      };

    const format = op.image.split("/")[3];
    // A fresh, unguessable key avoids exposing private content-addressed references.
    const key = `${crypto.randomUUID()}.${format}`;
    const bytes = yield* attempt("github.screenshot.bytes", () => image.arrayBuffer());
    yield* attempt("github.screenshot.publish", () =>
      images.PR_SCREENSHOTS.put(key, bytes, {
        httpMetadata: {
          contentType: `image/${format}`,
          cacheControl: "public, max-age=3600",
        },
      }),
    );
    const imageUrl = `${images.PR_SCREENSHOTS_URL}/${key}`;
    const caption = op.caption.replace(/[\\`*_[\]<>!]/g, "\\$&").replace(/[\r\n]/g, " ");
    const markdown = `![${caption}](${imageUrl})`;

    // Preserve the uploaded URL if commenting fails; don't imply the PR was updated.
    return yield* api(`${root}/issues/${op.number}/comments`, token, {
      body: `${markdown}\n\nScreenshot expires after 30 days.${REVIEW_FOOTER}`,
    }).pipe(
      Effect.flatMap(decode(IssueComment)),
      Effect.map((comment) => ({
        ok: true as const,
        result: {
          kind: "screenshot" as const,
          data: { image_url: imageUrl, comment_url: comment.html_url, markdown },
        },
      })),
      Effect.catchTag("OperationError", (error) =>
        Effect.succeed({
          ok: true as const,
          result: {
            kind: "screenshot" as const,
            data: {
              image_url: imageUrl,
              comment_url: null,
              markdown,
              comment_error: error.message,
            },
          },
        }),
      ),
    );
  });

  /** The App's OAuth client ID, which runs the device sign-in. Older setups did not store it. */
  const clientId = Effect.gen(function* () {
    const connected = yield* read();

    if (connected.app.client_id) return connected.app.client_id;

    const app = yield* api("/app", yield* jwt(connected.app)).pipe(
      Effect.flatMap(decode(Schema.Struct({ client_id: Schema.NonEmptyString }))),
    );

    yield* attempt("github.client.save", () =>
      storage.put("github:connected", { app: { ...connected.app, client_id: app.client_id } }),
    );

    return app.client_id;
  });

  const configureIngress = Effect.fn("GitHub.configureIngress")((url: string) =>
    setupPermit.withPermit(
      Effect.gen(function* () {
        const hook = ingressHook(url);

        if (Option.isNone(hook))
          return {
            error:
              "Enter the ingress Worker's HTTPS URL, such as https://dolly-ingress.example.workers.dev",
          };

        const connected = yield* read();
        const saved = yield* attempt("github.webhook.read", () => storage.get("github:webhook"));
        const profile = saved === undefined ? undefined : yield* decode(WebhookProfile)(saved);
        const secret = profile?.secret ?? connected.app.webhook_secret;

        if (!secret)
          return { error: "This GitHub App has no webhook secret. Create a new GitHub App." };

        yield* api(
          "/app/hook/config",
          yield* jwt(connected.app),
          { url: hook.value, content_type: "json", secret, insecure_ssl: "0" },
          "PATCH",
        );
        yield* attempt("github.ingress.save", () => storage.put("github:ingress", hook.value));

        return { ingress: hook.value };
      }),
    ),
  );

  const start = Effect.fn("GitHub.start")((setup: typeof GitHubSetup.Type, origin: string) =>
    setupPermit.withPermit(
      Effect.gen(function* () {
        const existing = yield* status;

        if (existing.connected) return { ...existing, setupUrl: null };

        const previous = yield* attempt("github.pending", () => storage.get("github:pending"));

        const pending =
          previous === undefined ? Option.none() : Schema.decodeUnknownOption(Pending)(previous);

        if (
          Option.isSome(pending) &&
          pending.value.expires > Date.now() &&
          pending.value.phase === "pending"
        ) {
          if (
            pending.value.origin !== origin ||
            JSON.stringify(pending.value.setup) !== JSON.stringify(setup)
          )
            return yield* new OperationError({
              operation: "github.setup",
              message: "A different setup is pending; finish it or wait one hour",
              details: null,
            });

          return {
            connected: false,
            setupUrl: `${origin}/api/setup/github/${pending.value.state}`,
          };
        }

        const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
        yield* attempt("github.pending.write", () =>
          storage.put("github:pending", {
            state,
            expires: Date.now() + 3_600_000,
            setup,
            origin,
            phase: "pending",
          }),
        );

        return { connected: false, setupUrl: `${origin}/api/setup/github/${state}` };
      }),
    ),
  );

  const pending = Effect.fn("GitHub.pending")(function* (state: string) {
    const raw = yield* attempt("github.pending.read", () => storage.get("github:pending"));
    const value = yield* decode(Pending)(raw);

    if (value.state !== state || value.expires <= Date.now() || value.phase !== "pending")
      return yield* new OperationError({
        operation: "github.setup",
        message: "Setup link is invalid, expired or already used",
        details: null,
      });

    return value;
  });

  const manifest = Effect.fn("GitHub.manifest")(function* (state: string) {
    const value = yield* pending(state);
    const hook = yield* decode(WebhookUrl)(value.setup.ingress);

    const action =
      value.setup.ownerType === "organization"
        ? `https://github.com/organizations/${encodeURIComponent(value.setup.owner)}/settings/apps/new`
        : "https://github.com/settings/apps/new";

    return {
      action: `${action}?state=${encodeURIComponent(state)}`,
      manifest: {
        name: `Dolly ${state.slice(0, 8)}`,
        url: value.origin,
        public: true,
        redirect_url: `${value.origin}/api/setup/github/callback`,
        default_permissions: GITHUB_APP_GRANT_PERMISSIONS,
        default_events: ["issue_comment"],
        hook_attributes: { url: hook, active: true },
      },
    };
  });

  const complete = Effect.fn("GitHub.complete")((state: string, code: string) =>
    setupPermit.withPermit(
      Effect.gen(function* () {
        const value = yield* pending(state);
        yield* attempt("github.converting", () =>
          storage.put("github:pending", { ...value, phase: "converting" }),
        );

        const app = yield* api(
          `/app-manifests/${encodeURIComponent(code)}/conversions`,
          "",
          undefined,
          "POST",
        ).pipe(Effect.flatMap(decode(App)));

        if (app.owner.login.toLowerCase() !== value.setup.owner.toLowerCase())
          return yield* new OperationError({
            operation: "github.setup",
            message: "GitHub App owner does not match the selected account",
            details: null,
          });
        yield* jwt(app);
        yield* attempt("github.save", () =>
          storage.put({ "github:connected": { app }, "github:ingress": value.setup.ingress }),
        );
        publicToken = undefined;
        publicTokenRetry = 0;
        yield* attempt("github.pending.delete", () => storage.delete("github:pending"));

        return yield* status;
      }),
    ),
  );

  // Public reads use an App installation token narrowed to metadata:read, so they
  // count against the installation's rate limit instead of the shared anonymous
  // per-IP limit (which Workers exhaust, surfacing as HTTP 403/429). Metadata-only
  // tokens cannot read private contents, and every repository is additionally
  // confirmed public before data is returned. Without a usable App installation,
  // reads fall back to anonymous requests.
  let publicToken: { value: string; expires: number } | undefined;
  let publicTokenRetry = 0;
  const publicRepositories = new Map<string, number>();

  const publicReadToken = Effect.gen(function* () {
    if (publicToken && publicToken.expires > Date.now() + 300_000) return publicToken.value;

    if (publicTokenRetry > Date.now()) return "";
    const raw = yield* attempt("github.read", () => storage.get("github:connected"));

    if (raw === undefined) return "";
    const connected = yield* decode(Connected)(raw);
    const appToken = yield* jwt(connected.app);

    const installations = yield* api("/app/installations?per_page=1", appToken).pipe(
      Effect.flatMap(decode(Schema.Array(Schema.Struct({ id: Schema.Number })))),
    );

    if (installations.length === 0) return "";

    const result = yield* api(`/app/installations/${installations[0].id}/access_tokens`, appToken, {
      permissions: { metadata: "read" },
    }).pipe(Effect.flatMap(decode(Token)));

    const expires = yield* decode(Schema.Finite)(Date.parse(result.expires_at));

    if (expires <= Date.now()) return "";
    publicToken = { value: result.token, expires };

    return result.token;
  }).pipe(
    Effect.catch(() => Effect.succeed("")),
    Effect.tap((token) =>
      Effect.sync(() => {
        if (!token) publicTokenRetry = Date.now() + 60_000;
      }),
    ),
  );

  const notPublic = (repository: string) =>
    new OperationError({
      operation: "integration.response",
      message: "Provider returned HTTP 404",
      details: { status: 404, repository },
    });

  const publicApi = Effect.fn("GitHub.publicApi")(function* (repository: string, path: string) {
    const token = yield* publicReadToken;

    if (!token) return yield* api(path, "");
    const checked = publicRepositories.get(repository.toLowerCase());

    if (!checked || checked < Date.now()) {
      const repo = yield* api(`/repos/${repository}`, token).pipe(
        Effect.flatMap(decode(Schema.Struct({ private: Schema.Boolean }))),
      );

      if (repo.private) return yield* notPublic(repository);
      publicRepositories.set(repository.toLowerCase(), Date.now() + 600_000);
    }

    return yield* api(path, token);
  });

  // Only a confirmed-public repository is readable for unapproved owners. Approved
  // owners fall back to a full read token after a public 404.
  const readApi = Effect.fn("GitHub.readApi")((repository: string, path: string) =>
    publicApi(repository, path).pipe(
      Effect.catchTag("OperationError", (error) =>
        Effect.gen(function* () {
          const status = Schema.decodeUnknownOption(Schema.Struct({ status: Schema.Number }))(
            error.details,
          );

          if (
            Option.isNone(status) ||
            status.value.status !== 404 ||
            !(yield* accountAllowed(repository.split("/")[0]))
          )
            return yield* Effect.fail(error);

          const token = yield* tokenFor(yield* read(), repository, "read");

          return yield* api(path, token);
        }),
      ),
    ),
  );

  const execute = Effect.fn("GitHub.execute")(function* (
    input: typeof GitHubRequest.Type,
  ): Effect.fn.Return<typeof GitHubReply.Type, OperationError> {
    const op = input.operation;

    if (op.action === "read_file") {
      const path = `/repos/${op.repository}/contents/${op.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(op.ref)}`;

      const file = yield* readApi(op.repository, path).pipe(Effect.flatMap(decode(FileResponse)));

      if (file.size > 32_768 || file.content.replace(/\s/g, "").length > 43_692)
        return { ok: false, code: "file_too_large", message: "File exceeds 32 KiB" };

      const content = yield* attempt("github.file.decode", async () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          Uint8Array.from(atob(file.content.replace(/\s/g, "")), (char) => char.charCodeAt(0)),
        ),
      );

      return { ok: true, result: { kind: "file", path: file.path, sha: file.sha, content } };
    }

    if (op.action === "list_files") {
      const page = op.page ?? 1;
      // One directory level via the contents API: the recursive tree of a large
      // repository exceeds the 1 MiB provider response limit.
      const directory = (op.path ?? "").split("/").map(encodeURIComponent).join("/");

      const listing = yield* readApi(
        op.repository,
        `/repos/${op.repository}/contents/${directory}?ref=${encodeURIComponent(op.ref)}`,
      ).pipe(
        Effect.flatMap(
          decode(Schema.Union([DirectoryResponse, Schema.Struct({ type: Schema.String })])),
        ),
      );

      if (!Array.isArray(listing))
        return {
          ok: false,
          code: "not_a_directory",
          message: `${op.path} is not a directory; use read_file`,
        };

      const entries = listing.map((entry) =>
        entry.type === "dir" ? `${entry.path}/` : entry.path,
      );

      const start = (page - 1) * TREE_ENTRIES_PER_PAGE;

      return {
        ok: true,
        result: {
          kind: "files",
          data: {
            page,
            next_page: entries.length > start + TREE_ENTRIES_PER_PAGE ? page + 1 : null,
            total: entries.length,
            note: "Lists one directory level; directories end in / and can be listed in turn.",
            paths: entries.slice(start, start + TREE_ENTRIES_PER_PAGE),
          },
        },
      };
    }

    if (op.action === "read_pull_request") {
      const pull = yield* readApi(op.repository, `/repos/${op.repository}/pulls/${op.number}`).pipe(
        Effect.flatMap(decode(PullDetails)),
      );

      return {
        ok: true,
        result: {
          kind: "pull_request_details",
          data: {
            ...pull,
            author: pull.user?.login ?? null,
            user: undefined,
            base: { ref: pull.base.ref, sha: pull.base.sha },
            head: { ref: pull.head.ref, sha: pull.head.sha },
            labels: pull.labels.map((label) => label.name),
            requested_reviewers: pull.requested_reviewers.map((user) => user.login),
            body: truncate(pull.body ?? "", 16_384),
          },
        },
      };
    }

    if (op.action === "list_pull_request_files") {
      const page = op.page ?? 1;

      const files = yield* readApi(
        op.repository,
        `/repos/${op.repository}/pulls/${op.number}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
      ).pipe(Effect.flatMap(decode(Schema.Array(PullFile))));

      return {
        ok: true,
        result: {
          kind: "pull_request_files",
          data: {
            page,
            next_page: files.length === FILES_PER_PAGE ? page + 1 : null,
            note: "patch_truncated files exceeded the output budget; check out the head SHA in the sandbox to read them.",
            files: budgetPatches(files, 48_000),
          },
        },
      };
    }

    if (op.action === "list_pull_request_comments") {
      const page = op.page ?? 1;
      const query = `per_page=${COMMENTS_PER_PAGE}&page=${page}`;
      const root = `/repos/${op.repository}`;

      const [discussion, inline, reviews] = yield* Effect.all([
        readApi(op.repository, `${root}/issues/${op.number}/comments?${query}`).pipe(
          Effect.flatMap(decode(Schema.Array(IssueComment))),
        ),
        readApi(op.repository, `${root}/pulls/${op.number}/comments?${query}`).pipe(
          Effect.flatMap(decode(Schema.Array(InlineComment))),
        ),
        readApi(op.repository, `${root}/pulls/${op.number}/reviews?${query}`).pipe(
          Effect.flatMap(decode(Schema.Array(Review))),
        ),
      ]);

      const threads = new Map<number, Array<ThreadComment>>();

      for (const comment of inline) {
        const root = comment.in_reply_to_id ?? comment.id;
        const thread = threads.get(root) ?? [];
        thread.push({
          id: comment.id,
          author: comment.user?.login ?? null,
          body: truncate(comment.body, 4_096),
          path: comment.path,
          line: comment.line ?? null,
          start_line: comment.start_line ?? null,
          side: comment.side ?? null,
          outdated: comment.line === null,
          url: comment.html_url,
        });
        threads.set(root, thread);
      }

      const more = [discussion, inline, reviews].some((list) => list.length === COMMENTS_PER_PAGE);

      return {
        ok: true,
        result: {
          kind: "pull_request_comments",
          data: {
            page,
            next_page: more ? page + 1 : null,
            discussion: discussion.map((comment) => ({
              id: comment.id,
              author: comment.user?.login ?? null,
              body: truncate(comment.body ?? "", 4_096),
              url: comment.html_url,
            })),
            threads: [...threads].map(([id, comments]) => ({ id, comments })),
            reviews: reviews.map((review) => ({
              id: review.id,
              author: review.user?.login ?? null,
              state: review.state,
              body: truncate(review.body ?? "", 4_096),
              commit_id: review.commit_id ?? null,
            })),
          },
        },
      };
    }

    if (op.action === "read_pull_request_checks") {
      const root = `/repos/${op.repository}`;

      const pull = yield* readApi(op.repository, `${root}/pulls/${op.number}`).pipe(
        Effect.flatMap(decode(PullDetails)),
      );

      const [runs, status] = yield* Effect.all([
        readApi(op.repository, `${root}/commits/${pull.head.sha}/check-runs?per_page=100`).pipe(
          Effect.flatMap(decode(CheckRuns)),
        ),
        readApi(op.repository, `${root}/commits/${pull.head.sha}/status`).pipe(
          Effect.flatMap(decode(CombinedStatus)),
        ),
      ]);

      return {
        ok: true,
        result: {
          kind: "pull_request_checks",
          data: {
            head_sha: pull.head.sha,
            combined_state: status.state,
            check_runs: runs.check_runs,
            statuses: status.statuses,
          },
        },
      };
    }

    const connected = yield* read();

    if (op.action === "upload_screenshot") return yield* uploadScreenshot(op, connected);

    if (op.action === "create_review" || op.action === "reply_to_review_comment") {
      const token = yield* tokenFor(connected, op.repository, "write");
      const root = `/repos/${op.repository}/pulls/${op.number}`;

      if (op.action === "reply_to_review_comment") {
        const reply = yield* api(`${root}/comments/${op.comment_id}/replies`, token, {
          body: `${op.body}${REVIEW_FOOTER}`,
        }).pipe(Effect.flatMap(decode(InlineComment)));

        return {
          ok: true,
          result: { kind: "review_comment", data: { id: reply.id, url: reply.html_url } },
        };
      }

      const pull = yield* api(root, token).pipe(Effect.flatMap(decode(PullDetails)));

      if (pull.head.sha !== op.commit_id)
        return {
          ok: false,
          code: "stale_commit",
          message: `The pull request head is now ${pull.head.sha}, not ${op.commit_id}. Re-read the diff and anchor comments to the new head.`,
        };
      const patches = new Map<string, string | undefined>();

      for (let page = 1; page <= 3_000 / FILES_PER_PAGE; page++) {
        const files = yield* api(
          `${root}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
          token,
        ).pipe(Effect.flatMap(decode(Schema.Array(PullFile))));

        for (const file of files) patches.set(file.filename, file.patch);

        if (files.length < FILES_PER_PAGE) break;
      }

      const problems = invalidAnchors(op.comments, patches);

      if (problems.length > 0)
        return {
          ok: false,
          code: "invalid_comment_anchor",
          message: `No review was posted. Fix these comments: ${problems.join("; ")}`,
        };

      const request: Extract<GitHubBody, { commit_id: string }> = {
        commit_id: op.commit_id,
        body: op.body ? `${op.body}${REVIEW_FOOTER}` : "",
        comments: op.comments.map((comment) => ({
          ...comment,
          body: `${comment.body}${REVIEW_FOOTER}`,
        })),
      };

      // Omitting event leaves the review PENDING (unsubmitted) on GitHub.
      if (op.event === "COMMENT") request.event = "COMMENT";

      const review = yield* api(`${root}/reviews`, token, request, "POST").pipe(
        Effect.flatMap(decode(Review)),
      );

      return {
        ok: true,
        result: {
          kind: "review",
          data: {
            id: review.id,
            state: review.state,
            url: review.html_url ?? null,
            comments: op.comments.length,
          },
        },
      };
    }

    if (op.action === "repositories") {
      if ((yield* accounts).length === 0)
        return {
          ok: false,
          code: "accounts_unconfigured",
          message:
            "No GitHub repository accounts are allowed. In Settings → Accounts dolly can work in, add the GitHub user or organization that owns the repository. This is separate from installing the App or enrolling a repo.",
        };
      const available = yield* repositories();

      if (available.length === 0)
        return {
          ok: false,
          code: "no_repositories_discovered",
          message:
            "No App repositories were discovered in the allowed accounts. Check Settings → Add repositories and the App's selected repository grants. If this session already names a repository, try workspace checkout with that full owner/repository to get its actual access result rather than asking the user to identify it again.",
        };

      return {
        ok: true,
        result: {
          kind: "repositories",
          repositories: available.map((repo) => repo.fullName),
        },
      };
    }

    const repository = op.repository;
    const token = yield* tokenFor(connected, repository, "write");
    const root = `/repos/${repository}`;

    const info = yield* api(root, token).pipe(Effect.flatMap(decode(RepoResponse)));

    if (op.branch === info.default_branch)
      return {
        ok: false,
        code: "default_branch",
        message: "Writes to the default branch are forbidden",
      };

    switch (op.action) {
      case "create_branch": {
        const base = yield* api(`${root}/git/ref/heads/${encodeURIComponent(op.base)}`, token).pipe(
          Effect.flatMap(decode(RefResponse)),
        );

        const created = yield* api(`${root}/git/refs`, token, {
          ref: `refs/heads/${op.branch}`,
          sha: base.object.sha,
        }).pipe(Effect.flatMap(decode(RefResponse)));

        return { ok: true, result: { kind: "branch", name: op.branch, sha: created.object.sha } };
      }

      case "write_file": {
        if (op.path.toLowerCase().startsWith(".github/workflows/"))
          return {
            ok: false,
            code: "workflow_denied",
            message: "Workflow changes are not allowed through agent tools",
          };

        const content = Buffer.from(op.content, "utf8").toString("base64");

        const commit = yield* api(
          `${root}/contents/${op.path.split("/").map(encodeURIComponent).join("/")}`,
          token,
          {
            message: op.message,
            branch: op.branch,
            content,
            sha: op.sha,
          },
          "PUT",
        ).pipe(Effect.flatMap(decode(CommitResponse)));

        return { ok: true, result: { kind: "commit", sha: commit.commit.sha } };
      }

      case "open_pull_request": {
        const pull = yield* api(`${root}/pulls`, token, {
          head: op.branch,
          base: op.base,
          title: op.title,
          body: op.body,
        }).pipe(Effect.flatMap(decode(PullResponse)));

        return {
          ok: true,
          result: { kind: "pull_request", number: pull.number, url: pull.html_url },
        };
      }
    }
  });

  const configureWebhook = Effect.fn("GitHub.configureWebhook")((input: typeof WebhookSetup.Type) =>
    setupPermit.withPermit(
      Effect.gen(function* () {
        const connected = yield* read();
        const previous = yield* attempt("github.webhook.read", () => storage.get("github:webhook"));
        const saved = previous === undefined ? undefined : yield* decode(WebhookProfile)(previous);
        const secret = input.secret ?? saved?.secret ?? connected.app.webhook_secret;
        const webhookUrl = yield* ingress;

        if (!secret || !webhookUrl)
          return yield* new OperationError({
            operation: "github.webhook.setup",
            message: "Set the ingress URL and a GitHub webhook secret first",
            details: null,
          });

        const token = yield* jwt(connected.app);

        const app = yield* api("/app", token).pipe(
          Effect.flatMap(
            decode(
              Schema.Struct({
                permissions: Schema.Struct({ issues: Schema.optional(Schema.String) }),
                events: Schema.Array(Schema.String),
              }),
            ),
          ),
        );

        if (
          !["read", "write"].includes(app.permissions.issues ?? "") ||
          !app.events.includes("issue_comment")
        )
          return yield* new OperationError({
            operation: "github.webhook.permissions",
            message:
              "Enable Issues read permission and Issue comments events in GitHub App settings, then approve installation changes",
            details: null,
          });

        yield* attempt("github.webhook.save", () =>
          storage.put("github:webhook", { secret, senders: input.senders }),
        );

        return { configured: true, url: webhookUrl, senders: input.senders };
      }),
    ),
  );

  const receiveWebhook = Effect.fn("GitHub.receiveWebhook")(function* (
    body: ArrayBuffer,
    signature: string,
    event: string,
  ) {
    const raw = yield* attempt("github.webhook.read", () => storage.get("github:webhook"));

    if (raw === undefined) return { status: 503 as const };
    const profile = yield* decode(WebhookProfile)(raw);

    const verified = yield* verifyWebhook(profile, body, signature, event);

    if (verified.status !== 202) return verified;

    if (!(yield* accountAllowed(verified.event.repository.split("/")[0])))
      return { status: 403 as const };
    const connected = yield* read();

    const installation = yield* api(
      `/repos/${verified.event.repository}/installation`,
      yield* jwt(connected.app),
    ).pipe(
      Effect.flatMap(decode(Schema.Struct({ id: Schema.Number }))),
      Effect.catchTag("OperationError", (error) => {
        const status = Schema.decodeUnknownOption(Schema.Struct({ status: Schema.Number }))(
          error.details,
        );

        if (Option.isSome(status) && status.value.status === 404) return Effect.succeed(null);

        return Effect.fail(error);
      }),
    );

    if (!installation || installation.id !== verified.event.installationId)
      return { status: 403 as const };

    return verified;
  });

  const reply = Effect.fn("GitHub.reply")(function* (event: typeof GitHubEvent.Type, text: string) {
    const connected = yield* read();

    const token = yield* tokenFor(connected, event.repository, "write");
    const root = `/repos/${event.repository}/issues/${event.number}/comments`;
    const marker = `<!-- dolly:comment:${event.commentId} -->`;

    for (let page = 1; ; page++) {
      const comments = yield* api(`${root}?per_page=100&page=${page}`, token).pipe(
        Effect.flatMap(
          decode(
            Schema.Array(
              Schema.Struct({ body: Schema.String, user: Schema.Struct({ login: Schema.String }) }),
            ),
          ),
        ),
      );

      if (
        comments.some(
          (comment) =>
            comment.user.login === `${connected.app.slug}[bot]` && comment.body.endsWith(marker),
        )
      )
        return;

      if (comments.length < 100) {
        yield* api(root, token, { body: `${text.slice(0, 16_384)}\n\n${marker}` });

        return;
      }
    }
  });

  const authorize = Effect.fn("GitHub.authorize")(function* (repository: string, write: boolean) {
    const connected = yield* read();
    const token = yield* tokenFor(connected, repository, write ? "code" : "read");

    const info = yield* api(`/repos/${repository}`, token).pipe(
      Effect.flatMap(decode(RepoResponse)),
    );

    return { token, defaultBranch: info.default_branch };
  });

  const pullRequestState = Effect.fn("GitHub.pullRequestState")(function* (
    repository: string,
    number: number,
  ) {
    const connected = yield* read();
    const token = yield* tokenFor(connected, repository, "read");

    const pull = yield* api(`/repos/${repository}/pulls/${number}`, token).pipe(
      Effect.flatMap(decode(PullStateResponse)),
    );

    if (pull.merged || pull.merged_at) return "merged" as const;

    if (pull.state === "closed") return "closed" as const;

    return pull.draft ? ("draft" as const) : ("open" as const);
  });

  return {
    status,
    clientId,
    pullRequestState,
    configureIngress,
    accounts,
    configureAccounts,
    enrolledRepositories,
    availableRepositories,
    enrollRepository,
    removeRepository,
    resolveRepository,
    start,
    manifest,
    complete,
    execute,
    configureWebhook,
    receiveWebhook,
    reply,
    authorize,
  };
}

export class GitHub extends Context.Service<GitHub, ReturnType<typeof makeGitHub>>()(
  "dolly/GitHub",
) {
  static readonly layer = (
    storage: DurableObjectStorage,
    images: Pick<Env, "SCREENSHOTS" | "PR_SCREENSHOTS" | "PR_SCREENSHOTS_URL">,
  ) => Layer.succeed(GitHub, makeGitHub(storage, images));
}
