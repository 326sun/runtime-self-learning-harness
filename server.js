import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execute } from "./core/tools/memory.js";

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = path.join(harnessDir, "core");
const defaultDataDir = path.join(process.env.HARNESS_HOME || path.join(os.homedir(), ".harness"), "self-learning-harness");

export function createContext(env = process.env) {
  const project = String(env.HARNESS_PROJECT || "").trim();
  return {
    dataDir: path.resolve(env.HARNESS_DATA_DIR || defaultDataDir),
    pluginDir: coreRoot,
    sessionPath: project ? path.join("projects", project) : path.join("sessions", "00000000"),
  };
}

export async function callMemory(input, context = createContext()) {
  try {
    const result = await execute(input, context);
    return { content: result.content || [{ type: "text", text: JSON.stringify(result.details ?? result) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
    };
  }
}

function registerMemoryTools(server, context) {
  const scopeFields = {
    project: z.string().optional().describe("Optional project name; normally set HARNESS_PROJECT instead."),
    taskType: z.string().optional(),
    type: z.string().optional(),
    memoryLayer: z.enum(["all", "core", "archive"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  };

  server.registerTool("memory_search", {
    description: "Search approved and archived Runtime Self-Learning memories within the active project scope.",
    inputSchema: { query: z.string().min(1).max(4000), ...scopeFields },
  }, (args) => callMemory({ action: "search", ...args }, context));

  server.registerTool("memory_list", {
    description: "List Runtime Self-Learning memories visible in the active project scope.",
    inputSchema: {
      ...scopeFields,
      query: z.string().optional(),
      includeInactive: z.boolean().optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, (args) => callMemory({ action: "list", ...args }, context));

  server.registerTool("memory_get", {
    description: "Read one Runtime Self-Learning memory by id.",
    inputSchema: { id: z.string().min(1), project: scopeFields.project },
  }, (args) => callMemory({ action: "get", ...args }, context));

  server.registerTool("memory_history", {
    description: "Read the revision and supersession history for one memory.",
    inputSchema: { id: z.string().min(1), project: scopeFields.project },
  }, (args) => callMemory({ action: "history", ...args }, context));

  server.registerTool("memory_provenance", {
    description: "Trace a memory back to bounded episode provenance records.",
    inputSchema: { id: z.string().min(1), project: scopeFields.project, limit: scopeFields.limit },
  }, (args) => callMemory({ action: "provenance", ...args }, context));

  server.registerTool("memory_episodes", {
    description: "List bounded episode provenance records without original conversation text.",
    inputSchema: { project: scopeFields.project, limit: scopeFields.limit },
  }, (args) => callMemory({ action: "episodes", ...args }, context));

  server.registerTool("memory_upsert", {
    description: "Create or update one memory in the active project scope. Writes are explicit and auditable.",
    inputSchema: { id: z.string().optional(), memory: z.record(z.unknown()) },
  }, (args) => callMemory({ action: "upsert", ...args }, context));

  server.registerTool("memory_delete", {
    description: "Logically delete one memory in the active project scope.",
    inputSchema: { id: z.string().min(1) },
  }, (args) => callMemory({ action: "delete", ...args }, context));

  server.registerTool("memory_approve", {
    description: "Approve one pending memory in the active project scope.",
    inputSchema: { id: z.string().min(1) },
  }, (args) => callMemory({ action: "approve", ...args }, context));

  server.registerTool("memory_export", {
    description: "Export visible memories to the local Harness data directory.",
    inputSchema: { includeInactive: z.boolean().optional() },
  }, (args) => callMemory({ action: "export", ...args }, context));

  server.registerTool("memory_preview_import", {
    description: "Preview a memory bundle before importing it; preview is read-only.",
    inputSchema: { bundle: z.record(z.unknown()) },
  }, (args) => callMemory({ action: "preview_import", ...args }, context));

  server.registerTool("memory_import", {
    description: "Import a previously previewed memory bundle into the pending review queue.",
    inputSchema: { bundle: z.record(z.unknown()), previewId: z.string().min(1) },
  }, (args) => callMemory({ action: "import", ...args }, context));
}

export function createServer(context = createContext()) {
  const server = new McpServer({ name: "runtime-self-learning-harness", version: "6.2.4" });
  registerMemoryTools(server, context);
  return server;
}

export async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
