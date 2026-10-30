import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { safeFileSlug } from "./common.js";
import { readActionFeedback } from "./action-runtime.js";
import { loadActiveSkills, loadSkillCandidates, nowIso, saveActiveSkills, saveSkillCandidates } from "./skill-promotion-store.js";
import { absorbFeedback, mergeCandidate, transitionCandidate, upsertActiveSkill } from "./skill-promotion-decision.js";
import { SKILL_EVIDENCE_VERSION, readSkillVerificationReceipts } from "./skill-feedback-verifier.js";

export {
  activeSkillRegistryPath,
  loadActiveSkills,
  loadSkillCandidates,
  saveActiveSkills,
  saveSkillCandidates,
  skillCandidateStorePath,
} from "./skill-promotion-store.js";

// ── Inlined from skill-reflexion-cluster.js ──

const REFLEXION_FILE = "reflexion_memory.jsonl";

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, "utf-8"); } catch { return []; }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function readReflexions(learnerDir) {
  return readJsonl(path.join(learnerDir, REFLEXION_FILE)).filter((row) => row && row.id);
}

function clusterKey(reflexion = {}) {
  return JSON.stringify([
    reflexion.scope?.project || reflexion.context?.project || "general",
    reflexion.taskType || "general",
    reflexion.actionType || "unknown_action",
    reflexion.failure?.errorType || reflexion.errorType || "unknown_error",
    reflexion.rootCause || "unknown_root_cause",
    JSON.stringify({
      beforePatch: reflexion.futureStrategy?.beforePatch || [],
      afterPatch: reflexion.futureStrategy?.afterPatch || [],
    }),
  ].map((part) => String(part || "").trim()));
}

function clusterReflexions(reflexions, { promotionThreshold = 3 } = {}) {
  const clusters = new Map();
  for (const reflexion of reflexions) {
    const key = clusterKey(reflexion);
    const existing = clusters.get(key) || { clusterId: `cluster:${key}`, items: [], key };
    existing.items.push(reflexion);
    existing.taskType = reflexion.taskType || existing.taskType;
    existing.actionType = reflexion.actionType || existing.actionType;
    existing.errorType = reflexion.failure?.errorType || reflexion.errorType || existing.errorType;
    existing.rootCause = reflexion.rootCause || existing.rootCause;
    existing.futureStrategy = reflexion.futureStrategy || existing.futureStrategy;
    existing.scope = { ...(existing.scope || {}), ...(reflexion.scope || {}), project: reflexion.scope?.project || reflexion.context?.project || "general" };
    clusters.set(key, existing);
  }
  return [...clusters.values()].map((cluster) => ({
    ...cluster,
    promotionCandidate: cluster.items.length >= Number(promotionThreshold || 3),
  }));
}

// ── Inlined from skill-candidate-factory.js ──

function slug(value) {
  return safeFileSlug(value, "unknown", 80).replace(/^_+|_+$/g, "") || "unknown";
}

function createSkillCandidateFromCluster(cluster = {}, { scope = {} } = {}) {
  if (!cluster.promotionCandidate) return null;
  const errorType = cluster.errorType || "unknown_error";
  const actionType = cluster.actionType || "unknown_action";
  const project = cluster.scope?.project || scope.project || "general";
  const projectKey = `${slug(project)}-${createHash("sha256").update(String(project)).digest("hex").slice(0, 10)}`;
  const identityKey = createHash("sha256").update(cluster.key).digest("hex").slice(0, 16);
  const before = Array.isArray(cluster.futureStrategy?.beforePatch) ? cluster.futureStrategy.beforePatch : [];
  const after = Array.isArray(cluster.futureStrategy?.afterPatch) ? cluster.futureStrategy.afterPatch : [];
  return {
    id: `skill_candidate:${projectKey}:${slug(actionType)}:${slug(errorType)}:${identityKey}`,
    identityVersion: 2,
    rule: `Before ${errorType} repair, ${before.join("; ") || "check the root cause"}; after repair, ${after.join("; ") || "run verification"}.`,
    source: "reflexion_cluster",
    actionType,
    errorType,
    scope: { ...scope, ...(cluster.scope || {}), project, taskTypes: [cluster.taskType || "general"].filter(Boolean) },
    confidence: Math.min(0.95, 0.55 + cluster.items.length * 0.1),
    evidence: {
      verificationVersion: SKILL_EVIDENCE_VERSION,
      failureCount: cluster.items.length,
      successCount: 0,
      regressionCount: 0,
      reflexionIds: cluster.items.map((item) => item.id).filter(Boolean),
      feedbackIds: [],
      errorType,
    },
    tokenCost: 0,
  };
}

