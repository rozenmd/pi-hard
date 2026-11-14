import * as Schema from "effect/Schema";

export const SavedSession = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  /** Pi thinking level; absent for sessions saved before it was reported. */
  thinkingLevel: Schema.optional(Schema.String),
  title: Schema.String,
  repository: Schema.String,
  updatedAt: Schema.Number,
  archived: Schema.optional(Schema.Boolean),
  ref: Schema.optional(Schema.String),
  /** The agent has live, non-background work in progress. */
  running: Schema.optional(Schema.Boolean),
  /** The latest pull request this session opened, with its GitHub state when known. */
  pullRequest: Schema.optional(
    Schema.Struct({
      repository: Schema.String,
      number: Schema.Number,
      url: Schema.String,
      state: Schema.optional(Schema.Literals(["open", "draft", "merged", "closed"])),
    }),
  ),
});

export type PullRequestState = "open" | "draft" | "merged" | "closed";

export type SavedSession = typeof SavedSession.Type;
