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
import { selectInjectableActiveSkills } from "./skill-renderer.js";
import { estimateTokens } from "./common.js";
import { DEFAULT_CONFIG, loadLearnerConfig, readJson, writeJson } from "./common.js";
import { runtimeConfigPath } from "./runtime-config-path.js";
import { normalizeSessionTarget } from "./helpers.js";
import { inferScope } from "./scope.js";
import { readEffectiveMemories } from "./managed-memory-store.js";
import { beginSkillTrial, completeSkillTrial } from "./skill-feedback-verifier.js";

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

function createTurnBuffer() {
  return { errors: [], injectedSkillIds: [], executions: [], sequence: 0 };
}

function toolResultCallId(data = {}) {
  const message = data.message || {};
  const resultBlock = Array.isArray(message.content)
    ? message.content.find((block) => block?.type === "tool-result")
    : null;
  return data.callId || message.source?.callId || resultBlock?.toolCallId || null;
}

function toolResultError(data = {}) {
  const message = data.message || {};
  const resultBlocks = Array.isArray(message.content)
    ? message.content.filter((block) => block?.type === "tool-result")
    : [];
  const failedBlock = resultBlocks.find((block) => block.isError === true);
  if (!data.error && !message.error && message.isError !== true && !failedBlock) return null;
  return data.error || message.error || failedBlock?.error || { code: "tool_failure" };
}

function isNativeToolResult(data = {}, callId) {
  const message = data.message;
  const block = message?.content?.[0];
  return Boolean(message?.source?.kind === "tool" && message.source.callId === callId
    && message.content.length === 1 && block?.type === "tool-result"
    && block.toolCallId === callId && Array.isArray(block.content) && typeof block.isError === "boolean");
}

