import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const SKILL_EVIDENCE_VERSION = 2;
export const SKILL_VERIFICATION_SOURCE = "harness-contract-verifier";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function skillRuleDigest(rule) { return digest(rule); }

function feedbackDigest(row) {
  const { schemaVersion, createdAt, confidence, ...evidence } = row;
  return digest(evidence);
}

export function readSkillVerificationReceipts(dataDir) {
  const receipts = new Map();
  let content;
  try { content = fs.readFileSync(path.join(dataDir, "skill_verification_receipts.jsonl"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return receipts; throw error; }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const receipt = JSON.parse(line);
      if (receipt.id && receipt.feedbackSha256) receipts.set(receipt.id, receipt.feedbackSha256);
    } catch { /* A truncated receipt never authorizes feedback. */ }
  }
  return receipts;
}

export function hasSkillVerificationReceipt(row, receipts) {
  return receipts instanceof Map && receipts.get(row.feedbackId) === feedbackDigest(row);
}

function loadContract(dataDir, candidate, project) {
  let registry;
  try { registry = JSON.parse(fs.readFileSync(path.join(dataDir, "skill_verification_contracts.json"), "utf8")); }
  catch (error) { throw new Error(`host skill verification contract unavailable: ${error.code || error.message}`); }
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.contracts)) throw new Error("invalid host skill verification contract registry");
  const matches = registry.contracts.filter((contract) => contract.candidateId === candidate.id);
  if (matches.length !== 1) throw new Error("exactly one host skill verification contract is required for this candidate");
  const contract = matches[0];
  if (project !== (candidate.scope?.project || "general") || contract.project !== project) {
    throw new Error("skill verification contract project does not match the candidate and current session");
  }
  if (contract.rule !== candidate.rule) throw new Error("skill verification contract does not pin the current candidate strategy");
  const strategy = contract.strategy;
  const check = contract.verification;
  if (strategy?.tool !== candidate.actionType || !strategy.arguments || typeof strategy.arguments !== "object") {
    throw new Error("skill verification contract requires exact strategy tool arguments");
  }
  if (!check?.tool || !check.arguments || typeof check.arguments !== "object"
    || !Array.isArray(check.resultPath) || check.resultPath.length === 0
    || check.resultPath.some((key) => typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))
    || !Object.hasOwn(check, "successValue") || !Object.hasOwn(check, "regressionValue")
    || isDeepStrictEqual(check.successValue, check.regressionValue)) {
    throw new Error("skill verification contract requires a structured result assertion with distinct success and regression values");
  }
  if (strategy.tool === check.tool && isDeepStrictEqual(strategy.arguments, check.arguments)) {
    throw new Error("skill verification must be a separate check from the strategy action");
  }
  if ([strategy.tool, check.tool].some((name) => name.startsWith("learning_") || name.startsWith("memory_"))) {
    throw new Error("learning and memory tools cannot verify their own skill feedback");
  }
  return { contract, contractSha256: digest(contract) };
}

function matchesExecution(execution, plan) {
  if (!execution.callId || !execution.completed || !execution.nativeResult || execution.error || execution.toolName !== plan.tool) return false;
  try { return isDeepStrictEqual(JSON.parse(execution.arguments), plan.arguments); }
  catch { return false; }
}

export function beginSkillTrial(dataDir, candidate, buffer, { sessionId, project }) {
  if (buffer.skillTrial) throw new Error("complete the current skill trial before starting another in this session");
  const { contract, contractSha256 } = loadContract(dataDir, candidate, project);
  const trial = {
    id: `skill_trial:${randomUUID()}`,
    candidateId: candidate.id,
    sessionId,
    project,
    contract,
    contractSha256,
    startOrder: buffer.sequence,
  };
  buffer.skillTrial = trial;
  return {
    ok: true, status: "shown", trialId: trial.id, candidateId: candidate.id,
    rule: candidate.rule, strategy: contract.strategy, verification: contract.verification,
  };
}

export function completeSkillTrial(dataDir, candidate, buffer, { sessionId, project, trialId }) {
  const trial = buffer?.skillTrial;
  if (!trial || trial.id !== trialId || trial.candidateId !== candidate.id || trial.sessionId !== sessionId) {
    throw new Error("skill feedback requires a pending trial in the same Harness session turn");
  }
  const current = loadContract(dataDir, candidate, project);
  if (current.contractSha256 !== trial.contractSha256) throw new Error("skill verification contract changed during the trial");
  const executions = buffer.executions.filter((execution) => execution.order > trial.startOrder);
  const strategy = executions.find((execution) => matchesExecution(execution, trial.contract.strategy));
  if (!strategy) throw new Error("strategy application is not backed by a matching successful Harness tool result");
  const check = executions.find((execution) => execution.order > strategy.resultOrder
    && execution.callId !== strategy.callId && matchesExecution(execution, trial.contract.verification));
  if (!check) throw new Error("skill verification requires a separate, later successful Harness tool result");
  let result;
  try { result = JSON.parse(check.resultText); }
  catch { throw new Error("skill verification tool must return a structured JSON assertion result"); }
  let value = result;
  for (const key of trial.contract.verification.resultPath) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("skill verification result is missing the configured assertion");
    value = value[key];
  }
  const success = isDeepStrictEqual(value, trial.contract.verification.successValue);
  const regression = isDeepStrictEqual(value, trial.contract.verification.regressionValue);
  if (!success && !regression) throw new Error("skill verification result has no configured success or regression verdict");
  const row = {
    feedbackId: trial.id,
    actionId: trial.id,
    skillCandidateId: candidate.id,
    actionType: candidate.actionType,
    errorType: candidate.errorType,
    scope: { project },
    taskType: "general",
    displayed: true,
    strategyApplied: true,
    verification: {
      verified: true,
      source: SKILL_VERIFICATION_SOURCE,
      contractSha256: trial.contractSha256,
      ruleSha256: skillRuleDigest(candidate.rule),
      resultPath: trial.contract.verification.resultPath,
      observed: value,
    },
    executionEvidence: {
      source: SKILL_VERIFICATION_SOURCE,
      sessionId,
      project,
      strategyCallId: strategy.callId,
      verificationCallId: check.callId,
      strategyArgumentsSha256: digest(trial.contract.strategy.arguments),
      verificationArgumentsSha256: digest(trial.contract.verification.arguments),
      verificationResultSha256: digest(result),
    },
    effective: success,
    success,
    regression,
    reason: "Host-configured strategy and structured verification assertion matched observed session events",
  };
  const receipt = { id: trial.id, feedbackSha256: feedbackDigest(row), createdAt: new Date().toISOString() };
  fs.appendFileSync(path.join(dataDir, "skill_verification_receipts.jsonl"), `${JSON.stringify(receipt)}\n`, "utf8");
  buffer.skillTrial = null;
  return row;
}
