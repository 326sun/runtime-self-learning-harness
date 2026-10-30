import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { execute } from "./core/tools/memory.js";
import { executeLearning, getRuntime } from "./core/tools/learning.js";

export const name = "runtime-self-learning-harness";
export const inject = ["tools"];

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultDataDir = path.join(process.env.HARNESS_HOME || path.join(os.homedir(), ".harness"), "self-learning-harness");

function context(overrides = {}) {
  const project = String(process.env.HARNESS_PROJECT || "").trim();
  return {
    dataDir: path.resolve(process.env.HARNESS_DATA_DIR || defaultDataDir),
    pluginDir: packageRoot,
    sessionPath: project ? path.join("projects", project) : path.join("sessions", "00000000"),
    ...overrides,
  };
}

function executionContext(exec, owner) {
  const sessionPath = exec?.agent?.session?.header?.cwd || null;
  return context({ dataDir: owner?.dataDir, pluginDir: owner?.pluginDir, sessionPath, owner, log: owner?.log });
}

async function runMemory(input, exec, owner) {
  const result = await execute(input, executionContext(exec, owner));
  const text = result.content?.find((block) => block.type === "text")?.text;
  const value = text ? JSON.parse(text) : (result.details || {});
  if (value?.ok === false) throw new Error(value.error || "memory operation failed");
  return value;
}

const output = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
};

const scopeParameters = {
  project: { type: "string", description: "Optional project name; normally set HARNESS_PROJECT instead." },
  taskType: { type: "string" },
  type: { type: "string" },
  memoryLayer: { type: "string", enum: ["all", "core", "archive"] },
  limit: { type: "integer" },
};

function register(ctx, name, description, parameters, map = (args) => args) {
  ctx.tools.register(defineTool({
    name,
    description,
    parameters,
    output,
    async execute(args, exec) {
      return runMemory(map(args), exec, ctx);
    },
  }));
}

function registerLearning(ctx, name, description, parameters, map = (args) => args) {
  ctx.tools.register(defineTool({
    name,
    description,
    parameters,
    output,
    async execute(args, exec) {
      const value = await executeLearning(map(args), { ...executionContext(exec, ctx), owner: ctx, log: ctx.log });
      return value;
    },
  }));
}

export function apply(ctx) {
  // Start the event bridge during plugin activation, so automatic observation
  // does not depend on a model calling one of the diagnostic tools first.
  getRuntime({ ...context({ dataDir: ctx.dataDir, pluginDir: ctx.pluginDir }), owner: ctx, log: ctx.log });
  register(ctx, "memory_search", "Search approved and archived memories in the active project scope.",
    { query: { type: "string", required: true, description: "Search query, up to 4000 characters." }, ...scopeParameters },
    (args) => ({ action: "search", ...args }));
  register(ctx, "memory_list", "List memories visible in the active project scope.",
    { ...scopeParameters, query: { type: "string" }, includeInactive: { type: "boolean" }, offset: { type: "integer" } },
    (args) => ({ action: "list", ...args }));
  register(ctx, "memory_get", "Read one memory by id.",
    { id: { type: "string", required: true }, project: scopeParameters.project },
    (args) => ({ action: "get", ...args }));
  register(ctx, "memory_history", "Read revision and supersession history for one memory.",
    { id: { type: "string", required: true }, project: scopeParameters.project },
    (args) => ({ action: "history", ...args }));
  register(ctx, "memory_provenance", "Trace a memory to bounded episode records.",
    { id: { type: "string", required: true }, project: scopeParameters.project, limit: scopeParameters.limit },
    (args) => ({ action: "provenance", ...args }));
  register(ctx, "memory_episodes", "List bounded episode records without original conversation text.",
    { project: scopeParameters.project, limit: scopeParameters.limit },
    (args) => ({ action: "episodes", ...args }));
  register(ctx, "memory_upsert", "Create or update one memory; writes are explicit and auditable.",
    { id: { type: "string" }, memory: { type: "object", required: true, additionalProperties: true } },
    (args) => ({ action: "upsert", ...args }));
  register(ctx, "memory_delete", "Logically delete one memory in the active project scope.",
    { id: { type: "string", required: true } },
    (args) => ({ action: "delete", ...args }));
  register(ctx, "memory_approve", "Approve one pending memory in the active project scope.",
    { id: { type: "string", required: true } },
    (args) => ({ action: "approve", ...args }));
  register(ctx, "memory_export", "Export visible memories to the local data directory.",
    { includeInactive: { type: "boolean" } },
    (args) => ({ action: "export", ...args }));
  register(ctx, "memory_preview_import", "Preview a memory bundle before importing it.",
    { bundle: { type: "object", required: true, additionalProperties: true } },
    (args) => ({ action: "preview_import", ...args }));
  register(ctx, "memory_import", "Import a previously previewed bundle into the pending review queue.",
    { bundle: { type: "object", required: true, additionalProperties: true }, previewId: { type: "string", required: true } },
    (args) => ({ action: "import", ...args }));

  registerLearning(ctx, "learning_status", "Show the native Harness self-learning runtime status.",
    { }, (args) => ({ action: "status", ...args }));
  registerLearning(ctx, "learning_observe", "Manually submit a bounded turn for observation; normal Harness turns are observed automatically.",
    { turn: { type: "object", required: true, additionalProperties: true } },
    (args) => ({ action: "observe", ...args }));
  registerLearning(ctx, "learning_inject", "Preview scoped learned context that would be injected into the next model step.",
    { query: { type: "string" }, project: { type: "string" } },
    (args) => ({ action: "inject", ...args }));
  registerLearning(ctx, "learning_skill_evolve", "Run the review-gated skill evolution loop and refresh the generated self-learning skill.",
    { options: { type: "object", additionalProperties: true } },
    (args) => ({ action: "evolve", ...args }));
  registerLearning(ctx, "learning_skill_feedback", "Record verified success or regression for one skill candidate and run the promotion loop.",
    { candidateId: { type: "string", required: true }, outcome: { type: "string", enum: ["success", "regression"], required: true }, verification: { type: "object", required: true, additionalProperties: true } },
    (args) => ({ action: "feedback", ...args }));
  registerLearning(ctx, "learning_skill_render", "Render the current learned patterns and active skills to the local generated skill file.",
    { }, (args) => ({ action: "render_skill", ...args }));
}
