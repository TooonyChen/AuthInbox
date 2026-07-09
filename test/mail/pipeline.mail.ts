import { describe, expect, it } from "vitest";
import { isPromotionalEmail } from "../../src/services/mime";
import { emailContentForLlm, hasFixture, loadManifest, parseRawHeaders, readFixture } from "./helpers";

/*
 * 确定性 pipeline 回归测试 (不调 LLM, 免费, 秒级):
 * 对 D1 里挑出的真实邮件断言 1) 广告过滤器判定 2) LLM 输入正文包含关键片段。
 * fixture 缺失时跳过并提示 — 先跑 `pnpm run fixtures:pull`。
 */

const fixtures = loadManifest();

describe("mail pipeline fixtures", () => {
  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      it.skipIf(!hasFixture(fixture))(
        `promotional filter → ${fixture.promotional}`,
        () => {
          const raw = readFixture(fixture);
          expect(isPromotionalEmail(parseRawHeaders(raw), raw)).toBe(fixture.promotional);
        },
      );

      if (fixture.contentIncludes?.length) {
        it.skipIf(!hasFixture(fixture))(
          `LLM input contains: ${fixture.contentIncludes.join(", ")}`,
          () => {
            const content = emailContentForLlm(readFixture(fixture)).toLowerCase();
            for (const fragment of fixture.contentIncludes!) {
              expect(content).toContain(fragment.toLowerCase());
            }
          },
        );
      }
    });
  }

  it("reminds you to pull fixtures when none exist", () => {
    const present = fixtures.filter(hasFixture).length;
    if (present === 0) {
      console.warn("No fixture .eml files found — run `pnpm run fixtures:pull` first.");
    }
    expect(fixtures.length).toBeGreaterThan(0);
  });
});
