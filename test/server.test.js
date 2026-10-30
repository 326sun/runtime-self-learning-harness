import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callMemory, createContext } from "../server.js";
import { apply } from "../index.js";

async function jsonResult(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

test("creates a general-scope context by default and a project context when configured", () => {
  assert.equal(createContext({}).sessionPath, path.join("sessions", "00000000"));
  assert.equal(createContext({ HARNESS_PROJECT: "harness" }).sessionPath, path.join("projects", "harness"));
});

test("routes memory writes and reads through the 6.2 core", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-harness-"));
  const context = createContext({ HARNESS_DATA_DIR: dataDir });

  const saved = await jsonResult(await callMemory({
    action: "upsert",
    memory: { id: "harness-pref", type: "preference", desc: "Use concise Chinese replies" },
  }, context));
  assert.equal(saved.ok, true);

  const listed = await jsonResult(await callMemory({ action: "list", limit: 20 }, context));
  assert.equal(listed.memories.some((row) => row.id === "harness-pref"), true);

  const deleted = await jsonResult(await callMemory({ action: "delete", id: "harness-pref" }, context));
  assert.equal(deleted.deleted, true);
});

test("returns MCP-style error content for an invalid memory call", async () => {
  const result = await callMemory({ action: "get", id: "missing" }, createContext({
    HARNESS_DATA_DIR: await fs.mkdtemp(path.join(os.tmpdir(), "harness-harness-error-")),
  }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /memory not found/);
});

test("native Harness bundle registers memory, observation, injection, and skill-loop tools", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-native-flow-"));
  const handlers = new Map();
  const registered = new Map();
  const ctx = {
    dataDir,
    pluginDir: path.dirname(new URL(import.meta.url).pathname),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, listener) {
      handlers.set(name, listener);
      return () => handlers.delete(name);
    },
    tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
  };

  apply(ctx);
  for (const name of ["memory_search", "memory_upsert", "learning_status", "learning_observe", "learning_inject", "learning_skill_evolve"]) {
    assert.equal(registered.has(name), true, `missing native tool ${name}`);
  }
  assert.equal(handlers.has("session/event"), true);
  assert.equal(handlers.has("agent/pre-step"), true);

  await registered.get("learning_observe").execute({ turn: {
    sessionId: "native-session",
    sessionPath: path.join(dataDir, "projects", "demo"),
    userText: "Use the verified workflow next time",
    tools: ["fs_read", "shell_exec"],
    resultText: "done",
  } });
  const status = await registered.get("learning_status").execute({});
  assert.equal(status.observedTurns, 1);
  assert.equal(status.autoActionsEnabled, false);
  assert.ok(status.patterns >= 0);

  const injection = await registered.get("learning_inject").execute({ query: "verified workflow" });
  assert.equal(injection.ok, true);
  const evolution = await registered.get("learning_skill_evolve").execute({ options: { dryRun: true } });
  assert.equal(evolution.ok, true);
});

test("native session events are observed automatically and pre-step receives scoped memory", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-auto-flow-"));
  const handlers = new Map();
  const registered = new Map();
  const ctx = {
    dataDir,
    pluginDir: dataDir,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, listener) { handlers.set(name, listener); return () => handlers.delete(name); },
    tools: { register(tool) { registered.set(tool.name, tool); return () => {}; } },
  };
  apply(ctx);
  const session = { id: "session-auto", header: { cwd: path.join(dataDir, "projects", "auto") } };
  await registered.get("memory_upsert").execute({ id: "auto-memory", memory: { type: "preference", desc: "Remember the verified workflow" } }, { agent: { session: { header: { cwd: path.join(dataDir, "projects", "auto") } } } });
  const event = handlers.get("session/event");
  event(session, { type: "user/message", data: { message: { role: "user", content: [{ type: "text", text: "remember this workflow" }] } } });
  event(session, { type: "tool/call", data: { callId: "call-1", name: "fs_read", arguments: "{}" } });
  event(session, { type: "tool/result", data: { callId: "call-1", message: { content: [{ type: "text", text: "ok" }] } } });
  event(session, { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "done" }] } } });
  event(session, { type: "turn/end", data: { reason: "completed" } });

  const decision = await handlers.get("agent/pre-step")({
    agent: { session }, messages: [{ role: "user", content: [{ type: "text", text: "remember this workflow" }] }],
  }, async () => ({ kind: "enter", startsRequestSeries: true, messages: [{ role: "user", content: [{ type: "text", text: "remember this workflow" }] }] }));
  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages.length, 2);
  assert.match(decision.messages[0].content[0].text, /verified workflow/i);
  assert.equal(decision.messages[0].source.kind, "plugin");
  assert.equal(decision.startsRequestSeries, true);
});

