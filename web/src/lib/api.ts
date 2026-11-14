import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Block, Message, Snapshot, Live, type RunFailure } from "../../../src/transcript";

export { Snapshot } from "../../../src/transcript";

export function liveFromSnapshot(snapshot: typeof Snapshot.Type) {
  return Option.getOrNull(Schema.decodeUnknownOption(Live)(snapshot.docs["pi.live"]));
}

const QueuedInput = Schema.Struct({
  id: Schema.Number,
  mode: Schema.Literals(["followUp", "steer"]),
  content: Schema.Union([Schema.String, Schema.Array(Block)]),
});

export type QueuedMessage = { id: number; text: string; steering: boolean };

export function queueFromSnapshot(snapshot: typeof Snapshot.Type): QueuedMessage[] {
  const inbox = Schema.decodeUnknownOption(Schema.Struct({ items: Schema.Array(Schema.Unknown) }))(
    snapshot.docs["pi.inbox"],
  );

  if (Option.isNone(inbox)) return [];

  return inbox.value.items.flatMap((item) => {
    const input = Schema.decodeUnknownOption(QueuedInput)(item);

    if (Option.isNone(input)) return [];

    return [
      {
        id: input.value.id,
        text: messageText({ role: "user", content: input.value.content }),
        steering: input.value.mode === "steer",
      },
    ];
  });
}

export const Session = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  thinkingLevel: Schema.optional(Schema.String),
});

export { SavedSession } from "../../../src/session-contracts";

import { SavedSession } from "../../../src/session-contracts";

const WorkspaceSelection = Schema.Struct({
  repository: Schema.String,
  ref: Schema.optional(Schema.String),
  networkHosts: Schema.optional(Schema.Array(Schema.String)),
});

export function sessionBody(source: SavedSession, snapshot: typeof Snapshot.Type | null): ApiBody {
  const body: ApiBody = {};

  if (source.model !== "Existing session") body.model = source.model;

  if (source.thinkingLevel) body.thinkingLevel = source.thinkingLevel;
  const state = snapshot?.docs["app.workspace"];

  if (state !== undefined) {
    const context = Schema.decodeUnknownOption(
      Schema.Struct({ config: Schema.NullOr(WorkspaceSelection) }),
    )(state);

    if (Option.isSome(context)) {
      if (context.value.config) body.workspace = context.value.config;

      return body;
    }
  }

  if (source.repository) {
    body.workspace = { repository: source.repository };

    if (source.ref) body.workspace.ref = source.ref;
  }

  return body;
}

export type Step = {
  id: string;
  name: string;
  detail: string;
  output: string;
  images?: string[];
  status: "pending" | "running" | "done" | "error";
};

export type TurnItem =
  | { kind: "text"; id: string; text: string }
  | { kind: "steps"; id: string; steps: Step[] };

export type Turn = {
  id: string;
  prompt?: { text: string; at?: number; images?: number };
  items: TurnItem[];
  answer?: { id: string; text: string };
  steps: number;
  startedAt?: number;
  endedAt?: number;
  running: boolean;
  activity?: string;
  failure?: typeof RunFailure.Type;
  retry?: { readonly at: number; readonly error: string };
};

function messageText(message: typeof Message.Type) {
  return Schema.is(Schema.String)(message.content)
    ? message.content
    : message.content.flatMap((block) => (block.text ? [block.text] : [])).join("\n\n");
}

const ToolArguments = Schema.Struct({
  command: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  file_path: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});

/** The most recognisable argument of a tool call, such as its command or file path. */
function stepDetail(block: typeof Block.Type) {
  const args = Option.getOrUndefined(Schema.decodeUnknownOption(ToolArguments)(block.arguments));

  return (
    args?.command ??
    args?.path ??
    args?.file_path ??
    args?.pattern ??
    args?.query ??
    args?.url ??
    ""
  );
}

