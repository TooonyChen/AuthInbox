import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../src/types";
import { buildPrompt, callProvider, coerceCategory, extractJsonFromText } from "../../src/services/classify";
import { isPromotionalEmail } from "../../src/services/mime";
import { hasFixture, loadManifest, parseRawHeaders, readFixture } from "./helpers";

/*
 * LLM 分类 eval (真实调用 AI provider, 花钱, 结果非严格确定):
 *   EVAL_LLM=1 pnpm run test:eval          — 每个 fixture 跑 EVAL_RUNS 次 (默认 5)
 *   EVAL_RUNS=3 pnpm run test:eval         — 降低次数
 * provider 配置优先取环境变量 AI_*, 否则从 wrangler.toml [vars] 读。
 * eval.advisory=true 的用例只告警不判失败 (LLM 判断类, 允许漂移观察)。
 */

const enabled = process.env.EVAL_LLM === "1";
const RUNS = Number(process.env.EVAL_RUNS ?? 5);

function loadProviderConfig(): ProviderConfig {
  const fromEnv = {
    baseUrl: process.env.AI_BASE_URL,
    apiKey: process.env.AI_API_KEY,
    format: process.env.AI_API_FORMAT,
    model: process.env.AI_MODEL,
  };
  if (fromEnv.baseUrl && fromEnv.apiKey && fromEnv.format && fromEnv.model) {
    return fromEnv as ProviderConfig;
  }
  const toml = readFileSync(join(__dirname, "..", "..", "wrangler.toml"), "utf8");
  const grab = (key: string): string =>
    toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? "";
  return {
    baseUrl: grab("AI_BASE_URL"),
    apiKey: grab("AI_API_KEY"),
    format: grab("AI_API_FORMAT") as ProviderConfig["format"],
    model: grab("AI_MODEL"),
  };
}

describe.skipIf(!enabled)("LLM classification eval", () => {
  const config = enabled ? loadProviderConfig() : null;
  const fixtures = loadManifest().filter((f) => f.eval);

  for (const fixture of fixtures) {
    const expected = fixture.eval!;
    it.skipIf(!hasFixture(fixture))(
      `${fixture.name} → codeExist=${expected.codeExist}${expected.categories ? ` category∈[${expected.categories}]` : ""}${expected.advisory ? " (advisory)" : ""}`,
      { timeout: 120_000 },
      async () => {
        const raw = readFixture(fixture);
        // 被头部过滤器拦下的邮件在生产中不会进 LLM, eval 也跳过
        if (isPromotionalEmail(parseRawHeaders(raw), raw)) return;

        const prompt = buildPrompt(raw);
        const failures: string[] = [];

        for (let run = 1; run <= RUNS; run++) {
          const response = await callProvider(config!, prompt);
          const parsed = response ? extractJsonFromText(response) : null;
          if (!parsed) {
            failures.push(`run ${run}: provider/parse failure`);
            continue;
          }

          const codeExist = parsed.codeExist === 1 ? 1 : 0;
          const category = coerceCategory(parsed.category);
          const code = typeof parsed.code === "string" ? parsed.code : "";
          const summary = `run ${run}: codeExist=${codeExist} category=${category} code=${code.slice(0, 60)}`;

          if (codeExist !== expected.codeExist) {
            failures.push(`${summary} — expected codeExist=${expected.codeExist}`);
            continue;
          }
          if (expected.codeExist === 1) {
            if (expected.categories && !expected.categories.includes(category)) {
              failures.push(`${summary} — category not in [${expected.categories}]`);
            }
            if (expected.codeContains && !code.toLowerCase().includes(expected.codeContains.toLowerCase())) {
              failures.push(`${summary} — code missing "${expected.codeContains}"`);
            }
          }
        }

        if (failures.length > 0) {
          const report = `${fixture.name}: ${failures.length}/${RUNS} runs off-expectation\n  ${failures.join("\n  ")}`;
          if (expected.advisory) {
            console.warn(`[advisory] ${report}`);
          } else {
            expect.fail(report);
          }
        }
      },
    );
  }
});
