import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { checkoutDiagnosticsScript } from "../src/workspace";

const config = {
  repository: "owner/project",
  ref: "main",
  branch: "dolly/test",
  networkHosts: [],
};

it("prepares a warm workspace only once without repeating checkout", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    let checkouts = 0;
    Object.assign(instance, {
      container: () => Effect.void,
      installDependencies: () => Effect.succeed(undefined),
      execute: () =>
        Effect.sync(() => {
          checkouts++;

          return { stdout: "", stderr: "", exitCode: 0 };
        }),
    });
    expect(await instance.prepare(config)).toMatchObject({ ref: "main" });
    await instance.prepare(config);
    await instance.prepare(config);
    expect(checkouts).toBe(1);
    await instance.restart();
    await instance.prepare(config);
    expect(checkouts).toBe(2);
  });
});

it("exposes checkout stderr and permits retry after a failed setup", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    let checkouts = 0;
    let diagnostics = 0;
    Object.assign(instance, {
      container: () => Effect.void,
      installDependencies: () => Effect.succeed(undefined),
      execute: (command: string) =>
        Effect.sync(() => {
          if (command === checkoutDiagnosticsScript) {
            diagnostics++;

            return { stdout: "phase: resolve_ref", stderr: "", exitCode: 0 };
          }

          return {
            stdout: "",
            stderr: checkouts++ === 0 ? "fatal: remote ref main not found" : "",
            exitCode: checkouts === 1 ? 1 : 0,
          };
        }),
    });
    let failure: unknown;

    try {
      await instance.prepare(config);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      operation: "workspace.checkout",
      message: "Git checkout failed (exit 1): fatal: remote ref main not found",
    });
    expect(diagnostics).toBe(1);
    await instance.prepare(config);
    expect(checkouts).toBe(2);
    expect(diagnostics).toBe(1);
  });
});

it("collects bounded diagnostics after a checkout timeout without masking the timeout", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    const calls: { command: string; timeout: number }[] = [];
    Object.assign(instance, {
      container: () => Effect.void,
      installDependencies: () => Effect.succeed(undefined),
      execute: (command: string, _cwd: string, timeout: number) => {
        calls.push({ command, timeout });

        return command === checkoutDiagnosticsScript
          ? Effect.fail(new Error("Diagnostic probe unavailable"))
          : Effect.never.pipe(Effect.timeout("1 millis"));
      },
    });
    await expect(instance.prepare(config)).rejects.toHaveProperty("_tag", "TimeoutError");
    expect(calls).toHaveLength(2);
    expect(calls[0].timeout).toBe(120);
    expect(calls[1]).toEqual({ command: checkoutDiagnosticsScript, timeout: 10 });
  });
});

it("preserves checkout errors even when the diagnostic probe defects", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    Object.assign(instance, {
      container: () => Effect.void,
      installDependencies: () => Effect.succeed(undefined),
      execute: (command: string) =>
        command === checkoutDiagnosticsScript
          ? Effect.die("Diagnostic process crashed")
          : Effect.succeed({
              stdout: "",
              stderr: "fatal: index.lock exists",
              exitCode: 128,
            }),
    });
    await expect(instance.prepare(config)).rejects.toMatchObject({
      operation: "workspace.checkout",
      message: "Git checkout failed (exit 128): fatal: index.lock exists",
    });
  });
});

it("propagates rejected workspace calls without unhandled RPC rejections", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  const config = {
    repository: "owner/project",
    ref: "main",
    branch: "dolly/test",
    networkHosts: [],
  };

  await runInDurableObject(sandbox, async (_, state) => {
    await state.storage.put("workspace", config);
  });
  let failure: unknown;

  try {
    await sandbox.prepare({ ...config, ref: "other" });
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({ operation: "workspace.configure" });
});

it("starts setup asynchronously and makes concurrent tools join one checkout/install", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    const gate = Promise.withResolvers<void>();
    let checkouts = 0;
    let installs = 0;
    let toolDone = false;
    Object.assign(instance, {
      container: () => Effect.void,
      execute: () =>
        Effect.sync(() => {
          checkouts++;

          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      installDependencies: () =>
        Effect.tryPromise(async () => {
          installs++;
          await gate.promise;
        }),
    });
    expect(await instance.warm(config)).toEqual({ queued: true });

    const tool = instance.prepare(config).then(() => {
      toolDone = true;
    });

    try {
      await expect
        .poll(() => state.storage.get("workspace:setup"))
        .toMatchObject({ state: "installing" });
      await tool;
      expect(toolDone).toBe(true);
      expect(await instance.diagnostics()).toMatchObject({
        setup: { state: "installing" },
      });
    } finally {
      gate.resolve();
      await tool;
    }

    expect(checkouts).toBe(1);
    expect(installs).toBe(1);
    expect(toolDone).toBe(true);
    await instance.alarm();
    expect(checkouts).toBe(1);
  });
});

it("confirmed restart cancels in-flight setup instead of waiting for the install deadline", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    Object.assign(instance, {
      container: () => Effect.void,
      execute: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
      installDependencies: () => Effect.never,
    });
    await instance.warm(config);
    await expect
      .poll(() => state.storage.get("workspace:setup"))
      .toMatchObject({ state: "installing" });
    await instance.restart();
    expect(await state.storage.get("workspace")).toEqual(config);
  });
});

it("reports dependency setup warnings without blocking checkout or repeating setup", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    let installs = 0;
    Object.assign(instance, {
      container: () => Effect.void,
      execute: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
      installDependencies: () =>
        Effect.sync(() => {
          installs++;

          return "Package registry is unavailable";
        }),
    });
    await instance.prepare(config);
    expect(await instance.waitForDependencies()).toMatchObject({
      state: "warning",
      error: "Package registry is unavailable",
    });
    await instance.prepare(config);
    expect(installs).toBe(1);
  });
});

it("cancels dependency setup before restarting", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    let installing = false;
    let cancelled = false;
    Object.assign(instance, {
      container: () => Effect.succeed({ interceptAllOutboundHttp: async () => {} }),
      execute: (command: string) =>
        command.endsWith("python3 /usr/local/lib/dolly-setup.py --once")
          ? Effect.sync(() => {
              installing = true;
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cancelled = true;
                }),
              ),
            )
          : Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
    });
    await instance.warm(config);
    await expect.poll(() => installing).toBe(true);
    await instance.restart();
    expect(cancelled).toBe(true);
  });
});

it("can inspect an unstarted sandbox without invoking preparation or starting a container", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    Object.assign(instance, {
      container: () => Effect.die("Diagnostics must not initialize a container"),
    });
    expect(await instance.diagnostics()).toMatchObject({ running: false });
  });
});
