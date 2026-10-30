import fs from "node:fs";
import path from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { PatternDetector } from "./pattern-detector.js";
import { createObserver } from "./observer.js";
import { runSkillPromotionLoop } from "./skill-promotion-loop.js";
import { buildSkillMdFromPatterns } from "./skill-renderer-safe.js";
import { buildLongMemoryHint } from "./long-memory-retrieval.js";
import { recordActionFeedback } from "./action-runtime.js";
import { loadSkillCandidates } from "./skill-promotion-store.js";
import { DEFAULT_CONFIG, loadLearnerConfig, readJson, writeJson } from "./common.js";
import { runtimeConfigPath } from "./runtime-config-path.js";
import { normalizeSessionTarget } from "./helpers.js";
import { inferScope } from "./scope.js";
import { readEffectiveMemories } from "./managed-memory-store.js";

const MAX_SESSIONS = 64;

function paths(dataDir) {
  return {
    DATA_DIR: dataDir,
    PATTERNS_FILE: path.join(dataDir, "patterns.json"),
    CONFIG_FILE: runtimeConfigPath(dataDir),
    TURNS_FILE: path.join(dataDir, "turns.jsonl"),
    EXPERIENCE_LOG: path.join(dataDir, "experience_log.jsonl"),
    ERROR_LOG: path.join(dataDir, "error_log.jsonl"),
    EPISODES_FILE: path.join(dataDir, "episodes.jsonl"),
    ACTIVITY_LOG: path.join(dataDir, "activity_log.jsonl"),
    HISTORY_DIR: path.join(dataDir, "skill_history"),
    GENERATED_SKILL: path.join(dataDir, "generated", "skills", "self-learning", "SKILL.md"),
    REFLEXION_FILE: path.join(dataDir, "reflexion_memory.jsonl"),
  };
}

function ensurePaths(p) {
  fs.mkdirSync(p.DATA_DIR, { recursive: true });
  fs.mkdirSync(p.HISTORY_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(p.GENERATED_SKILL), { recursive: true });
  fs.mkdirSync(path.join(p.DATA_DIR, "proposals"), { recursive: true });
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
}

function textFromContent(content = []) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => part?.text || "").join(" ") : "";
}

function sessionTarget(session) {
  const header = session?.header || {};
  return normalizeSessionTarget({
    sessionId: session?.id || null,
    sessionRef: session?.id || null,
    sessionPath: header.cwd || null,
  });
}

function sessionMeta(session) {
  const target = sessionTarget(session);
  return { ...target, sessionPath: target.sessionPath || `sessions/${session?.id || "unknown"}` };
}

function createLegacyBus() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event, meta) {
      for (const listener of [...listeners]) {
        try { listener(event, meta); } catch { /* observer is fail-closed */ }
      }
    },
  };
}

function mapSessionEvent(session, event) {
  const meta = sessionMeta(session);
  const data = event?.data || {};
  switch (event?.type) {
    case "user/message":
      return [{ type: "user_message", message: data.message || data }, meta];
    case "tool/call":
      return [{ type: "tool_execution_start", toolName: data.name, name: data.name, args: data.arguments }, meta];
    case "tool/result": {
      const message = data.message || {};
      return [{
        type: "tool_execution_end",
        toolName: data.name || data.toolName || message.name || "tool",
        name: data.name || data.toolName || message.name || "tool",
        result: message,
        isError: Boolean(data.error || message.error || message.isError),
        error: data.error || message.error,
      }, meta];
    }
    case "assistant/message":
      return [{
        // A model response can request more tools. It is not a turn boundary.
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: textFromContent(data.message?.content || data.content || []) },
      }, meta];
    case "turn/end": {
      const reason = String(data.reason || "stop").toLowerCase();
      const stopReason = ["error", "failed", "failure"].some((value) => reason.includes(value))
        ? "error"
        : ["completed", "success", "stop", "end_turn"].some((value) => reason.includes(value)) ? "end_turn" : reason;
      return [{ type: "message_end", message: { role: "assistant", content: [], stopReason } }, meta];
    }
    default:
      return null;
  }
}

function createRuntimeContext(dataDir, pluginDir, log) {
  return {
    dataDir,
    pluginDir,
    log: {
      info: log?.info?.bind(log) || (() => {}),
      warn: log?.warn?.bind(log) || (() => {}),
      error: log?.error?.bind(log) || (() => {}),
      debug: log?.debug?.bind(log) || (() => {}),
    },
  };
}

