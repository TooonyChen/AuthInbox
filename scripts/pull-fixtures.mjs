#!/usr/bin/env node
/*
 * 从远程 D1 的 raw_mails 拉取 manifest 里列出的真实邮件, 存成 test/fixtures/<name>.eml。
 * .eml 含真实地址/令牌, 已 gitignore — 只存在于本地, 供 test:mail / test:eval 使用。
 *
 * 用法: pnpm run fixtures:pull        (远程 D1, 需要 wrangler 登录)
 *       pnpm run fixtures:pull --local (本地 D1)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(root, "test", "fixtures");
const manifest = JSON.parse(readFileSync(join(fixturesDir, "manifest.json"), "utf8"));

const where = process.argv.includes("--local") ? "--local" : "--remote";
const ids = manifest.fixtures.map((f) => f.rawMailId);
const sql = `SELECT id, raw FROM raw_mails WHERE id IN (${ids.join(",")})`;

console.log(`Fetching ${ids.length} fixtures from ${where} D1 ...`);
const out = execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "inbox-d1", where, "--json", "--command", sql],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const rows = JSON.parse(out)[0].results;
const byId = new Map(rows.map((r) => [r.id, r.raw]));

let missing = 0;
for (const fixture of manifest.fixtures) {
  const raw = byId.get(fixture.rawMailId);
  if (!raw) {
    console.warn(`✗ ${fixture.name}: raw_mails id ${fixture.rawMailId} not found`);
    missing++;
    continue;
  }
  writeFileSync(join(fixturesDir, `${fixture.name}.eml`), raw);
  console.log(`✓ ${fixture.name}.eml (${raw.length} bytes)`);
}
process.exit(missing ? 1 : 0);
