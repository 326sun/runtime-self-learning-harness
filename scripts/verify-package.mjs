import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run with npm run check:package");
const packed = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], { encoding: "utf8" });
assert.equal(packed.status, 0, packed.stderr);
const [info] = JSON.parse(packed.stdout);
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
assert.equal(pkg.version, lock.version);
assert.equal(pkg.version, lock.packages[""].version);
assert.ok(fs.readFileSync("README.md", "utf8").replace(/\r\n/g, "\n").startsWith(`# Runtime Self-Learning Harness ${pkg.version}\n`));
assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
const files = new Set(info.files.map((item) => item.path));
for (const file of ["index.js", "server.js", "package.json", "cordis.patch.yml", "core/lib/harness-runtime.js", "core/lib/skill-feedback-verifier.js", "docs/SKILL-VERIFICATION.md"]) {
  assert.ok(files.has(file), `missing bundle file: ${file}`);
}
for (const item of info.files) {
  assert.doesNotMatch(item.path, /(^|\/)(node_modules|\.git|test)(\/|$)|\.(zip|tgz|jsonl)$/i);
  const content = fs.readFileSync(item.path, "utf8");
  const previousBrand = String.fromCharCode(104, 97, 110, 97, 107, 111);
  assert.doesNotMatch(content, new RegExp(`${previousBrand}|[A-Z]:[\\\\/]Users[\\\\/]`, "i"), `product or workstation reference in ${item.path}`);
}
console.log(`Package ${info.name}@${info.version}: ${files.size} files; bundle, docs, versions and product isolation verified.`);
