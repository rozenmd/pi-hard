import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Schema from "effect/Schema";
import type { ConversationId, Cursor, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { ConversationWorkspace } from "./workspace";
import { redact } from "./diagnostics";
import type { SavedSession } from "./session-contracts";
import { indexSession } from "./coordination";

type PullRequestRef = { repository: string; number: number; url: string };

const PULL_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const PULL_SCAN_LIMIT = 500;

/** Find the newest pull request opened by the github or workspace tool in a transcript page. */
function findPullRequest(entries: readonly EntryRecord[]): PullRequestRef | undefined {
  for (const entry of entries) {
    for (const message of [...(entry.model ?? [])].reverse()) {
      if (message.role !== "toolResult" || message.isError) continue;

      if (message.toolName !== "github" && message.toolName !== "workspace") continue;

      for (const block of message.content) {
        if (block.type !== "text" || !block.text.includes('"pull_request"')) continue;
        const match = PULL_URL.exec(block.text);

        if (match?.[1] && match[2])
          return { repository: match[1], number: Number(match[2]), url: match[0] };
      }
    }
  }
}

/** Newest timestamp of a human-authored message in a transcript page. */
function lastPromptAt(entries: readonly EntryRecord[]): number {
  return entries.reduce(
    (time, entry) =>
      Math.max(
        time,
        ...(entry.model ?? [])
          .filter((message) => message.role === "user")
          .map((message) => message.timestamp ?? 0),
      ),
    0,
  );
}

const LIVE_STATUSES = ["running", "waiting", "sleeping"] as const;

type Metadata = { archived: boolean; createdAt?: number };

/** Discover history, not just sessions created after this feature was deployed. */
export async function listSessions(
  harness: Harness,
  storage: DurableObjectStorage,
  secrets: readonly string[],
): Promise<SavedSession[]> {
  const aliases = new Map<ConversationId, string>();
  let start: string | undefined;

  do {
    const page = await storage.list<ConversationId>({
      prefix: "session:",
      startAfter: start,
      limit: 1000,
    });

    for (const [key, id] of page) aliases.set(id, key.slice("session:".length));
    start = page.size === 1000 ? [...page.keys()].at(-1) : undefined;
  } while (start);

  const sessions: SavedSession[] = [];
  let cursor: Cursor | undefined;

  do {
    const page = await harness.commit(async (tx) => {
      const page = await tx.scanConversations({}, 100, cursor);

      // Make discovered pre-index conversations openable by their canonical ID too.
      const running = new Set<ConversationId>();

      for (const record of page.items) {
        await indexSession(tx, record.id);

        for (const status of LIVE_STATUSES) {
          const tasks = await tx.scanTasks(
            { conversationId: record.id, status, background: false },
            1,
          );

          if (tasks.items.length) {
            running.add(record.id);
            break;
          }
        }
      }

      return { ...page, running };
    }, BACKGROUND_CONTEXT);

    for (const record of page.items) {
      const conversation = await harness.conversation(record.id, BACKGROUND_CONTEXT);

      if (!conversation) continue;

      const [agent, workspace, metadata, latest, savedPull, createdPull] = await Promise.all([
        conversation.agent(BACKGROUND_CONTEXT),
        harness.snapshot(ConversationWorkspace, record.id, BACKGROUND_CONTEXT),
        storage.get<Metadata>(`session-meta:${record.id}`),
        conversation.entries({ order: "descending" }, 50, undefined, BACKGROUND_CONTEXT),
        storage.get<PullRequestRef & { seen: string }>(`session-pr:${record.id}`),
        storage.get<PullRequestRef>(`session-created-pr:${record.id}`),
      ]);

      // Newest first; stop at the cached result so old transcripts are scanned once.
      let pullRequest = createdPull ?? findPullRequest(latest.items);
      const newest = latest.items[0] ? String(latest.items[0].id) : "";

      if (!pullRequest && savedPull?.seen !== newest) {
        let older = latest.next;
        let scanned = latest.items.length;

        while (!pullRequest && older && scanned < PULL_SCAN_LIMIT) {
          const entries = await conversation.entries(
            { order: "descending" },
            50,
            older,
            BACKGROUND_CONTEXT,
          );

          if (savedPull && entries.items.some((entry) => String(entry.id) === savedPull.seen))
            break;
          pullRequest = findPullRequest(entries.items);
          scanned += entries.items.length;
          older = entries.next;
        }
      }

      pullRequest ??= savedPull?.url
        ? { repository: savedPull.repository, number: savedPull.number, url: savedPull.url }
        : undefined;

      if (savedPull?.seen !== newest || savedPull?.url !== pullRequest?.url)
        await storage.put(`session-pr:${record.id}`, { ...pullRequest, seen: newest });

      let title = "";
      let history: Cursor | undefined;

      // The first prompt may be outside the recent transcript window.
      do {
        const entries = await conversation.entries(
          { order: "ascending" },
          50,
          history,
          BACKGROUND_CONTEXT,
        );

        for (const entry of entries.items) {
          const prompt = entry.model?.find((message) => message.role === "user");

          if (!prompt) continue;

          const text = Schema.is(Schema.String)(prompt.content)
            ? prompt.content
            : prompt.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n");

          title = text.trim().split("\n")[0]?.slice(0, 80) ?? "";

          if (title) break;
        }

        history = entries.next;
      } while (!title && history);

      // Order by the last human prompt so agent activity does not reshuffle the list.
      let updatedAt = lastPromptAt(latest.items);
      let older = latest.next;
      let scanned = latest.items.length;

      while (!updatedAt && older && scanned < PULL_SCAN_LIMIT) {
        const entries = await conversation.entries(
          { order: "descending" },
          50,
          older,
          BACKGROUND_CONTEXT,
        );

        updatedAt = lastPromptAt(entries.items);
        scanned += entries.items.length;
        older = entries.next;
      }

      updatedAt = Math.max(updatedAt, metadata?.createdAt ?? 0);

      sessions.push({
        id: aliases.get(record.id) ?? String(record.id),
        model: agent.model?.modelId ?? "Existing session",
        thinkingLevel: agent.thinkingLevel,
        title: redact(title || "Untitled session", secrets),
        repository: workspace?.config?.repository ?? "",
        ref: workspace?.config?.ref,
        updatedAt,
        archived: metadata?.archived ?? false,
        running: page.running.has(record.id),
        pullRequest,
      });
    }

    cursor = page.next;
  } while (cursor);

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
