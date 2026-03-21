import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
  class WorkerEntrypoint<TEnv> {
    protected env!: TEnv;
  }
  return { WorkerEntrypoint };
});

import {
  buildAiPrompt,
  buildLegacyCodeCell,
  isAuthorizedBasicAuth,
  parseBasicAuthCredentials,
  summarizeExtractionForLog,
} from "../src/index";

describe("security hardening helpers", () => {
  it("sanitizes legacy fallback links and blocks non-http(s) schemes", () => {
    const html = buildLegacyCodeCell("123456, javascript:alert(1)", "Verify Account");
    expect(html).toContain("123456");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script");
  });

  it("escapes untrusted legacy code text", () => {
    const html = buildLegacyCodeCell("<img src=x onerror=alert(1)>", "Unsafe");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });

  it("handles malformed basic auth safely", () => {
    expect(parseBasicAuthCredentials("Basic !!!not-base64!!!")).toBeNull();
    expect(isAuthorizedBasicAuth("Basic !!!not-base64!!!", "admin", "password")).toBe(false);
  });

  it("authenticates valid basic auth credentials", () => {
    const encoded = Buffer.from("admin:password", "utf8").toString("base64");
    expect(isAuthorizedBasicAuth(`Basic ${encoded}`, "admin", "password")).toBe(true);
  });

  it("builds minimal AI prompt without raw MIME headers", () => {
    const prompt = buildAiPrompt({
      from: "service@example.com",
      to: "inbox@example.com",
      subject: "Your verification code",
      textBody: "Your code is 123456",
    });

    expect(prompt).toContain("From: service@example.com");
    expect(prompt).toContain("Your code is 123456");
    expect(prompt).not.toContain("Content-Transfer-Encoding");
  });

  it("redacts extraction logs to codeExist only", () => {
    const logLine = summarizeExtractionForLog({
      codeExist: 1,
      code: "123456",
      title: "Sensitive Org",
    });

    expect(logLine).toBe("codeExist=1");
    expect(logLine).not.toContain("123456");
    expect(logLine).not.toContain("Sensitive Org");
  });
});