/** Groups a flat Pi transcript into prompt/response turns, folding tool calls into steps. */
export function turnsFromSnapshot(snapshot: typeof Snapshot.Type): Turn[] {
  const turns: Turn[] = [];
  const calls = new Map<string, Step>();
  const entryTurns = new Map<number, Turn>();
  const live = liveFromSnapshot(snapshot);

  function current(id: string) {
    const last = turns.at(-1);

    if (last) return last;

    const turn: Turn = { id, items: [], steps: 0, running: false };
    turns.push(turn);

    return turn;
  }

  function addStep(turn: Turn, id: string, step: Step) {
    const last = turn.items.at(-1);

    if (last?.kind === "steps") last.steps.push(step);
    else turn.items.push({ kind: "steps", id, steps: [step] });

    turn.steps += 1;
    calls.set(step.id, step);
  }

  function touch(turn: Turn, at?: number) {
    if (at === undefined) return;

    turn.startedAt ??= at;
    turn.endedAt = at;
  }

  function add(message: typeof Message.Type, id: string) {
    if (message.role === "user") {
      const prompt: NonNullable<Turn["prompt"]> = {
        text: messageText(message),
        at: message.timestamp,
      };

      const images = Schema.is(Schema.String)(message.content)
        ? 0
        : message.content.filter((block) => block.type === "image").length;

      if (images) prompt.images = images;

      turns.push({
        id,
        prompt,
        items: [],
        steps: 0,
        running: false,
      });

      return;
    }

    // System/context entries are model input, not an assistant response.
    if (message.role !== "assistant" && message.role !== "toolResult") return;
    const turn = current(id);
    touch(turn, message.timestamp);

    if (
      message.role === "assistant" &&
      (message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage)
    ) {
      turn.failure = {
        reason: message.stopReason === "aborted" ? "aborted" : "model_error",
        detail: message.errorMessage || "The model response ended before completing an answer.",
      };
    } else if (message.role === "assistant") delete turn.failure;

    if (message.role === "toolResult") {
      const step = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      const output = messageText(message);
      const status = message.isError ? "error" : "done";

      const images = Schema.is(Schema.String)(message.content)
        ? []
        : message.content.flatMap((block) => {
            const match =
              block.type === "image" && block.data
                ? /^r2:\/\/screenshots\/(png|jpeg|gif|webp)\/([a-f0-9]{64})$/.exec(block.data)
                : null;

            return match ? [`/api/screenshots/${match[1]}/${match[2]}`] : [];
          });

      const imageOutput = images.length ? { images } : {};

      if (step) Object.assign(step, { output, status, ...imageOutput });
      else
        addStep(turn, id, {
          id: message.toolCallId ?? id,
          name: message.toolName ?? "tool",
          detail: "",
          output,
          status,
          ...imageOutput,
        });

      return;
    }

    if (Schema.is(Schema.String)(message.content)) {
      if (message.content) turn.items.push({ kind: "text", id, text: message.content });

      return;
    }

    for (const [index, block] of message.content.entries()) {
      const blockId = `${id}-${index}`;

      if (block.type === "toolCall" && block.name)
        addStep(turn, blockId, {
          id: block.id ?? blockId,
          name: block.name,
          detail: stepDetail(block),
          output: "",
          status: "running",
        });
      else if (block.text) {
        const last = turn.items.at(-1);

        if (last?.kind === "text") last.text += `\n\n${block.text}`;
        else turn.items.push({ kind: "text", id: blockId, text: block.text });
      }
    }
  }

  for (const entry of snapshot.entries) {
    for (const [index, message] of (entry.model ?? []).entries())
      add(message, `${entry.id}-${index}`);
    const turn = turns.at(-1);

    if (turn) entryTurns.set(entry.id, turn);
  }

  if (live?.generation?.message) add(live.generation.message, "live");

  for (const tool of live?.tools ?? []) {
    const step = calls.get(tool.callId);

    const status: Step["status"] =
      tool.status === "done" || tool.status === "error" || tool.status === "pending"
        ? tool.status
        : "running";

    if (step) Object.assign(step, { status, output: tool.output ?? step.output });
    else if (status !== "done")
      addStep(current("live"), `live-${tool.callId}`, {
        id: tool.callId,
        name: tool.name,
        detail: "",
        output: tool.output ?? "",
        status,
      });
  }

  const last = turns.at(-1);

  if (last && live?.run) {
    last.running = true;
    delete last.failure;

    const activeTool = live.tools?.find((tool) => tool.status === "running");
    const message = live.generation?.message;
    last.activity = activeTool
      ? `Running ${activeTool.name}`
      : message && messageText(message)
        ? "Responding"
        : live.generation
          ? "Thinking"
          : "Working";
  }

  if (last && live?.generation?.retry) last.retry = live.generation.retry;

  if (live?.runFailure) {
    const failure = live.runFailure;
    const failedTurn = failure.first === undefined ? undefined : entryTurns.get(failure.first);
    const target = failedTurn ?? (!live.run ? (last ?? current("failure")) : undefined);

    if (target) target.failure = failure;
  }

  for (const turn of turns) {
    const tail = turn.items.at(-1);

    if (!turn.running && !turn.failure && tail?.kind === "text") {
      turn.items.pop();
      turn.answer = { id: tail.id, text: tail.text };
    }

    if (!turn.running)
      for (const item of turn.items)
        if (item.kind === "steps")
          for (const step of item.steps)
            if (step.status === "running" || step.status === "pending") step.status = "done";
  }

  return turns;
}

export type ApiBody = {
  sessions?: readonly SavedSession[];
  archived?: boolean;
  content?: string;
  requestId?: string;
  images?: readonly { mimeType: string; data: string }[];
  model?: string;
  thinkingLevel?: string;
  workspace?: { repository: string; ref?: string; networkHosts?: readonly string[] };
  repository?: string;
  owner?: string;
  ownerType?: "personal" | "organization";
  ingress?: string;
  url?: string;
  accounts?: readonly string[];
  senders?: readonly string[];
  token?: string;
};

