import { defineConfig } from "vitest/config";

// 真实邮件 fixture 测试 (test/mail/*.mail.ts) 跑在 node 环境:
// 需要 fs 读 .eml, LLM eval 需要出网 — 都不适合 workers pool。
// 主测试 (pnpm test, *.test.ts) 仍走 vitest.config.mts 的 workers pool。
export default defineConfig({
  test: {
    include: ["test/mail/**/*.mail.ts"],
    environment: "node",
  },
});
