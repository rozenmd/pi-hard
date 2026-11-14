import { Buffer } from "node:buffer";
import { zstdDecompressSync } from "node:zlib";
import { env } from "cloudflare:workers";
import { SELF, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vite-plus/test";
import { headers, signIn } from "../session";
import { workspaceConfig, type WorkspaceSnapshot } from "../../src/workspace";
import * as Effect from "effect/Effect";
import { OperationError } from "../../src/operations";

it("saves once after an agent turn, restores local work, and retains the previous save on failure", async () => {
  const remoteName = crypto.randomUUID();
  const remote = env.SANDBOX.getByName(remoteName);

  expect(await remote.skills()).toEqual({ status: "unavailable" });

  const seeded = await remote.run(`set -eu
mkdir -p remotes/another-owner
 git init --bare remotes/another-owner/project.git
 git --git-dir=remotes/another-owner/project.git config http.receivepack true
 git --git-dir=remotes/another-owner/project.git config uploadpack.allowFilter true
 git --git-dir=remotes/another-owner/project.git config uploadpack.allowAnySHA1InWant true
 git --git-dir=remotes/another-owner/project.git symbolic-ref HEAD refs/heads/main
 git init -b main seed
 cd seed
 git config user.name Fixture
  git config user.email fixture@example.com
  printf 'export const answer = 1;\n' > answer.mjs
  mkdir -p .agents/skills/verify
  printf '%s\\n' 'echo started > /workspace/setup-started' 'for i in $(seq 1 120); do' '  if test -f /workspace/setup-release; then echo finished > /workspace/setup-finished; exit 0; fi' '  sleep 0.1' 'done' 'exit 19' > .agents/setup
  printf '%s\\n' '---' 'name: verify' 'description: Fixture repository verification' '---' 'Fixture full skill instructions' > .agents/skills/verify/SKILL.md
  git add . && git commit -m initial
 git push ../remotes/another-owner/project.git HEAD:main`);

  expect(seeded.exitCode).toBe(0);

  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  if (!("privateKey" in pair)) throw new Error("Expected RSA keys");
  const key = await crypto.subtle.exportKey("pkcs8", pair.privateKey);

  if (!(key instanceof ArrayBuffer)) throw new Error("Expected PKCS8 key");
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(key).toString("base64")}\n-----END PRIVATE KEY-----`;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("github:accounts", ["another-owner"]);
    await state.storage.put("github:connected", {
      app: { id: 42, slug: "fixture", pem, owner: { login: "different-app-owner" } },
    });
    await state.storage.put("credential:openai-codex", {
      type: "oauth",
      access: `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }))}.signature`,
      refresh: "fixture-refresh",
      expires: Date.now() + 3600000,
    });
  });

  const calls = [
    {
      name: "workspace",
      input: { action: "checkout", repository: "another-owner/project", ref: "main" },
    },
    {
      name: "read_file",
      input: { path: ".agents/skills/verify/SKILL.md" },
    },
    {
      name: "shell",
      input: {
        command: `set -eu; while ! test -f /workspace/setup-started; do sleep 0.1; done; test ! -f /workspace/setup-finished; touch /workspace/setup-release; printf 'export const answer = 2;\n' > answer.mjs; printf "import { answer } from './answer.mjs'; if (answer !== 2) throw Error('wrong answer');\\n" > test.mjs; node --test test.mjs`,
      },
    },
    { name: "workspace", input: { action: "wait_for_dependencies" } },
    { name: "workspace", input: { action: "status" } },
    { name: "workspace", input: { action: "diff" } },
    { name: "workspace", input: { action: "commit", message: "Fix answer" } },
    { name: "workspace", input: { action: "push" } },
    {
      name: "workspace",
      input: { action: "open_pull_request", title: "Fix answer", body: "Tests passed" },
    },
  ];

  let generation = 0;
  let opened = false;
  let workingSandboxId: string | undefined;
  let expectedCheckpoint: WorkspaceSnapshot | undefined;

  const originalFetch = globalThis.fetch;

  const mocked = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.hostname === "registry.npmjs.org" || url.hostname === "registry.yarnpkg.com")
      if (url.pathname.startsWith("/dolly-fixture.git/")) {
        const packet = (text: string) => (text.length + 4).toString(16).padStart(4, "0") + text;

        return new Response(
          packet("# service=git-upload-pack\n") +
            "0000" +
            packet(`${"a".repeat(40)} HEAD\0\n`) +
            "0000",
          { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } },
        );
      } else return Response.json({ name: "typescript", version: "5.0.0" });

    if (url.hostname === "chatgpt.com") {
      if (generation > 0) {
        if (!workingSandboxId) throw new Error("Working sandbox is not configured");
        expect(
          await runInDurableObject(env.SANDBOX.getByName(workingSandboxId), async (_, state) =>
            state.storage.get<WorkspaceSnapshot>("snapshot:checkpoint"),
          ),
        ).toEqual(expectedCheckpoint);
        const encoded = new Uint8Array(await new Response(init?.body).arrayBuffer());

        const bytes =
          new Headers(init?.headers).get("content-encoding") === "zstd"
            ? zstdDecompressSync(encoded)
            : encoded;

        const request = JSON.parse(new TextDecoder().decode(bytes));

        const instructions = JSON.stringify([
          request.instructions,
          ...request.input.filter(
            (item: { role?: string }) => item.role === "developer" || item.role === "system",
          ),
        ]);

        expect(instructions).toContain("Fixture repository verification");
        expect(instructions).toContain(".agents/skills/verify/SKILL.md");
        expect(instructions).not.toContain("Fixture full skill instructions");
      }

      const call = calls[generation++];

      if (generation === 2) {
        if (!workingSandboxId) throw new Error("Working sandbox is not configured");
        expect(
          await runInDurableObject(env.SANDBOX.getByName(workingSandboxId), async (_, state) =>
            state.storage.get("workspace:setup"),
          ),
        ).toMatchObject({ state: "installing" });
      }

      const item = call
        ? {
            type: "function_call",
            id: `fc_${generation}`,
            call_id: `call_${generation}`,
            name: call.name,
            arguments: JSON.stringify(call.input),
          }
        : {
            type: "message",
            id: "msg_done",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Harness workflow complete", annotations: [] }],
          };

      const events = [
        {
          type: "response.created",
          response: { id: `resp_${generation}`, status: "in_progress", output: [] },
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `resp_${generation}`,
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
    }

    if (url.hostname === "api.github.com") {
      if (url.pathname.endsWith("/installation")) return Response.json({ id: 7 });

      if (url.pathname.endsWith("/access_tokens")) {
        expect(JSON.parse(String(init?.body)).repositories).toEqual(["project"]);

        return Response.json({
          token: "private-installation-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }

      if (url.pathname.endsWith("/pulls")) {
        opened = true;
        expect(JSON.parse(String(init?.body)).base).toBe("main");

        return Response.json({
          number: 1,
          html_url: "https://github.com/another-owner/project/pull/1",
        });
      }

      expect(url.pathname).toBe("/repos/another-owner/project");

      return Response.json({ default_branch: "main" });
    }

    if (url.hostname !== "github.com") return originalFetch(input, init);

    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Basic ${btoa("x-access-token:private-installation-token")}`,
    );
    const forwarded = new Request(String(input), init);
    const bytes = new Uint8Array(await forwarded.arrayBuffer());

    const result = await runInDurableObject(env.SANDBOX.getByName(remoteName), async (_, state) => {
      const container = state.container;

      if (!container) throw new Error("Missing container");

      const process = await container.exec(["git", "http-backend"], {
        cwd: "/workspace",
        stdin: new Blob([bytes]).stream(),
        env: {
          GIT_PROJECT_ROOT: "/workspace/remotes",
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: forwarded.method,
          CONTENT_TYPE: forwarded.headers.get("Content-Type") ?? "",
          CONTENT_LENGTH: String(bytes.length),
          REMOTE_USER: "fixture",
        },
      });

      return process.output();
    });

    expect(result.exitCode).toBe(0);
    const output = Buffer.from(result.stdout);
    const split = output.indexOf("\r\n\r\n");
    expect(split).toBeGreaterThan(0);
    const headers = new Headers();
    let status = 200;

    for (const line of output.subarray(0, split).toString().split("\r\n")) {
      const colon = line.indexOf(":");

      if (colon < 0) continue;
      const name = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();

      if (name === "Status") status = Number.parseInt(value, 10);
      else headers.set(name, value);
    }

    return new Response(output.subarray(split + 4), { status, headers });
  });

  await signIn();

  try {
    const created = await SELF.fetch("https://worker/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace: { repository: "another-owner/project", ref: "main" } }),
    });

    expect(created.status).toBe(201);
    const session = await created.json<{ id: string }>();
    workingSandboxId = await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) =>
      String(await state.storage.get(`session:${session.id}`)),
    );
    expect(
      (
        await SELF.fetch(`https://worker/api/sessions/${session.id}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: "Fix the answer, run tests, commit, push and open a PR",
            requestId: crypto.randomUUID(),
          }),
        })
      ).status,
    ).toBe(202);
    await expect
      .poll(
        async () =>
          (await SELF.fetch(`https://worker/api/sessions/${session.id}`, { headers })).text(),
        { timeout: 240000 },
      )
      .toContain("Harness workflow complete");

    const transcript = await (
      await SELF.fetch(`https://worker/api/sessions/${session.id}`, { headers })
    ).text();

    expect(opened, transcript).toBe(true);
    expect(transcript).not.toContain("private-installation-token");
    const decoded = JSON.parse(transcript);

    const results = decoded.entries
      .flatMap(
        (entry: {
          model?: { role: string; isError?: boolean; content: { type: string; text?: string }[] }[];
        }) => entry.model ?? [],
      )
      .filter((message: { role: string }) => message.role === "toolResult");

    expect(results).toHaveLength(calls.length);

    for (const result of results) {
      expect(result.isError, JSON.stringify(result.content)).toBe(false);

      for (const part of result.content)
        if (part.type === "text") {
          if (part.text.startsWith("---")) {
            expect(part.text).toContain("Fixture full skill instructions");
            continue;
          }

          const value = JSON.parse(part.text);
          expect(value.error).toBeUndefined();

          if ("exitCode" in value) expect(value.exitCode, JSON.stringify(value)).toBe(0);
        }
    }

    const id = await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
      const id = String(await state.storage.get(`session:${session.id}`));
      expect(await state.storage.get(`session-created-pr:${id}`)).toEqual({
        repository: "another-owner/project",
        number: 1,
        url: "https://github.com/another-owner/project/pull/1",
      });

      return id;
    });

    const sandbox = env.SANDBOX.getByName(id);

    const httpsGit = await sandbox.run(
      "git ls-remote https://registry.npmjs.org/dolly-fixture.git",
    );

    expect(httpsGit.exitCode, httpsGit.stderr).toBe(0);
    expect(httpsGit.stdout).toContain(`${"a".repeat(40)}\tHEAD`);

    const config = workspaceConfig({ repository: "another-owner/project", ref: "main" }, id);

    const snapshotPointer = () =>
      runInDurableObject(sandbox, async (_, state) =>
        state.storage.get<WorkspaceSnapshot>("snapshot:checkpoint"),
      );

    await expect.poll(snapshotPointer, { timeout: 120000 }).toMatchObject({
      id: expect.any(String),
      turnId: expect.any(String),
    });
    const answeredTurn = await snapshotPointer();

    await sandbox.prepare(config);
    await sandbox.readFile("/workspace/repo/answer.mjs");
    expect(await sandbox.skills()).toMatchObject({
      status: "ready",
      inventory: expect.stringContaining("Fixture repository verification"),
    });
    expect(await snapshotPointer()).toEqual(answeredTurn);

    const dirty = await sandbox.run(`set -eu
test "$(pwd)" = /workspace/repo
test ! -L /workspace/repo
test -d .git
test "$(git rev-parse --is-shallow-repository)" = true
git commit --allow-empty -m 'Unpushed local commit'
printf 'staged work' > staged.txt
git add staged.txt
printf 'unstaged work' > staged.txt
printf 'unsaved work' > dirty.txt
printf 'ignored.txt\\n' > .gitignore
printf 'ignored work' > ignored.txt
mkdir empty-directory
ln -s dirty.txt dirty-link`);

    expect(dirty.exitCode, dirty.stderr).toBe(0);
    const beforeEviction = await sandbox.diagnostics();

    await evictDurableObject(sandbox);
    await sandbox.prepare(config);
    expect((await sandbox.diagnostics()).setup).toEqual(beforeEviction.setup);

    const live = await sandbox.run(
      "test ! -L /workspace/repo; git show :staged.txt; cat staged.txt ignored.txt dirty-link; test -d empty-directory; git status --porcelain",
    );

    expect(live.exitCode, live.stderr).toBe(0);
    expect(live.stdout).toContain("staged workunstaged workignored workunsaved work");
    expect(live.stdout).toContain("AM staged.txt");
    expect(await snapshotPointer()).toEqual(answeredTurn);
    expect(await sandbox.run("exit 7")).toMatchObject({ exitCode: 7 });
    expect(await snapshotPointer()).toEqual(answeredTurn);
    const saved = await sandbox.checkpoint("next-answered-turn");

    expect(saved).toMatchObject({ turnId: "next-answered-turn" });
    expect(await sandbox.checkpoint("next-answered-turn")).toEqual(saved);
    await sandbox.run("printf unsaved > lost.txt");
    await sandbox.restart();

    const restored = await sandbox.run(`set -eu
test ! -e lost.txt
git show :staged.txt
cat staged.txt ignored.txt dirty-link
test -d empty-directory
git log -1 --format=%s`);

    expect(restored.exitCode, restored.stderr).toBe(0);
    expect(restored.stdout).toContain("staged workunstaged workignored workunsaved work");
    expect(restored.stdout).toContain("Unpushed local commit");
    expect(await snapshotPointer()).toEqual(saved);
    await runInDurableObject(sandbox, async (instance) => {
      const publish = instance["publishSnapshot"].bind(instance);
      let fail = true;
      Object.assign(instance, {
        publishSnapshot: (snapshot: { id: string; turnId?: string }) => {
          if (fail) {
            fail = false;

            return Effect.fail(
              new OperationError({
                operation: "workspace.checkpoint.save",
                message: "Snapshot acknowledgement unavailable",
                details: null,
              }),
            );
          }

          return publish(snapshot);
        },
      });
    });
    await sandbox.run("printf unacknowledged > lost.txt");
    expectedCheckpoint = await snapshotPointer();
    expect(
      (
        await SELF.fetch(`https://worker/api/sessions/${session.id}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: "Finish this turn",
            requestId: crypto.randomUUID(),
          }),
        })
      ).status,
    ).toBe(202);
    await expect
      .poll(() => sandbox.diagnostics(), { timeout: 120000 })
      .toMatchObject({
        checkpointError: {
          turnId: expect.any(String),
          error: expect.stringContaining("unavailable"),
        },
      });
    expect(await snapshotPointer()).toEqual(saved);
    await expect
      .poll(() =>
        runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => [
          ...state.storage.sql.exec(
            "SELECT id FROM app_papercuts WHERE source = 'workspace:checkpoint'",
          ),
        ]),
      )
      .toHaveLength(1);
    await sandbox.restart();
    expect(await sandbox.run("test ! -e lost.txt && cat dirty.txt")).toMatchObject({
      exitCode: 0,
      stdout: "unsaved work",
    });
    expectedCheckpoint = await snapshotPointer();
    expect(
      (
        await SELF.fetch(`https://worker/api/sessions/${session.id}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: "Inspect the preserved workspace",
            requestId: crypto.randomUUID(),
          }),
        })
      ).status,
    ).toBe(202);
    await expect.poll(snapshotPointer, { timeout: 120000 }).not.toEqual(expectedCheckpoint);
    expect((await sandbox.diagnostics()).checkpointError).toBeUndefined();
    expect(await snapshotPointer()).toMatchObject({ turnId: expect.any(String) });
    expect(
      (
        await remote.run(
          `git --git-dir=remotes/another-owner/project.git show dolly/session-${id}:answer.mjs`,
        )
      ).stdout,
    ).toContain("answer = 2");

    const denied = await sandbox.run(
      "curl --silent --show-error --fail-with-body --max-time 5 https://example.com",
    );

    expect(denied.exitCode).toBe(22);
    expect(denied.stdout).toContain("Network destination not enabled for this session");

    const registryAfterSetup = await sandbox.run(
      "curl --silent --show-error --fail-with-body --max-time 10 https://registry.npmjs.org/typescript/latest",
    );

    expect(registryAfterSetup.exitCode).toBe(0);

    const verification = await remote.run(
      "git --git-dir=remotes/another-owner/project.git for-each-ref --format='%(refname)' refs/heads/",
    );

    expect(verification.stdout).toContain(`refs/heads/dolly/session-${id}`);
    expect(
      (await remote.run("git --git-dir=remotes/another-owner/project.git show main:answer.mjs"))
        .stdout,
    ).toContain("answer = 1");

    const updated = await remote.run(`set -eu
cd seed
printf 'latest main\\n' > latest.txt
git add latest.txt
git commit -m 'Advance main'
git push ../remotes/another-owner/project.git HEAD:main`);

    expect(updated.exitCode, updated.stderr).toBe(0);
    const freshId = crypto.randomUUID();
    const fresh = env.SANDBOX.getByName(freshId);

    await fresh.prepare(workspaceConfig({ repository: config.repository }, freshId));
    expect(await fresh.readFile("/workspace/repo/latest.txt")).toBe("latest main\n");
    await sandbox.prepare(config);
    expect(await sandbox.run("test -e dirty.txt && test ! -e latest.txt")).toMatchObject({
      exitCode: 0,
    });
    await fresh.restart();
    expect(await fresh.readFile("/workspace/repo/latest.txt")).toBe("latest main\n");
  } finally {
    mocked.mockRestore();
    await remote.restart();
  }
});
