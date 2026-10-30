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
  await registered.get("memory_upsert").execute({ id: "auto-memory", memory: { type: "preference", desc: "Remember the verified workflow" } });
  const event = handlers.get("session/event");
  event(session, { type: "user/message", data: { message: { role: "user", content: [{ type: "text", text: "remember this workflow" }] } } });
  event(session, { type: "tool/call", data: { callId: "call-1", name: "fs_read", arguments: "{}" } });
  event(session, { type: "tool/result", data: { callId: "call-1", message: { content: [{ type: "text", text: "ok" }] } } });
  event(session, { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "done" }] } } });

  const decision = await handlers.get("agent/pre-step")({
    agent: { session }, messages: [{ role: "user", content: [{ type: "text", text: "remember this workflow" }] }],
  }, async () => ({ kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "remember this workflow" }] }] }));
  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages.length, 2);
  assert.match(decision.messages[0].content[0].text, /verified workflow/i);
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
  }
  const evolved = await registered.get("learning_skill_evolve").execute({ options: { dryRun: true, promotionThreshold: 3 } });
  assert.equal(evolved.ok, true);
  assert.ok(evolved.counts.promotableClusters >= 1);
  assert.ok(evolved.candidates.length >= 1);
});
