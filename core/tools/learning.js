import { createHarnessRuntime } from "../lib/harness-runtime.js";

const runtimes = new WeakMap();

function runtimeFor(ctx = {}) {
  const owner = ctx.owner || ctx;
  let runtime = runtimes.get(owner);
  if (!runtime) {
    runtime = createHarnessRuntime({ dataDir: ctx.dataDir, pluginDir: ctx.pluginDir, log: ctx.log });
    runtime.attachToContext(ctx.owner || ctx);
    runtimes.set(owner, runtime);
  }
  return runtime;
}

export function getRuntime(ctx = {}) { return runtimeFor(ctx); }

export async function executeLearning(input = {}, ctx = {}) {
  const runtime = runtimeFor(ctx);
  switch (input.action) {
    case "status": return runtime.status();
    case "observe": {
      if (!input.turn || typeof input.turn !== "object") throw new Error("observe requires a turn object");
      const session = { id: input.turn.sessionId || "manual-session", header: { cwd: input.turn.sessionPath || "" } };
      if (input.turn.userText) runtime.observeSessionEvent(session, { type: "user/message", data: { message: { role: "user", content: [{ type: "text", text: input.turn.userText }] } } });
      for (const tool of input.turn.tools || []) {
        runtime.observeSessionEvent(session, { type: "tool/call", data: { name: tool } });
        runtime.observeSessionEvent(session, { type: "tool/result", data: { name: tool, message: { content: [{ type: "text", text: "ok" }] } } });
      }
      runtime.observeSessionEvent(session, { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: input.turn.resultText || "completed" }] } } });
      runtime.observeSessionEvent(session, { type: "turn/end", data: { reason: "completed" } });
      return runtime.status();
    }
    case "inject": {
      const text = runtime.buildInjection(input.query || "", input.project || null);
      return { ok: true, injected: Boolean(text), text };
    }
    case "evolve": return runtime.evolveSkills(input.options || {});
    case "feedback": return runtime.recordSkillFeedback(input, ctx);
    case "render_skill": return runtime.renderSkill();
    default: throw new Error(`unknown learning action: ${input.action}`);
  }
}