export function createHarnessRuntime({ dataDir, pluginDir, log } = {}) {
  if (!dataDir) throw new Error("dataDir is required");
  const p = paths(path.resolve(dataDir));
  ensurePaths(p);
  const ctx = createRuntimeContext(p.DATA_DIR, pluginDir || p.DATA_DIR, log);
  const loaded = loadLearnerConfig(p.CONFIG_FILE, { persist: true });
  const config = {
    ...DEFAULT_CONFIG,
    ...loaded,
    autoActions: { ...(DEFAULT_CONFIG.autoActions || {}), ...(loaded.autoActions || {}), enabled: false },
  };
  // The copied observer reloads runtime-config.json at turn boundaries. Persist
  // the Harness safety override so that a user config with autoActions.enabled
  // true cannot silently re-enable the App-oriented action pipeline.
  writeJson(p.CONFIG_FILE, config);
  const detector = new PatternDetector(config);
  try { detector.restore(readJson(p.PATTERNS_FILE, [])); } catch { detector.restore([]); }
  const legacyBus = createLegacyBus();
  const sessions = new Map();
  const runtimeState = {
    sessionTargets: new Map(),
    pendingAdoptionChecks: new Map(),
    proposalNotifiedIds: new Map(),
    statusNotifiedAt: new Map(),
    sessionActivityCount: 0,
  };
  const configRef = { current: config };
  let started = false;
  let observedTurns = 0;
  let injectedTurns = 0;
  let unobserve = null;
  const toolCalls = new Map();
  const turnBuffers = new Map();

  const persist = () => {
    writeJson(p.PATTERNS_FILE, [...detector.patterns.values()]);
    detector.markClean?.();
  };
  const logActivity = (row) => appendJsonl(p.ACTIVITY_LOG, { at: new Date().toISOString(), ...row });
  const autoApprove = (sessionHandle = null, cached = null) => {
    const all = cached || detector.all();
    if (config.autoApproveHighConfidence !== true) return { count: 0, allPatterns: all };
    let count = 0;
    for (const item of all) {
      if (item.status !== "pending" || !item.injectable || item.type === "preference") continue;
      const stored = detector.patterns.get(item.id);
      if (!stored || stored.status !== "pending") continue;
      stored.status = "approved";
      stored.autoApproved = true;
      stored.reviewedAt = new Date().toISOString();
      count += 1;
    }
    if (count) detector.invalidate();
    return { count, allPatterns: detector.all() };
  };
  const renderSkill = () => {
    const content = buildSkillMdFromPatterns(detector.all(), config, { turnCount: detector.turnCount, dataDir: p.DATA_DIR });
    fs.mkdirSync(path.dirname(p.GENERATED_SKILL), { recursive: true });
    fs.writeFileSync(p.GENERATED_SKILL, content, "utf8");
    return { path: p.GENERATED_SKILL, bytes: Buffer.byteLength(content), activePatterns: detector.all().filter((item) => item.injectable).length };
  };
  const refreshSkill = () => { try { renderSkill(); } catch (error) { ctx.log.warn(`skill render skipped: ${error.message}`); } };

  const observer = createObserver({
    detector,
    sessions,
    runtimeState,
    persistPatterns: persist,
    refreshSkill,
    autoApprovePatterns: autoApprove,
    syncDiskStatus: () => {},
    pruneDataFiles: async () => {},
    maybeRunModelAdvisor: async () => {},
    maybeRunExtraction: async () => {},
    logActivity,
    recordUsage: () => {},
    configRef,
    ctx,
    paths: {
      DATA_DIR: p.DATA_DIR,
      TURNS_FILE: p.TURNS_FILE,
      EPISODES_FILE: p.EPISODES_FILE,
      EXPERIENCE_LOG: p.EXPERIENCE_LOG,
      ERROR_LOG: p.ERROR_LOG,
      CONFIG_FILE: p.CONFIG_FILE,
    },
    MAX_SESSIONS,
    actionPipelineState: { inFlight: false },
    actionBudgetState: {},
  });

  function observeSessionEvent(session, event) {
    const mapped = mapSessionEvent(session, event);
    if (!mapped) return;
    const sessionId = String(session?.id || "unknown");
    const buffer = turnBuffers.get(sessionId) || { tools: [], errors: [] };
    if (event.type === "tool/call" && event.data?.name) buffer.tools.push(event.data.name);
    if (event.type === "tool/result" && (event.data?.error || event.data?.message?.error || event.data?.message?.isError)) {
      const error = event.data.error || event.data.message.error || { code: "tool_failure" };
      buffer.errors.push({ errorType: error.code || error.name || "tool_failure", tool: buffer.tools.at(-1) || "tool" });
    }
    turnBuffers.set(sessionId, buffer);
    if (event.type === "tool/call" && event.data?.callId) {
      toolCalls.set(`${sessionId}:${event.data.callId}`, event.data.name || "tool");
    }
    if (event.type === "tool/result") {
      const callId = event.data?.callId;
      const toolName = toolCalls.get(`${sessionId}:${callId}`);
      if (toolName) mapped[0].toolName = toolName;
      if (callId) toolCalls.delete(`${sessionId}:${callId}`);
    }
    legacyBus.emit(mapped[0], mapped[1]);
    if (event.type === "turn/end") {
      observedTurns += 1;
      if (buffer.errors.length) {
        const target = sessionTarget(session);
        const project = inferScope({ sessionPath: target.sessionPath }).project;
        for (const failure of buffer.errors) appendJsonl(p.REFLEXION_FILE, {
          id: `reflexion:${sessionId}:${Date.now()}:${failure.tool}`,
          taskType: "general",
          actionType: failure.tool,
          errorType: failure.errorType,
          rootCause: "tool returned an error during the observed task",
          failure: { errorType: failure.errorType, tool: failure.tool },
          futureStrategy: { beforePatch: [`inspect ${failure.tool} inputs and preconditions`], afterPatch: ["run the verification step again"] },
          scope: { project },
          createdAt: new Date().toISOString(),
        });
      }
      const candidateStore = loadSkillCandidates(p.DATA_DIR);
      const candidateByAction = new Map(candidateStore.candidates.map((candidate) => [candidate.actionType, candidate]));
      const effective = buffer.errors.length === 0;
      for (const tool of [...new Set(buffer.tools)]) {
        const candidate = candidateByAction.get(tool);
        const judgedRegression = !effective && ["staged", "active", "measured"].includes(candidate?.status);
        recordActionFeedback(p.DATA_DIR, {
          actionId: `observed-turn:${sessionId}:${Date.now()}:${tool}`,
          actionType: tool,
          taskType: "general",
          ...(effective ? { effective: true, success: true } : judgedRegression ? { effective: false, regression: true, errorType: buffer.errors[0]?.errorType || "tool_failure" } : {}),
          reason: effective ? "observed turn completed without tool errors" : "observed tool failure",
        });
      }
      turnBuffers.delete(sessionId);
      persist();
      refreshSkill();
      try { evolveSkills({ dryRun: false }); } catch (error) { ctx.log.warn(`skill evolution skipped: ${error.message}`); }
    }
  }

  function buildInjection(query, project) {
    const scope = inferScope({ project, sessionPath: project ? `projects/${project}` : null });
    const hint = buildLongMemoryHint(readEffectiveMemories(p.DATA_DIR), query || "current task", {
      config,
      project: scope.project,
      memoryLayer: "core",
      limit: 8,
      maxTokens: config.maxSkillTokens,
    });
    if (!hint) return null;
    injectedTurns += 1;
    return `${hint}\nTreat these as scoped suggestions; verify them against the current request.`;
  }

  function evolveSkills(options = {}) {
    const result = runSkillPromotionLoop(p.DATA_DIR, { ...options, allowSkillFileWrite: false });
    const rendered = renderSkill();
    persist();
    return { ...result, rendered };
  }

  function status() {
    return {
      ok: true,
      started,
      dataDir: p.DATA_DIR,
      observedTurns,
      injectedTurns,
      autoActionsEnabled: config.autoActions?.enabled === true,
      patterns: detector.all().length,
      injectablePatterns: detector.all().filter((item) => item.injectable).length,
      skillCandidates: (() => { try { return readJson(path.join(p.DATA_DIR, "skill_candidates.json"), { candidates: [] }).candidates.length; } catch { return 0; } })(),
      activeSkills: (() => { try { return readJson(path.join(p.DATA_DIR, "active_skills.json"), { skills: [] }).skills.length; } catch { return 0; } })(),
    };
  }

  function start() {
    if (started) return status();
    observer.subscribe(legacyBus, config);
    started = true;
    refreshSkill();
    logActivity({ type: "harness_runtime_started", summary: "Native Harness observation, injection, and skill loop enabled." });
    return status();
  }

  function stop() {
    if (!started) return;
    unobserve?.();
    unobserve = null;
    observer.unsubscribe();
    persist();
    refreshSkill();
    started = false;
  }

  function attachToContext(harnessCtx) {
    start();
    const disposers = [];
    if (typeof harnessCtx?.on === "function") {
      disposers.push(harnessCtx.on("session/event", observeSessionEvent, { global: true }));
      disposers.push(harnessCtx.on("agent/pre-step", async (payload, next) => {
        const decision = await next();
        if (!decision || decision.kind !== "enter") return decision;
        const messages = Array.isArray(decision.messages) ? decision.messages : [];
        const query = messages.map((message) => textFromContent(message?.content)).join(" ").slice(-2000);
        const project = payload?.agent?.session?.header?.cwd
          ? inferScope({ sessionPath: payload.agent.session.header.cwd }).project
          : null;
        const text = buildInjection(query, project);
        if (!text) return decision;
        return {
          ...decision,
          kind: "enter",
          messages: [createUserMessage({ content: [{ type: "text", text }], source: { kind: "plugin", plugin: "runtime-self-learning-harness" } }), ...messages],
        };
      }, { global: true }));
    }
    if (typeof harnessCtx?.on === "function") {
      disposers.push(harnessCtx.on("agent/created", ({ agent }) => {
        const project = agent?.session?.header?.cwd ? inferScope({ sessionPath: agent.session.header.cwd }).project : null;
        const text = buildInjection("", project);
        if (text) agent.inject(createUserMessage({ content: [{ type: "text", text }], source: { kind: "plugin", plugin: "runtime-self-learning-harness" } }));
      }, { global: true }));
    }
    unobserve = () => { for (const dispose of disposers) { try { dispose?.(); } catch {} } };
    return status();
  }

  return { paths: p, detector, start, stop, attachToContext, observeSessionEvent, buildInjection, evolveSkills, renderSkill, status };
}
