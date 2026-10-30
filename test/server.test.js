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

function emitToolCall(event, session, callId, name, args) {
  event(session, { type: "tool/call", data: { callId, name, arguments: JSON.stringify(args) } });
}

function emitToolResult(event, session, callId, text, { errorCode = null } = {}) {
  const isError = Boolean(errorCode);
  event(session, {
    type: "tool/result",
    data: {
      ...(errorCode ? { error: { code: errorCode } } : {}),
      message: {
        role: "user",
        source: { kind: "tool", callId },
        content: [{
          type: "tool-result",
          toolCallId: callId,
          isError,
          content: [{ type: "text", text }],
        }],
      },
    },
  });
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
    emitToolCall(event, session, `call-${i}`, "shell_exec", { command: "run restricted action" });
    emitToolResult(event, session, `call-${i}`, "permission denied", { errorCode: "permission_denied" });
    event(session, { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "failed" }] } } });
    event(session, { type: "turn/end", data: { reason: "error" } });
  }
  const automaticCandidates = JSON.parse(await fs.readFile(path.join(dataDir, "skill_candidates.json"), "utf8"));
  assert.ok(automaticCandidates.candidates.length >= 1);
  const evolved = await registered.get("learning_skill_evolve").execute({ options: { dryRun: true, promotionThreshold: 3 } });
  assert.equal(evolved.ok, true);
  assert.ok(evolved.counts.promotableClusters >= 1);
  assert.ok(evolved.candidates.length >= 1);
  const candidate = automaticCandidates.candidates[0];
  const candidateId = candidate.id;
  await fs.writeFile(path.join(dataDir, "skill_verification_contracts.json"), JSON.stringify({
    schemaVersion: 1,
    contracts: [{
      candidateId,
      project: "skill",
      rule: candidate.rule,
      strategy: { tool: candidate.actionType, arguments: { command: "apply candidate strategy" } },
      verification: {
        tool: "test_runner", arguments: { command: "run candidate check" },
        resultPath: ["checks", "repair"], successValue: true, regressionValue: false,
      },
    }],
  }));
  for (let i = 0; i < 7; i += 1) {
    const session = { id: `feedback-session-${i}`, header: { cwd: path.join(dataDir, "projects", "skill") } };
    const exec = { agent: { id: `feedback-agent-${i}`, session } };
    const trial = await registered.get("learning_skill_feedback").execute({ candidateId, phase: "begin" }, exec);
    emitToolCall(event, session, `strategy-call-${i}`, candidate.actionType, { command: "apply candidate strategy" });
    emitToolResult(event, session, `strategy-call-${i}`, "strategy applied");
    emitToolCall(event, session, `verification-call-${i}`, "test_runner", { command: "run candidate check" });
    emitToolResult(event, session, `verification-call-${i}`, JSON.stringify({ checks: { repair: true } }));
    const result = await registered.get("learning_skill_feedback").execute({ candidateId, phase: "complete", trialId: trial.trialId }, exec);
    assert.equal(result.outcome, "success");
    event(session, { type: "turn/end", data: { reason: "completed" } });
  }
  const active = await registered.get("learning_skill_evolve").execute({ options: { minSuccess: 1, activeSuccess: 7 } });
  assert.ok(active.activeSkills.some((skill) => skill.id.includes("shell_exec")));
  const regressionSession = { id: "feedback-regression-session", header: { cwd: path.join(dataDir, "projects", "skill") } };
  const preStep = await handlers.get("agent/pre-step")({
    agent: { id: "active-agent", session: regressionSession },
    messages: [{ role: "user", content: [{ type: "text", text: "use shell_exec" }] }],
  }, async () => ({ kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "use shell_exec" }] }] }));
  assert.match(preStep.messages[0].content[0].text, /active-skill/);
  const regressionExec = { agent: { id: "different-agent-id", session: regressionSession } };
  const trial = await registered.get("learning_skill_feedback").execute({ candidateId, phase: "begin" }, regressionExec);
  emitToolCall(event, regressionSession, "regression-strategy-call", candidate.actionType, { command: "apply candidate strategy" });
  emitToolResult(event, regressionSession, "regression-strategy-call", "strategy applied");
  emitToolCall(event, regressionSession, "regression-verification-call", "test_runner", { command: "run candidate check" });
  emitToolResult(event, regressionSession, "regression-verification-call", JSON.stringify({ checks: { repair: false } }));
  const feedback = await registered.get("learning_skill_feedback").execute({ candidateId, phase: "complete", trialId: trial.trialId }, regressionExec);
  assert.equal(feedback.outcome, "regression");
  event(regressionSession, { type: "turn/end", data: { reason: "completed" } });
  const regressed = await registered.get("learning_skill_evolve").execute({ options: { minSuccess: 1, activeSuccess: 7 } });
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