export async function anthropicStatus() {
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ connected: Schema.Boolean })),
  )(await request("/auth/anthropic"));
}

export const CodexStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literals(["connected", "not_connected", "expired"]) }),
  Schema.Struct({
    state: Schema.Literal("awaiting_code"),
    verificationUri: Schema.String,
    userCode: Schema.String,
    expiresAt: Schema.Number,
    pollAfterSeconds: Schema.Number,
  }),
]);

export type CodexStatus = typeof CodexStatus.Type;

/** Reads, starts (POST) or cancels and signs out of (DELETE) the ChatGPT device login. */
export async function codexLogin(method: "GET" | "POST" | "DELETE" = "GET") {
  const text = await request("/auth/codex", undefined, undefined, method);

  return Schema.decodeUnknownSync(Schema.fromJsonString(CodexStatus))(text);
}

const GitHubApp = Schema.Union([
  Schema.Struct({ connected: Schema.Literal(false) }),
  Schema.Struct({
    connected: Schema.Literal(true),
    owner: Schema.String,
    appSlug: Schema.String,
    installUrl: Schema.String,
    settingsUrl: Schema.String,
    ingress: Schema.NullOr(Schema.String),
    senders: Schema.Array(Schema.String),
  }),
]);

export const AuthState = Schema.Struct({
  github: GitHubApp,
  ownerClaimed: Schema.Boolean,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});

export type AuthState = typeof AuthState.Type;

/** Whether a GitHub App exists, whether dolly has an owner, and who this browser is signed in as. */
export async function authState() {
  return Schema.decodeUnknownSync(Schema.fromJsonString(AuthState))(await request("/auth"));
}

export const GitHubSignIn = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("awaiting_code"),
    verificationUri: Schema.String,
    userCode: Schema.String,
    expiresAt: Schema.Number,
    pollAfterSeconds: Schema.Number,
  }),
  Schema.Struct({ state: Schema.Literal("expired") }),
  Schema.Struct({ state: Schema.Literal("signed_in"), login: Schema.String }),
]);

export type GitHubSignIn = typeof GitHubSignIn.Type;

/** Starts (POST) or checks (GET) this browser's GitHub device sign-in. */
export async function githubSignIn(method: "GET" | "POST" = "GET") {
  const text = await request("/auth/github", undefined, undefined, method);

  return Schema.decodeUnknownSync(Schema.fromJsonString(GitHubSignIn))(text);
}

/** A failed API call, keeping the HTTP status so callers can tell a refusal from an outage. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function request(
  path: string,
  body?: ApiBody,
  signal?: AbortSignal,
  method: "GET" | "POST" | "PUT" | "DELETE" = body ? "POST" : "GET",
) {
  const headers = new Headers();

  if (body) headers.set("Content-Type", "application/json");

  const init: RequestInit = {
    method,
    headers,
    signal,
    credentials: "same-origin",
    redirect: "error",
  };

  if (body) init.body = JSON.stringify(body);

  const response = await fetch(`/api${path}`, init);

  const text = await response.text();

  if (response.ok && !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("The API did not return JSON. Check that /api routes to the dolly Worker.");
  }

  if (!response.ok) {
    const error = Schema.decodeUnknownOption(
      Schema.fromJsonString(
        Schema.Union([
          Schema.Struct({ error: Schema.String }),
          Schema.Struct({ message: Schema.String }),
        ]),
      ),
    )(text).pipe(Option.map((value) => ("error" in value ? value.error : value.message)));

    throw new RequestError(
      Option.getOrElse(error, () => `Request failed (${response.status}). Check your connection.`),
      response.status,
    );
  }

  return text;
}

export function readSessions(value: string): readonly SavedSession[] {
  const result = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(SavedSession)))(
    value,
  );

  return Option.getOrElse(result, () => []);
}

const UsageWindow = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.Finite,
  resetsAt: Schema.NullOr(Schema.Finite),
});

const UsageReport = Schema.Struct({
  providerId: Schema.Literals(["openai-codex", "anthropic"]),
  connected: Schema.Boolean,
  usage: Schema.NullOr(
    Schema.Struct({
      windows: Schema.Array(UsageWindow),
      observedAt: Schema.Finite,
      source: Schema.Literals(["live", "headers"]),
    }),
  ),
  error: Schema.optional(Schema.String),
});

export type UsageReport = typeof UsageReport.Type;

/** Subscription limits per provider; `refresh` asks each provider for current numbers. */
export async function usage(refresh = false) {
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ providers: Schema.Array(UsageReport) })),
  )(await request(refresh ? "/usage?refresh=1" : "/usage")).providers;
}
