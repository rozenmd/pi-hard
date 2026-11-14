import { defineDoc } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import { Repository } from "./github-contracts";

export const WorkspaceInput = Schema.Struct({
  repository: Repository,
  ref: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(200),
      Schema.isPattern(/^[^\p{Cc}]+$/u),
    ),
  ),
  networkHosts: Schema.optional(
    Schema.Array(
      Schema.String.check(
        Schema.isPattern(/^(?=.{1,253}$)(?=.*[a-zA-Z])[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/),
      ),
    ),
  ),
});

export type WorkspaceConfig = Omit<typeof WorkspaceInput.Type, "networkHosts" | "ref"> & {
  branch: string;
  ref: string;
  networkHosts: string[];
};

export function workspaceConfig(input: typeof WorkspaceInput.Type, id: string): WorkspaceConfig {
  return {
    repository: input.repository,
    ref: input.ref ?? "HEAD",
    networkHosts: Array.from(input.networkHosts ?? []),
    branch: `dolly/session-${id}`,
  };
}

/** The primary repository stays fixed; additional repositories have isolated checkouts. */
export type WorkspaceState = {
  config: WorkspaceConfig | null;
  attached?: WorkspaceConfig[];
  activeRepository?: string;
};

export const ConversationWorkspace = defineDoc<WorkspaceState>({
  kind: "app.workspace",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ config: null }),
  checkpointWhen: () => false,
});

export const WorkspaceRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("repositories") }),
  Schema.Struct({ action: Schema.Literal("diagnostics") }),
  Schema.Struct({
    action: Schema.Literal("restart"),
    discardUncheckpointed: Schema.Literal(true),
  }),
  Schema.Struct({
    action: Schema.Literals(["checkout", "attach"]),
    repository: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(201)),
    ref: WorkspaceInput.fields.ref,
  }),
  Schema.Struct({ action: Schema.Literal("status") }),
  Schema.Struct({ action: Schema.Literal("wait_for_dependencies") }),
  Schema.Struct({ action: Schema.Literal("diff") }),
  Schema.Struct({
    action: Schema.Literal("commit"),
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  }),
  Schema.Struct({ action: Schema.Literal("push") }),
  Schema.Struct({
    action: Schema.Literal("open_pull_request"),
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    body: Schema.String.check(Schema.isMaxLength(32768)),
  }),
]);

// Providers need an object at the root, not a union whose properties are hidden in anyOf.
// Keep WorkspaceRequest as the stricter, action-specific execution validator.
export const WorkspaceToolInput = Schema.Struct({
  action: Schema.Literals([
    "repositories",
    "diagnostics",
    "restart",
    "checkout",
    "attach",
    "status",
    "wait_for_dependencies",
    "diff",
    "commit",
    "push",
    "open_pull_request",
  ]),
  repository: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(201))),
  ref: WorkspaceInput.fields.ref,
  message: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000))),
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(32768))),
  discardUncheckpointed: Schema.optional(Schema.Boolean),
});

/** Selecting a repository never reuses another repository's sandbox or resets a checkout. */
export function selectRepository(
  state: WorkspaceState,
  input: { action: "checkout" | "attach"; repository: string; ref?: string },
  id: string,
) {
  const existing = [state.config, ...(state.attached ?? [])].find(
    (item) => item?.repository.toLowerCase() === input.repository.toLowerCase(),
  );

  if (existing && input.ref && existing.ref !== input.ref)
    throw new Error(
      "This repository already has a checkout at another ref; switch without a ref to preserve its changes",
    );

  if (!existing) {
    const config = workspaceConfig(
      { ...input, networkHosts: state.config?.networkHosts ?? [] },
      id,
    );

    if (!state.config && input.action === "checkout") state.config = config;
    else (state.attached ??= []).push(config);
  }

  state.activeRepository = existing?.repository ?? input.repository;
}

export function activeWorkspace(state: WorkspaceState | null | undefined, id: string) {
  const config =
    state?.attached?.find((item) => item.repository === state.activeRepository) ?? state?.config;

  if (!config) return null;

  const sandboxId =
    config.repository === state?.config?.repository
      ? id
      : `${id}:repo:${config.repository.toLowerCase()}`;

  return { config, sandboxId };
}

/** Configuration is context for the model, not an access grant or a claim that checkout succeeded. */
export function workspacePrompt(state: WorkspaceState | null | undefined) {
  const active = activeWorkspace(state, "context")?.config;

  const selection = {
    primary: state?.config?.repository ?? null,
    active: active?.repository ?? null,
    ref: active?.ref ?? null,
    branch: active?.branch ?? null,
    attached: (state?.attached ?? []).map((repo) => ({
      repository: repo.repository,
      ref: repo.ref,
      branch: repo.branch,
    })),
  };

  return [
    "Repository selection for this session (configuration, not proof of GitHub access or a completed checkout):",
    JSON.stringify(selection),
    state?.config
      ? "When the user refers to this project or its short name, use the configured primary repository above; do not ask them which owner/repository it is. For a coding task, use workspace checkout with that full owner/repository to verify access and prepare or reuse its checkout. This does not reset existing changes."
      : "This session has no primary repository. Use workspace repositories to discover enrolled repos, then attach the one the user names. Ask only if the repository name is unknown or ambiguous.",
    "Shell and relative read_file operations use the active repo's /workspace/repo. Each attachment has its own sandbox. Use workspace attach to activate another repo without replacing the primary or losing changes.",
    "An empty repository discovery/enrolment list does not establish that a known selected repo is inaccessible. Try the selected repo directly with workspace checkout and report the actual authorization or checkout error. Do not treat repository selection as an authorization grant.",
    "If GitHub access is denied, explain the concrete configuration step from the tool result. Never claim that no repository access is available merely because discovery returned an empty list.",
  ].join("\n");
}

/** Values are passed as shell arguments, never interpreted as source. */
export const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export type WorkspaceSnapshot = { id: string; turnId?: string };

export type WorkspaceSetup = {
  state: "queued" | "checkout" | "installing" | "ready" | "warning" | "failed";
  updatedAt: number;
  error?: string;
};

/** Fixed, read-only diagnostics: never print environment, process arguments or user file contents. */
export const checkoutDiagnosticsScript = `set +e
printf '\\ncheckout phase\\n'
cat /workspace/checkout-phase
printf '\\nprocesses (no arguments)\\n'
ps -eo pid,ppid,stat,etime,comm
printf '\\nlock metadata (no contents)\\n'
stat /workspace/repo/.git/index.lock
printf '\\nworkspace metadata\\n'
stat /workspace/ready /workspace/repo /workspace/repo/.git
exit 0`;

export function checkoutScript(config: WorkspaceConfig) {
  const remote = shellQuote(`http://github.workspace/${config.repository}.git`);

  return `sh /usr/local/lib/dolly-checkout.sh ${remote} ${shellQuote(config.ref)} ${shellQuote(config.branch)}`;
}