test("identical failures in different projects create isolated skill candidates", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-project-candidates-"));
  const handlers = new Map();
  const ctx = {
    dataDir, pluginDir: dataDir,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, listener) { handlers.set(name, listener); return () => {}; },
    tools: { register() { return () => {}; } },
  };
  apply(ctx);
  const event = handlers.get("session/event");
  for (const project of ["alpha", "beta"]) {
    for (let i = 0; i < 3; i += 1) {
      const session = { id: `${project}-session-${i}`, header: { cwd: path.join(dataDir, "projects", project) } };
      const callId = `${project}-call-${i}`;
      emitToolCall(event, session, callId, "shell_exec", { command: "run restricted action" });
      emitToolResult(event, session, callId, "permission denied", { errorCode: "permission_denied" });
      event(session, { type: "turn/end", data: { reason: "error" } });
    }
  }
  const store = JSON.parse(await fs.readFile(path.join(dataDir, "skill_candidates.json"), "utf8"));
  const projectCandidates = store.candidates.filter((candidate) => ["alpha", "beta"].includes(candidate.scope?.project));
  assert.equal(projectCandidates.length, 2);
  assert.notEqual(projectCandidates[0].id, projectCandidates[1].id);
  assert.deepEqual(new Set(projectCandidates.map((candidate) => candidate.scope.project)), new Set(["alpha", "beta"]));
});

test("ordinary successful turns do not create skill verification evidence", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-no-auto-skill-evidence-"));
  const handlers = new Map();
  const candidate = {
    id: "skill_candidate:alpha:shell_exec:permission_denied",
    actionType: "shell_exec",
    errorType: "permission_denied",
    rule: "Apply the project-specific recovery strategy and run its test.",
    scope: { project: "alpha", taskTypes: ["general"] },
    status: "active",
    identityVersion: 2,
    evidence: { verificationVersion: 2, successCount: 7, regressionCount: 0 },
  };
  await fs.writeFile(path.join(dataDir, "skill_candidates.json"), JSON.stringify({ candidates: [candidate] }));
  await fs.writeFile(path.join(dataDir, "active_skills.json"), JSON.stringify({ skills: [candidate] }));
  const ctx = {
    dataDir, pluginDir: dataDir,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, listener) { handlers.set(name, listener); return () => {}; },
    tools: { register() { return () => {}; } },
  };
  apply(ctx);
  const session = { id: "session-alpha", header: { cwd: path.join(dataDir, "projects", "alpha") } };
  await handlers.get("agent/pre-step")({
    agent: { id: session.id, session },
    messages: [{ role: "user", content: [{ type: "text", text: "run the task" }] }],
  }, async () => ({ kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "run the task" }] }] }));
  const event = handlers.get("session/event");
  const callId = "ordinary-call";
  emitToolCall(event, session, callId, "shell_exec", { command: "unrelated task" });
  emitToolResult(event, session, callId, "completed");
  event(session, { type: "turn/end", data: { reason: "completed" } });
  let feedback = "";
  try { feedback = await fs.readFile(path.join(dataDir, "action_feedback.jsonl"), "utf8"); } catch (error) { assert.equal(error.code, "ENOENT"); }
  assert.equal(feedback.includes(candidate.id), false);
});

test("skill feedback rejects a verified boolean without observed execution evidence", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-unverified-skill-feedback-"));
  const registered = new Map();
  const ctx = {
    dataDir, pluginDir: dataDir,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    on() { return () => {}; },
    tools: { register(tool) { registered.set(tool.name, tool); return () => {}; } },
  };
  apply(ctx);
  const candidate = {
    id: "skill_candidate:alpha:shell_exec:permission_denied",
    actionType: "shell_exec",
    errorType: "permission_denied",
    rule: "Apply the recovery strategy and verify it.",
    scope: { project: "alpha", taskTypes: ["general"] },
    evidence: { failureCount: 3, successCount: 0, regressionCount: 0, feedbackIds: [] },
  };
  await fs.writeFile(path.join(dataDir, "skill_candidates.json"), JSON.stringify({ candidates: [candidate] }));
  await assert.rejects(
    registered.get("learning_skill_feedback").execute({
      candidateId: candidate.id,
      outcome: "success",
      verification: { verified: true, reason: "the caller says it passed" },
    }),
    /execution evidence|strategy application|missing required property "phase"/i,
  );
});
