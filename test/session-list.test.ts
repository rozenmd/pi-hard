import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SessionIndex } from "../src/coordination";
import { ConversationWorkspace, workspaceConfig } from "../src/workspace";
import type { SavedSession } from "../src/session-contracts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { headers, signIn } from "./session";

beforeEach(async () => {
  await reset();
  await signIn();
});

afterEach(() => vi.restoreAllMocks());

async function list() {
  const response = await SELF.fetch("https://worker/api/sessions", { headers });
  expect(response.status).toBe(200);

  return response.json<SavedSession[]>();
}

async function seed() {
  return runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const harness = agent["harness"];

    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );

    await state.storage.put("session:legacy-id", conversation.id);
    await harness.commit(async (tx) => {
      const workspace = await tx.doc(ConversationWorkspace, conversation.id);
      workspace.config = workspaceConfig(
        { repository: "octocat/project", ref: "main" },
        String(conversation.id),
      );
      // Simulate a deployment predating the coordination index.
      (await tx.doc(SessionIndex)).ids = {};
      await tx.appendEntry(conversation.id, {
        kind: "pi.input",
        model: [{ role: "user", content: "Fix mobile discovery\nMore details", timestamp: 100 }],
      });

      for (let i = 0; i < 60; i++) {
        await tx.appendEntry(conversation.id, {
          kind: "pi.input",
          model: [{ role: "user", content: "Later task", timestamp: 200 + i }],
        });
      }
    }, BACKGROUND_CONTEXT);

    return String(conversation.id);
  });
}

it("discovers legacy sessions without browser storage and retains their public IDs after restart", async () => {
  await seed();

  const expected = [
    {
      id: "legacy-id",
      title: "Fix mobile discovery",
      model: "gpt-6-luna",
      thinkingLevel: "low",
      repository: "octocat/project",
      ref: "main",
      updatedAt: 259,
      archived: false,
      running: false,
    },
  ];

  expect(await list()).toEqual(expected);
  await abortAllDurableObjects();
  expect(await list()).toEqual(expected);
});

it("paginates historical conversations and includes sessions without browser aliases", async () => {
  const ids = await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    const ids: string[] = [];

    for (let i = 0; i < 101; i++) {
      const conversation = await agent["harness"].createConversation(
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT,
      );

      ids.push(String(conversation.id));
    }

    await agent["harness"].commit(async (tx) => {
      (await tx.doc(SessionIndex)).ids = {};
    }, BACKGROUND_CONTEXT);

    return ids;
  });

  const sessions = await list();
  expect(sessions).toHaveLength(101);
  expect(new Set(sessions.map((session) => session.id))).toEqual(new Set(ids));
  expect((await SELF.fetch(`https://worker/api/sessions/${ids[0]}`, { headers })).status).toBe(200);
});

it("migrates browser archive state once and shares later archive changes with every device", async () => {
  await seed();

  const imported = (archived: boolean) =>
    SELF.fetch("https://worker/api/sessions/import", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessions: [
          {
            id: "legacy-id",
            model: "Existing session",
            title: "Local title",
            repository: "",
            updatedAt: 50,
            archived,
          },
        ],
      }),
    });

  expect((await imported(true)).status).toBe(200);
  expect((await list())[0].archived).toBe(true);

  const restore = await SELF.fetch("https://worker/api/sessions/legacy-id", {
    method: "PUT",
    headers,
    body: JSON.stringify({ archived: false }),
  });

  expect(restore.status).toBe(200);
  await imported(true);
  await abortAllDurableObjects();
  expect((await list())[0].archived).toBe(false);
  expect(
    (
      await SELF.fetch("https://worker/api/sessions/missing", {
        method: "PUT",
        headers,
        body: JSON.stringify({ archived: true }),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await SELF.fetch("https://worker/api/sessions/legacy-id", {
        method: "PUT",
        headers,
        body: JSON.stringify({ archived: "yes" }),
      })
    ).status,
  ).toBe(400);
});

it("reports a pull request opened deep in the transcript and remembers it after restart", async () => {
  await seed();

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const conversation = await state.storage.get<ConversationId>("session:legacy-id");
    expect(conversation).toBeDefined();

    await agent["harness"].commit(async (tx) => {
      await tx.appendEntry(conversation!, {
        kind: "pi.tool",
        model: [
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "workspace",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  result: {
                    kind: "pull_request",
                    number: 42,
                    url: "https://github.com/octocat/project/pull/42",
                  },
                }),
              },
            ],
            isError: false,
            timestamp: 300,
          },
        ],
      });

      // Push the result outside the newest page.
      for (let i = 0; i < 80; i++) {
        await tx.appendEntry(conversation!, {
          kind: "pi.input",
          model: [{ role: "user", content: "Follow-up", timestamp: 400 + i }],
        });
      }
    }, BACKGROUND_CONTEXT);
  });

  const pullRequest = {
    repository: "octocat/project",
    number: 42,
    url: "https://github.com/octocat/project/pull/42",
  };

  // GitHub is not connected in tests, so state is unknown rather than an error.
  expect((await list())[0].pullRequest).toEqual(pullRequest);
  await abortAllDurableObjects();
  expect((await list())[0].pullRequest).toEqual(pullRequest);
});

it("marks sessions with an in-flight agent turn as running", async () => {
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai-codex", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });

  let release!: () => void;

  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const model = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    await blocked;

    return Response.json({ error: { message: "Model unavailable" } }, { status: 400 });
  });

  const created = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const { id } = await created.json<{ id: string }>();
  const idle = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const other = (await idle.json<{ id: string }>()).id;

  const sent = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "Work on this", requestId: crypto.randomUUID() }),
  });

  expect(sent.status).toBe(202);
  await expect.poll(() => model.mock.calls.length).toBeGreaterThan(0);

  const running = await list();
  expect(running.find((session) => session.id === id)?.running).toBe(true);
  expect(running.find((session) => session.id === other)?.running).toBe(false);

  release();
  await expect
    .poll(async () => (await list()).find((session) => session.id === id)?.running)
    .toBe(false);
});