function toolResultText(message = {}) {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const resultBlocks = blocks.filter((block) => block?.type === "tool-result");
  const content = resultBlocks.length
    ? resultBlocks.flatMap((block) => Array.isArray(block.content) ? block.content : [])
    : blocks;
  return textFromContent(content);
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
    case "user/message": {
      const message = data.message || data;
      if (message.source?.kind && message.source.kind !== "user") return null;
      return [{ type: "user_message", message }, meta];
    }
    case "tool/call":
      return [{ type: "tool_execution_start", toolName: data.name, name: data.name, args: data.arguments }, meta];
    case "tool/result": {
      const message = data.message || {};
      return [{
        type: "tool_execution_end",
        toolName: data.name || data.toolName || message.name || "tool",
        name: data.name || data.toolName || message.name || "tool",
        result: message,
        isError: Boolean(toolResultError(data)),
        error: toolResultError(data),
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
    activeSkillsInjectionEnabled: true,
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
  const turnBuffers = new Map();
  const agentSessionIds = new Map();

  function sessionIdForAgent(agent) {
    if (!agent || typeof agent !== "object") return null;
    const agentId = agent.id == null ? null : String(agent.id);
    const sessionId = agent.session?.id ?? agent.session?.header?.id;
    if (agentId && sessionId != null) {
      agentSessionIds.set(agentId, String(sessionId));
      while (agentSessionIds.size > MAX_SESSIONS) agentSessionIds.delete(agentSessionIds.keys().next().value);
    }
    return sessionId != null ? String(sessionId) : agentId ? agentSessionIds.get(agentId) || null : null;
  }

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
    const buffer = turnBuffers.get(sessionId) || createTurnBuffer();
    if (event.type === "tool/call") {
      buffer.sequence += 1;
      buffer.executions.push({
        callId: event.data?.callId == null ? null : String(event.data.callId),
        toolName: event.data?.name || "tool",
        arguments: event.data?.arguments || "",
        order: buffer.sequence,
        completed: false,
      });
    }
    if (event.type === "tool/result") {
      const callId = toolResultCallId(event.data);
      const execution = callId == null ? null : buffer.executions.findLast((item) => item.callId === String(callId));
      const error = toolResultError(event.data);
      if (execution && !execution.completed) {
        buffer.sequence += 1;
        execution.completed = true;
        execution.resultOrder = buffer.sequence;
        execution.error = error;
        execution.nativeResult = isNativeToolResult(event.data, callId);
        execution.resultText = toolResultText(event.data?.message);
        mapped[0].toolName = execution.toolName;
      }
      if (error) {
        buffer.errors.push({
          errorType: error.code || error.name || "tool_failure",
          tool: execution?.toolName || event.data?.name || "tool",
        });
      }
    }
    turnBuffers.set(sessionId, buffer);
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
      turnBuffers.delete(sessionId);
      persist();
      refreshSkill();
      try { evolveSkills({ dryRun: false }); } catch (error) { ctx.log.warn(`skill evolution skipped: ${error.message}`); }
    }
  }

  function buildInjection(query, project, sessionId = null) {
    const scope = inferScope({ project, sessionPath: project ? `projects/${project}` : null });
    const hint = buildLongMemoryHint(readEffectiveMemories(p.DATA_DIR), query || "current task", {
      config,
      project: scope.project,
      memoryLayer: "core",
      limit: 8,
      maxTokens: config.maxSkillTokens,
    });
    const skills = selectInjectableActiveSkills(p.DATA_DIR, config, { project: scope.project });
    const suffix = "\nTreat these as scoped suggestions; verify them against the current request.";
    let text = hint || "";
    let skillHeaderAdded = false;
    for (const skill of skills) {
      const line = `- [active-skill:${skill.id}] ${String(skill.rule).replace(/\s+/g, " ").trim().slice(0, 240)}`;
      const proposed = `${text}${skillHeaderAdded ? "" : "\nACTIVE_VALIDATED_SKILLS:"}\n${line}`;
      if (estimateTokens(`${proposed}${suffix}`) > Number(config.maxSkillTokens || DEFAULT_CONFIG.maxSkillTokens)) continue;
      text = proposed;
      skillHeaderAdded = true;
      if (sessionId) {
        const buffer = turnBuffers.get(String(sessionId)) || createTurnBuffer();
        buffer.injectedSkillIds = [...new Set([...buffer.injectedSkillIds, skill.id])];
        turnBuffers.set(String(sessionId), buffer);
        logActivity({ type: "skill.shown", candidateId: skill.id });
      }
    }
    if (!text) return null;
    injectedTurns += 1;
    return `${text}${suffix}`;
  }

  function recordSkillFeedback(input = {}, executionContext = {}) {
    const { candidateId, phase, trialId } = input;
    const candidate = loadSkillCandidates(p.DATA_DIR).candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error(`skill candidate not found: ${candidateId}`);
    const sessionId = executionContext.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("skill feedback requires the active Harness session execution evidence");
    }
    const project = inferScope({ sessionPath: executionContext.sessionPath }).project;
    if (project !== (candidate.scope?.project || "general")) throw new Error("skill feedback project does not match the candidate scope");
    const buffer = turnBuffers.get(sessionId) || createTurnBuffer();
    if (phase === "begin") {
      if (candidate.status === "active" && !buffer.injectedSkillIds.includes(candidate.id)) {
        throw new Error("active skill feedback requires the candidate to have been injected in this session");
      }
      const result = beginSkillTrial(p.DATA_DIR, candidate, buffer, { sessionId, project });
      turnBuffers.set(sessionId, buffer);
      logActivity({ type: "skill_trial.shown", candidateId, trialId: result.trialId });
      return result;
    }
    if (phase !== "complete") throw new Error("skill feedback phase must be begin or complete");
    const row = completeSkillTrial(p.DATA_DIR, candidate, buffer, { sessionId, project, trialId });
    const recorded = recordActionFeedback(p.DATA_DIR, row);
    if (!recorded.ok) throw new Error(recorded.error || "skill feedback could not be recorded");
    logActivity({ type: "skill_trial.verified", candidateId, trialId: row.feedbackId, success: row.success });
    return { ...evolveSkills({ dryRun: false }), outcome: row.success ? "success" : "regression", trialId: row.feedbackId };
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
    turnBuffers.clear();
    agentSessionIds.clear();
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
        const text = buildInjection(query, project, sessionIdForAgent(payload?.agent));
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
        const text = buildInjection("", project, sessionIdForAgent(agent));
        if (text) agent.inject(createUserMessage({ content: [{ type: "text", text }], source: { kind: "plugin", plugin: "runtime-self-learning-harness" } }));
      }, { global: true }));
    }
    unobserve = () => { for (const dispose of disposers) { try { dispose?.(); } catch {} } };
    return status();
  }

  return { paths: p, detector, start, stop, attachToContext, observeSessionEvent, buildInjection, evolveSkills, recordSkillFeedback, renderSkill, status };
}