export function runSkillPromotionLoop(learnerDir, options = {}) {
  const {
    promotionThreshold = 3,
    minSuccess = 5,
    activeSuccess = 7,
    maxRegression = 0,
    feedbackLimit = 200,
    dryRun = false,
    allowSkillFileWrite = false,
    now = Date.now(),
  } = options;
  if (!learnerDir) return { ok: false, status: "failed", error: "learnerDir missing" };

  const reflexions = readReflexions(learnerDir);
  const clusters = clusterReflexions(reflexions, { promotionThreshold });
  const promotableClusters = clusters.filter((cluster) => cluster.promotionCandidate);
  const store = loadSkillCandidates(learnerDir);
  const legacy = store.candidates.filter((candidate) => candidate.identityVersion !== 2 || candidate.evidence?.verificationVersion !== SKILL_EVIDENCE_VERSION);
  const byId = new Map(store.candidates.filter((candidate) => !legacy.includes(candidate)).map((candidate) => [candidate.id, candidate]));
  const events = [];
  if (legacy.length) {
    if (!dryRun) {
      const backup = path.join(learnerDir, "skill_candidates.pre-evidence-v2.json");
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(store, null, 2), "utf8");
    }
    events.push({ type: "candidate.legacy_evidence_quarantined", count: legacy.length });
  }

  for (const cluster of promotableClusters) {
    const incoming = createSkillCandidateFromCluster(cluster, { scope: { errorType: cluster.errorType } });
    if (!incoming) continue;
    incoming.errorType = cluster.errorType;
    const existing = byId.get(incoming.id);
    const merged = mergeCandidate(existing, incoming, { now });
    byId.set(merged.id, merged);
    events.push({ type: existing ? "candidate.updated_from_cluster" : "candidate.created_from_cluster", candidateId: merged.id, clusterId: cluster.clusterId });
  }

  const feedbackRows = readActionFeedback(learnerDir, { limit: feedbackLimit });
  const receipts = readSkillVerificationReceipts(learnerDir);
  const nextCandidates = [];
  let activeRegistry = loadActiveSkills(learnerDir);
  activeRegistry = { ...activeRegistry, skills: activeRegistry.skills.filter((skill) => byId.has(skill.id)) };

  for (const candidate of byId.values()) {
    const absorbed = absorbFeedback(candidate, feedbackRows, receipts);
    if (absorbed.consumed > 0) events.push({ type: "candidate.feedback_absorbed", candidateId: candidate.id, count: absorbed.consumed });
    const transitioned = transitionCandidate(absorbed.candidate, { minSuccess, activeSuccess, maxRegression, now, halfLifeDays: options.halfLifeDays, removeDecayedBelow: options.removeDecayedBelow });
    if (transitioned.beforeStatus !== transitioned.candidate.status || transitioned.decision !== "keep_candidate") {
      events.push({ type: "candidate.transition", candidateId: transitioned.candidate.id, from: transitioned.beforeStatus, to: transitioned.candidate.status, decision: transitioned.decision, reason: transitioned.reason });
    }
    if (transitioned.candidate.status === "active") {
      activeRegistry = upsertActiveSkill(activeRegistry, transitioned.candidate);
      events.push({ type: "active_skill.registered", candidateId: transitioned.candidate.id });
    } else if (activeRegistry.skills.some((skill) => skill.id === transitioned.candidate.id)) {
      activeRegistry = {
        ...activeRegistry,
        skills: activeRegistry.skills.filter((skill) => skill.id !== transitioned.candidate.id),
      };
      events.push({ type: "active_skill.removed", candidateId: transitioned.candidate.id, reason: transitioned.reason });
    }
    if (transitioned.candidate.status !== "removed") nextCandidates.push(transitioned.candidate);
    else events.push({ type: "candidate.removed", candidateId: transitioned.candidate.id });
  }

  const nextStore = { schemaVersion: 1, generatedAt: nowIso(now), candidates: nextCandidates.sort((a, b) => String(a.id).localeCompare(String(b.id))) };
  const nextActive = { ...activeRegistry, generatedAt: nowIso(now) };
  if (!dryRun) {
    saveSkillCandidates(learnerDir, nextStore);
    saveActiveSkills(learnerDir, nextActive);
  }

  return {
    ok: true,
    status: "completed",
    dryRun,
    allowSkillFileWrite,
    autoSkillFileWriteBlocked: allowSkillFileWrite !== true,
    counts: {
      reflexions: reflexions.length,
      clusters: clusters.length,
      promotableClusters: promotableClusters.length,
      candidates: nextStore.candidates.length,
      staged: nextStore.candidates.filter((item) => item.status === "staged").length,
      active: nextStore.candidates.filter((item) => item.status === "active").length,
      decayed: nextStore.candidates.filter((item) => item.status === "decayed").length,
      activeRegistry: nextActive.skills.length,
    },
    candidates: nextStore.candidates,
    activeSkills: nextActive.skills,
    events,
  };
}