test("repeated failed tool turns become a skill-evolution candidate", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-skill-flow-"));
  const handlers = new Map();
  const registered = new Map();
  const ctx = {
    dataDir, pluginDir: dataDir,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, listener) { handlers.set(name, listener); return () => handlers.delete(name); },
    tools: { register(tool) { registered.set(tool.name, tool); return () => {}; } },
  };
  apply(ctx);
  const event = handlers.get("session/event");
  for (let i = 0; i < 3; i += 1) {
    const session = { id: `failed-session-${i}`, header: { cwd: path.join(dataDir, "projects", "skill") } };
    event(session, { type: "tool/call", data: { callId: `call-${i}`, name: "shell_exec", arguments: "{}" } });
    event(session, { type: "tool/result", data: { callId: `call-${i}`, error: { code: "permission_denied", message: "blocked" }, message: { content: [] } } });
    event(session, { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "failed" }] } } });
    event(session, { type: "turn/end", data: { reason: "error" } });
  }
  const automaticCandidates = JSON.parse(await fs.readFile(path.join(dataDir, "skill_candidates.json"), "utf8"));
  assert.ok(automaticCandidates.candidates.length >= 1);
  const evolved = await registered.get("learning_skill_evolve").execute({ options: { dryRun: true, promotionThreshold: 3 } });
  assert.equal(evolved.ok, true);
  assert.ok(evolved.counts.promotableClusters >= 1);
  assert.ok(evolved.candidates.length >= 1);

  const completeTurn = (id, failed = false) => {
    const session = { id, header: { cwd: path.join(dataDir, "projects", "skill") } };
    event(session, { type: "tool/call", data: { callId: `${id}-call`, name: "shell_exec", arguments: "{}" } });
    event(session, failed
      ? { type: "tool/result", data: { callId: `${id}-call`, error: { code: "permission_denied" }, message: { content: [], isError: true } } }
      : { type: "tool/result", data: { callId: `${id}-call`, message: { content: [{ type: "text", text: "ok" }] } } });
    event(session, { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: failed ? "failed" : "fixed" }] } } });
    event(session, { type: "turn/end", data: { reason: failed ? "error" : "completed" } });
  };
  completeTurn("success-1");
  completeTurn("success-2");
  await registered.get("learning_skill_evolve").execute({ options: { minSuccess: 1, activeSuccess: 2 } });
  const active = await registered.get("learning_skill_evolve").execute({ options: { minSuccess: 1, activeSuccess: 2 } });
  assert.ok(active.activeSkills.some((skill) => skill.id.includes("shell_exec")));
  completeTurn("regression-1", true);
  const regressed = await registered.get("learning_skill_evolve").execute({ options: { minSuccess: 1, activeSuccess: 2 } });
  assert.equal(regressed.activeSkills.some((skill) => skill.id.includes("shell_exec")), false);
  assert.ok(regressed.candidates.some((candidate) => candidate.status === "decayed"));
});

test("turn boundaries, failure mapping, and per-agent project scope follow native DSH context", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-contract-flow-"));
  const handlers = new Map();
  const registrations = new Map();
  const registrationOptions = new Map();
  const ctx = {
    dataDir, pluginDir: dataDir,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, listener, options) { handlers.set(name, listener); registrationOptions.set(name, options); return () => {}; },
    tools: { register(tool) { registrations.set(tool.name, tool); return () => {}; } },
  };
  apply(ctx);
  assert.equal(registrationOptions.get("session/event").global, true);
  assert.equal(registrationOptions.get("agent/created").global, true);
  assert.equal(handlers.has("agent/session-start"), false);

  const session = { id: "contract-session", header: { cwd: path.join(dataDir, "projects", "alpha") } };
  const event = handlers.get("session/event");
  event(session, { type: "user/message", data: { message: { role: "user", content: [{ type: "text", text: "read the file" }] } } });
  event(session, { type: "tool/call", data: { callId: "c1", name: "fs_read", arguments: "{}" } });
  event(session, { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "calling a tool" }] } } });
  const beforeEnd = await registrations.get("learning_status").execute({});
  assert.equal(beforeEnd.observedTurns, 0);
  event(session, { type: "tool/result", data: { callId: "c1", error: { code: "permission_denied" }, message: { content: [], isError: true } } });
  event(session, { type: "turn/end", data: { reason: "error" } });
  const afterEnd = await registrations.get("learning_status").execute({});
  assert.equal(afterEnd.observedTurns, 1);

  const agentExec = { agent: { session: { header: { cwd: path.join(dataDir, "projects", "alpha") } } } };
  await registrations.get("memory_upsert").execute({ id: "alpha-memory", memory: { type: "preference", desc: "Alpha only" } }, agentExec);
  const alpha = await registrations.get("memory_list").execute({ limit: 20 }, agentExec);
  const beta = await registrations.get("memory_list").execute({ limit: 20 }, { agent: { session: { header: { cwd: path.join(dataDir, "projects", "beta") } } } });
  assert.equal(alpha.memories.some((item) => item.id === "alpha-memory"), true);
  assert.equal(beta.memories.some((item) => item.id === "alpha-memory"), false);
});
