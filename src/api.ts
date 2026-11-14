import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { rpc } from "./operations";
import type { ChildRequest, ChildMessage, SessionSettings, ThinkingLevel } from "./models";
import type { WorkspaceInput } from "./workspace";
import type { PromptImage } from "./images";
import type { Env } from "./env";

function makeAgentApi(env: Env) {
  const agent = env.AGENT.getByName("owner");

  return {
    startLogin: rpc("agent.login.start", async () => await agent.startLogin()),
    pollLogin: rpc("agent.login.poll", async () => await agent.pollLogin()),
    logout: rpc("agent.logout", async () => await agent.logout()),
    createSession: Effect.fn("AgentApi.createSession")(
      (
        model?: string,
        workspace?: typeof WorkspaceInput.Type,
        thinkingLevel?: typeof ThinkingLevel.Type,
      ) =>
        rpc(
          "agent.session.create",
          async () => await agent.createSession(model, workspace, thinkingLevel),
        ),
    ),
    configureSession: Effect.fn("AgentApi.configureSession")(
      (id: string, settings: typeof SessionSettings.Type) =>
        rpc("agent.session.configure", async () => await agent.configureSession(id, settings)),
    ),
    children: Effect.fn("AgentApi.children")((id: string) =>
      rpc("agent.children", async () => await agent.children(id)),
    ),
    spawnChild: Effect.fn("AgentApi.spawnChild")((id: string, input: typeof ChildRequest.Type) =>
      rpc("agent.child.spawn", async () => await agent.spawnChild(id, input)),
    ),
    sendChild: Effect.fn("AgentApi.sendChild")(
      (id: string, childId: string, input: typeof ChildMessage.Type) =>
        rpc("agent.child.send", async () => await agent.sendChild(id, childId, input)),
    ),
    childTask: Effect.fn("AgentApi.childTask")((id: string, taskId: string) =>
      rpc("agent.child.task", async () => await agent.childTask(id, taskId)),
    ),
    transcript: Effect.fn("AgentApi.transcript")((id: string) =>
      rpc("agent.transcript", async () => await agent.transcript(id)),
    ),
    prompt: Effect.fn("AgentApi.prompt")(
      (id: string, content: string, requestId: string, images?: readonly PromptImage[]) =>
        rpc("agent.prompt", async () => await agent.prompt(id, content, requestId, images)),
    ),
    abort: Effect.fn("AgentApi.abort")((id: string) =>
      rpc("agent.abort", async () => await agent.abort(id)),
    ),
    steerQueued: Effect.fn("AgentApi.steerQueued")((id: string, submissionId: number) =>
      rpc("agent.queue.steer", async () => await agent.steerQueued(id, submissionId)),
    ),
  };
}

export class AgentApi extends Context.Service<AgentApi, ReturnType<typeof makeAgentApi>>()(
  "dolly/AgentApi",
) {
  static readonly layer = (env: Env) => Layer.sync(AgentApi, () => makeAgentApi(env));
}
