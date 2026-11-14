import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { shellQuote, workspaceConfig } from "../../src/workspace";

it("reads and runs commands during setup, joins once, and saves only the settled filesystem", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  const config = workspaceConfig({ repository: "fixture/background" }, "background");

  try {
    // Real live-container recovery boundary, without GitHub or provider calls.
    const seeded = await sandbox.run(`set -eu
mkdir -p /workspace/repo/.agents
cd /workspace/repo
git init
printf read-me > README.md
printf '%s\\n' 'printf "%s" "$DOLLY_DEPENDENCY_CACHE_TOKEN" > /workspace/cache-token' 'echo attempt >> /workspace/attempts' 'while ! test -f /workspace/release; do sleep 0.1; done' 'echo complete > installed.txt' > .agents/setup
touch /workspace/ready`);

    expect(seeded.exitCode, seeded.stderr).toBe(0);
    await runInDurableObject(sandbox, async (_, state) => {
      await state.storage.put("workspace", config);
      await state.storage.put("workspace:setup", { state: "installing", updatedAt: Date.now() });
    });
    await evictDurableObject(sandbox);

    expect(await sandbox.prepare(config)).toMatchObject({ setup: { state: "installing" } });
    await Promise.all([sandbox.prepare(config), sandbox.prepare(config)]);
    expect(await sandbox.readFile("/workspace/repo/README.md")).toBe("read-me");
    expect(
      await sandbox.run(
        "while ! test -f /workspace/attempts; do sleep 0.1; done; test ! -f installed.txt; cat /workspace/attempts",
      ),
    ).toMatchObject({
      exitCode: 0,
      stdout: "attempt\n",
    });
    expect(
      await sandbox.run(
        `curl -s -o /dev/null -w '%{http_code}' -H "X-Dolly-Dependency-Cache: $(cat /workspace/cache-token)" http://dependencies.workspace/v1/${"0".repeat(64)}`,
      ),
    ).toMatchObject({
      exitCode: 0,
      stdout: "404",
    });

    // A second coordinator joins the same container-side attempt.
    const joined = runInDurableObject(sandbox, async (_, state) => {
      if (!state.container) throw new Error("Missing container");

      const process = await state.container.exec(
        ["python3", "/usr/local/lib/dolly-setup.py", "--once"],
        { cwd: "/workspace/repo" },
      );

      return process.output();
    });

    let dependenciesDone = false;

    const dependencies = sandbox.waitForDependencies().then((status) => {
      dependenciesDone = true;

      return status;
    });

    // This command can still execute while a dependency-aware caller waits.
    expect(await sandbox.run("test ! -f installed.txt")).toMatchObject({ exitCode: 0 });
    expect(dependenciesDone).toBe(false);

    const saved = sandbox.checkpoint("background-turn");

    try {
      await runInDurableObject(sandbox, async (_, state) => {
        expect(await state.storage.get("snapshot:checkpoint")).toBeUndefined();

        if (!state.container) throw new Error("Missing container");
        // Do not queue the release behind the checkpoint's foreground permit.
        const process = await state.container.exec(["touch", "/workspace/release"]);
        expect(await process.exitCode).toBe(0);
      });
      expect(await dependencies).toMatchObject({ state: "ready" });
      expect(await joined).toMatchObject({ exitCode: 0 });
      expect(await saved).toMatchObject({ turnId: "background-turn" });
    } finally {
      await saved;
    }

    expect(
      await sandbox.run(
        `curl -s -o /dev/null -w '%{http_code}' -H "X-Dolly-Dependency-Cache: $(cat /workspace/cache-token)" http://dependencies.workspace/v1/${"0".repeat(64)}`,
      ),
    ).toMatchObject({
      exitCode: 0,
      stdout: "403",
    });

    // Simulate eviction before the completion status was durably acknowledged.
    await runInDurableObject(sandbox, async (_, state) => {
      await state.storage.put("workspace:setup", { state: "installing", updatedAt: Date.now() });
    });
    await evictDurableObject(sandbox);
    await sandbox.prepare(config);
    expect(await sandbox.waitForDependencies()).toMatchObject({ state: "ready" });
    expect(await sandbox.run("cat /workspace/attempts installed.txt")).toMatchObject({
      exitCode: 0,
      stdout: "attempt\ncomplete\n",
    });
    await sandbox.restart();
    expect(await sandbox.run("cat installed.txt")).toMatchObject({
      exitCode: 0,
      stdout: "complete\n",
    });
  } finally {
    await sandbox.restart();
  }
});

it("reports failed background setup and cancels a hung process tree on restart", async () => {
  for (const hook of [
    "echo setup-failed >&2; exit 27",
    "sleep 600 & echo $! > /workspace/child; wait",
  ]) {
    const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
    const config = workspaceConfig({ repository: "fixture/lifecycle" }, "lifecycle");

    try {
      expect(
        await sandbox.run(`set -eu
mkdir -p /workspace/repo/.agents
cd /workspace/repo
git init
printf '%s' ${shellQuote(hook)} > .agents/setup
touch /workspace/ready`),
      ).toMatchObject({ exitCode: 0 });
      await runInDurableObject(sandbox, async (_, state) => {
        await state.storage.put("workspace", config);
        await state.storage.put("workspace:setup", { state: "installing", updatedAt: Date.now() });
      });
      await evictDurableObject(sandbox);
      await sandbox.prepare(config);

      if (hook.includes("setup-failed")) {
        expect(await sandbox.waitForDependencies()).toMatchObject({
          state: "warning",
          error: expect.stringContaining("setup-failed"),
        });
        expect(await sandbox.run("printf still-usable")).toMatchObject({ stdout: "still-usable" });
      } else {
        expect(
          await sandbox.run("while ! test -f /workspace/child; do sleep 0.1; done"),
        ).toMatchObject({ exitCode: 0 });
        await sandbox.restart();
        expect(await sandbox.diagnostics()).toMatchObject({ running: false });
      }
    } finally {
      await sandbox.restart();
    }
  }
});
