import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractMailBodies, stripHtmlTags } from "../../src/services/mime";

export const FIXTURES_DIR = join(__dirname, "..", "fixtures");

export interface FixtureEval {
  codeExist: 0 | 1;
  categories?: string[];
  codeContains?: string;
  advisory?: boolean;
}

export interface Fixture {
  name: string;
  rawMailId: number;
  note?: string;
  promotional: boolean;
  contentIncludes?: string[];
  eval?: FixtureEval;
}

export function loadManifest(): Fixture[] {
  const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8"));
  return manifest.fixtures as Fixture[];
}

export function fixturePath(fixture: Fixture): string {
  return join(FIXTURES_DIR, `${fixture.name}.eml`);
}

export function hasFixture(fixture: Fixture): boolean {
  return existsSync(fixturePath(fixture));
}

export function readFixture(fixture: Fixture): string {
  return readFileSync(fixturePath(fixture), "utf8");
}

// 把原始邮件的顶层头部解析成 Headers, 模拟 Email Workers 传入的 message.headers。
// 值里的非 Latin-1 字符替换掉 (Headers 只接受 ByteString; 真实 MTA 会用 RFC2047 编码)。
export function parseRawHeaders(rawEmail: string): Headers {
  const headerBlock = rawEmail.split(/\r?\n\r?\n/)[0] ?? "";
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const headers = new Headers();
  for (const line of unfolded.split(/\r?\n/)) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    try {
      headers.append(match[1], match[2].replace(/[^\x00-\xff]/g, "?"));
    } catch {
      // 个别非法头直接跳过, 与 workerd 的容错行为一致
    }
  }
  return headers;
}

// 与 classify.ts 的 buildPrompt 完全一致的正文选取逻辑
export function emailContentForLlm(rawEmail: string): string {
  const { textBody, htmlBody } = extractMailBodies(rawEmail);
  return textBody ?? (htmlBody ? stripHtmlTags(htmlBody) : rawEmail);
}
