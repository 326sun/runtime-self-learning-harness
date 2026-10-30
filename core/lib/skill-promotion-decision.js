import { nowIso } from "./skill-promotion-store.js";
import { SKILL_EVIDENCE_VERSION, SKILL_VERIFICATION_SOURCE, hasSkillVerificationReceipt, skillRuleDigest } from "./skill-feedback-verifier.js";

function updateSkillEvidence(candidate, row) {
  const evidence = candidate.evidence || {};
  const verified = row.verification?.verified === true && row.strategyApplied === true;
  const effective = verified && (row.effective === true || row.success === true);
  const regressed = verified && (row.regression === true || row.effective === false);
  return {
    ...candidate,
    evidence: {
      ...evidence,
      verificationVersion: SKILL_EVIDENCE_VERSION,
      successCount: (evidence.successCount || 0) + (effective ? 1 : 0),
      regressionCount: (evidence.regressionCount || 0) + (regressed ? 1 : 0),
      failureCount: (evidence.failureCount || 0) + (regressed ? 1 : 0),
      shownCount: (evidence.shownCount || 0) + (row.displayed === true ? 1 : 0),
      appliedCount: (evidence.appliedCount || 0) + (row.strategyApplied === true ? 1 : 0),
      verifiedCount: (evidence.verifiedCount || 0) + (verified ? 1 : 0),
    },
  };
}

function decideSkillPromotion(candidate, { minSuccess, maxRegression }) {
  const success = Number(candidate.evidence?.successCount || 0);
  const regression = Number(candidate.evidence?.regressionCount || 0);
  if (success >= minSuccess && regression <= (maxRegression ?? 0)) return { decision: "stage", reason: `success ${success} >= ${minSuccess}` };
  if (regression > 0) return { decision: "decay", reason: `regression ${regression} > ${maxRegression ?? 0}` };
  return { decision: "keep_candidate", reason: "needs more evidence" };
}

function applySkillDecay(candidate, { now = Date.now(), halfLifeDays = 30 } = {}) {
  const days = (now - Date.parse(candidate.updatedAt || candidate.createdAt || now)) / 86400000;
  const decayedConfidence = (candidate.confidence || 1) * Math.pow(0.5, days / Math.max(1, halfLifeDays));
  return { ...candidate, confidence: decayedConfidence, decayed: decayedConfidence < 0.1 };
}

export function mergeCandidate(existing = {}, incoming = {}, { now = Date.now() } = {}) {
  const existingEvidence = existing.evidence || {};
  const incomingEvidence = incoming.evidence || {};
  const reflexionIds = [...new Set([...(existingEvidence.reflexionIds || []), ...(incomingEvidence.reflexionIds || [])])];
  const feedbackIds = [...new Set([...(existingEvidence.feedbackIds || []), ...(incomingEvidence.feedbackIds || [])])];
  return {
    ...incoming,
    ...existing,
    evidence: {
      ...incomingEvidence,
      ...existingEvidence,
      failureCount: Math.max(Number(existingEvidence.failureCount || 0), Number(incomingEvidence.failureCount || 0)),
      successCount: Number(existingEvidence.successCount || incomingEvidence.successCount || 0),
      regressionCount: Number(existingEvidence.regressionCount || incomingEvidence.regressionCount || 0),
      reflexionIds,
      feedbackIds,
    },
    scope: { ...(incoming.scope || {}), ...(existing.scope || {}) },
    tokenCost: existing.tokenCost || incoming.tokenCost,
    status: existing.status || incoming.status || "candidate",
    createdAt: existing.createdAt || incoming.createdAt || nowIso(now),
    updatedAt: nowIso(now),
  };
}

function feedbackKey(row = {}) {
  return row.feedbackId || row.id || [row.createdAt, row.actionId, row.actionType, row.effective, row.success, row.regression].map((v) => String(v ?? "")).join("|");
}

function candidateErrorType(candidate = {}) {
  return candidate.errorType || candidate.evidence?.errorType || candidate.sourceErrorType || String(candidate.rule || "").match(/Before ([^ ]+) repair/)?.[1] || null;
}

