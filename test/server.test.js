import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callMemory, createContext } from "../server.js";

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
