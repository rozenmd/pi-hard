import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { runInDurableObject } from "cloudflare:test";
import { Files } from "@cloudflare/sandbox";
import * as Effect from "effect/Effect";
import type { Env as WorkerEnv } from "../../src/env";
import { workspaceConfig } from "../../src/workspace";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

it("privately previews without an image-provided runtime directory and preserves workspace files", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    await sandbox.run("printf preserved > /workspace/preview-proof.txt");
    // Older/restored containers need not have the current image's runtime directory.
    await runInDurableObject(sandbox, async (_, state) => {
      if (!state.container) throw new Error("Missing test container");
      await new Files(state.container).remove("/run/sandbox", {
        recursive: true,
        force: true,
        user: "0:0",
      });
    });
    expect(await sandbox.run("test ! -e /run/sandbox")).toMatchObject({ exitCode: 0 });
    await sandbox.previewStart(
      `node -e 'require("http").createServer((req,res)=>res.end("preview:"+req.url)).listen(3000,"0.0.0.0")'`,
      3000,
    );
    expect(await sandbox.previewStatus()).toMatchObject({ running: true, port: 3000 });
    const { token } = await sandbox.previewCapability();
    expect(
      (await sandbox.previewFetch(new Request("http://private.test/hello"), "wrong")).status,
    ).toBe(404);
    expect(
      await (
        await sandbox.previewFetch(new Request("http://private.test/hello?a=1"), token)
      ).text(),
    ).toBe("preview:/hello?a=1");
    let duplicate: unknown;

    try {
      await sandbox.previewStart("sleep 60", 3001);
    } catch (error) {
      duplicate = error;
    }

    expect(String(duplicate)).toContain("already running");
    await sandbox.previewStop();
    expect((await sandbox.previewFetch(new Request("http://private.test/"), token)).status).toBe(
      404,
    );
    expect(await sandbox.readFile("/workspace/preview-proof.txt")).toBe("preserved");
    // The port is released, so a new preview can reuse it.
    await sandbox.previewStart(
      `node -e 'require("http").createServer((req,res)=>res.end("again")).listen(3000,"0.0.0.0")'`,
      3000,
    );
    expect((await sandbox.previewCapability()).token).not.toBe(token);
    expect((await sandbox.previewFetch(new Request("http://private.test/"), token)).status).toBe(
      404,
    );
  } finally {
    await sandbox.previewStop();
    await sandbox.restart();
  }
});

it("stops failed preview commands and retains bounded failure logs", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    let failure: unknown;

    try {
      await sandbox.previewStart("echo deliberate-preview-failure; exit 1", 3000);
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("did not become ready");
    expect(await sandbox.previewStatus()).toMatchObject({
      running: false,
      logs: expect.stringContaining("deliberate-preview-failure"),
    });
  } finally {
    await sandbox.restart();
  }
});

it("enforces preview supervisor TTL and bounds logs independently of the Durable Object", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    const result = await sandbox.run(
      `python3 /usr/local/lib/dolly-preview.py "python3 -c 'import time; print(\\"x\\"*40000, flush=True); time.sleep(60)'" 1 /run/sandbox/ttl.log; wc -c < /run/sandbox/ttl.log`,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("32768");
  } finally {
    await sandbox.restart();
  }
});

it("executes commands and uses Sandbox 1.0 Files in isolated containers", async () => {
  const first = env.SANDBOX.getByName(crypto.randomUUID());
  expect(await first.run("printf 'sandbox proof' > proof.txt; cat proof.txt")).toMatchObject({
    stdout: "sandbox proof",
    exitCode: 0,
  });
  expect(await first.readFile("/workspace/proof.txt")).toBe("sandbox proof");
  expect(await first.run("exit 7")).toMatchObject({ exitCode: 7 });
  const environment = await first.run("env; id -u");
  expect(environment.stdout).not.toContain("API_TOKEN");
  expect(environment.stdout).not.toContain("OPENAI");
  expect(environment.stdout).toContain("1000");
  expect(await first.run("test -w /run/sandbox && test -x /run/sandbox")).toMatchObject({
    exitCode: 0,
  });
  const second = env.SANDBOX.getByName(crypto.randomUUID());
  expect(await second.run("test ! -e /workspace/proof.txt")).toMatchObject({ exitCode: 0 });
});

it("keeps repository-less workspaces ephemeral", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    expect(await sandbox.run("printf ephemeral > local.txt")).toMatchObject({ exitCode: 0 });
    expect(await sandbox.readFile("/workspace/local.txt")).toBe("ephemeral");
    await sandbox.restart();
    expect(await sandbox.diagnostics()).toMatchObject({ running: false });
    expect(await sandbox.run("test ! -e local.txt")).toMatchObject({ exitCode: 0 });
  } finally {
    await sandbox.restart();
  }
});

it("fails closed on a missing saved snapshot rather than cloning over lost work", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  const config = workspaceConfig({ repository: "owner/project" }, "snapshot-fixture");
  const id = "missing-native-snapshot";
  await runInDurableObject(sandbox, async (_, state) => {
    await state.storage.put("workspace", config);
    await state.storage.put("snapshot:checkpoint", { id });
  });
  let failure: unknown;

  try {
    await sandbox.prepare(config);
  } catch (error) {
    failure = error;
  }

  expect(String(failure)).toContain(id);
  expect(await sandbox.diagnostics()).toMatchObject({ running: false });
  await runInDurableObject(sandbox, async (_, state) => {
    expect(await state.storage.get("snapshot:checkpoint")).toEqual({ id });
  });
});

it("timeout kills command descendants, reaps them, and leaves detached services running", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    await runInDurableObject(sandbox, async (instance) => {
      // Exercise the real executor with a short deadline, not a mocked timeout.
      const runtime: object = instance;

      // SAFETY: runInDurableObject supplies Sandbox; execute is TS-private, not a JS #private field.
      const executor = runtime as {
        execute(command: string, cwd: string, timeout: number): Effect.Effect<unknown, unknown>;
      };

      let failure: unknown;

      try {
        await Effect.runPromise(
          executor.execute(
            `setsid sleep 120 >/dev/null 2>&1 </dev/null &
echo $! > detached.pid
python3 -c 'import os,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open("child.pid", "w").write(str(os.getpid())); time.sleep(120)' &
wait`,
            "/workspace",
            2,
          ),
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toHaveProperty("_tag", "TimeoutError");
    });
    await expect
      .poll(
        async () =>
          (await sandbox.run('test ! -e /proc/$(cat child.pid) && kill -0 "$(cat detached.pid)"'))
            .exitCode,
        { timeout: 5000 },
      )
      .toBe(0);
  } finally {
    await sandbox.restart();
  }
});