function feedbackMatchesCandidate(candidate = {}, row = {}, receipts) {
  if (row.skillCandidateId !== candidate.id) return false;
  if (row.strategyApplied !== true || row.verification?.verified !== true) return false;
  if (row.verification?.source !== SKILL_VERIFICATION_SOURCE) return false;
  if (row.verification.ruleSha256 !== skillRuleDigest(candidate.rule)) return false;
  if (row.executionEvidence?.source !== SKILL_VERIFICATION_SOURCE || !hasSkillVerificationReceipt(row, receipts)) return false;
  if (!row.executionEvidence?.strategyCallId || !row.executionEvidence?.verificationCallId) return false;
  if (row.executionEvidence.strategyCallId === row.executionEvidence.verificationCallId) return false;
  const scopeTaskTypes = Array.isArray(candidate.scope?.taskTypes) ? candidate.scope.taskTypes : [];
  const taskTypeMatches = !row.taskType || scopeTaskTypes.length === 0 || scopeTaskTypes.includes(row.taskType);
  const errorType = candidateErrorType(candidate);
  const candidateProject = candidate.scope?.project || "general";
  const rowProject = row.scope?.project;
  const projectMatches = typeof rowProject === "string" && candidateProject === rowProject
    && row.executionEvidence.project === candidateProject;
  const errorMatches = row.errorType === errorType;
  const actionTypeMatches = row.actionType === candidate.actionType;
  return taskTypeMatches && errorMatches && actionTypeMatches && projectMatches
    && (row.effective === true || row.effective === false || row.success === true || row.regression === true);
}

export function absorbFeedback(candidate = {}, feedbackRows = [], receipts = new Map()) {
  let next = candidate;
  const seen = new Set(candidate.evidence?.feedbackIds || []);
  let consumed = 0;
  for (const row of feedbackRows) {
    if (!feedbackMatchesCandidate(next, row, receipts)) continue;
    const key = feedbackKey(row);
    if (!key || seen.has(key)) continue;
    next = updateSkillEvidence(next, row);
    next.evidence = { ...(next.evidence || {}), feedbackIds: [...new Set([...(next.evidence?.feedbackIds || []), key])] };
    seen.add(key);
    consumed += 1;
  }
  return { candidate: next, consumed };
}

export function transitionCandidate(candidate = {}, options = {}) {
  const {
    minSuccess = 5,
    activeSuccess = 7,
    maxRegression = 0,
    now = Date.now(),
    halfLifeDays = 30,
    removeDecayedBelow = 0.15,
  } = options;
  const beforeStatus = candidate.status || "candidate";
  let next = applySkillDecay(candidate, { now, halfLifeDays });
  let decision = decideSkillPromotion(next, { minSuccess, maxRegression });
  let reason = decision.reason;

  if (decision.decision === "decay" || next.decayed) {
    next = { ...next, status: beforeStatus === "decayed" && Number(next.confidence || 0) < removeDecayedBelow ? "removed" : "decayed", updatedAt: nowIso(now) };
    return { candidate: next, decision: next.status, reason: decision.reason || "candidate decayed below confidence threshold", beforeStatus };
  }

  const successCount = Number(next.evidence?.successCount || 0);
  if (decision.decision === "stage") {
    if (["staged", "active", "measured"].includes(beforeStatus) && successCount >= activeSuccess) {
      next = { ...next, status: "active", activatedAt: next.activatedAt || nowIso(now), updatedAt: nowIso(now) };
      decision = { decision: "activate", reason: `success ${successCount} >= ${activeSuccess}` };
    } else {
      next = { ...next, status: "staged", stagedAt: next.stagedAt || nowIso(now), updatedAt: nowIso(now) };
    }
    reason = decision.reason;
  } else if (!next.status) {
    next = { ...next, status: "candidate", updatedAt: nowIso(now) };
  }

  return { candidate: next, decision: decision.decision, reason, beforeStatus };
}

export function upsertActiveSkill(registry, candidate) {
  const skills = [...(registry.skills || [])];
  const skill = {
    id: candidate.id,
    identityVersion: candidate.identityVersion,
    rule: candidate.rule,
    scope: candidate.scope,
    evidence: candidate.evidence,
    tokenCost: candidate.tokenCost,
    status: "active",
    source: candidate.source,
    activatedAt: candidate.activatedAt || new Date().toISOString(),
  };
  const index = skills.findIndex((item) => item.id === skill.id);
  if (index >= 0) skills[index] = { ...skills[index], ...skill, updatedAt: nowIso() };
  else skills.push(skill);
  return { ...registry, skills };
}
