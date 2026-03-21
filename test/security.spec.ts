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
  createSignedSessionToken,
  isPublicAssetPath,
  isAuthorizedBasicAuth,
  normalizeAuthMode,
  parseBasicAuthCredentials,
  summarizeExtractionForLog,
  verifySignedSessionToken,
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

  it("keeps public-assets allowlist narrow to avoid API auth bypass", () => {
    expect(isPublicAssetPath("/assets/index-abc123.js")).toBe(true);
    expect(isPublicAssetPath("/api/v2/threads.js")).toBe(false);
    expect(isPublicAssetPath("/auth/session")).toBe(false);
  });

  it("creates and verifies signed session tokens and rejects tampering/expiry", async () => {
    const key = "test-signing-key";
    const future = Math.floor(Date.now() / 1000) + 60;
    const validToken = await createSignedSessionToken(key, "session-123", future);
    const verified = await verifySignedSessionToken(key, validToken);
    expect(verified).toEqual({
      sessionId: "session-123",
      expiresAtUnixSeconds: future,
    });

    const tamperedToken = validToken.replace("session-123", "session-999");
    expect(await verifySignedSessionToken(key, tamperedToken)).toBeNull();

    const expiredToken = await createSignedSessionToken(key, "session-123", Math.floor(Date.now() / 1000) - 1);
    expect(await verifySignedSessionToken(key, expiredToken)).toBeNull();
  });

  it("normalizes invalid auth mode values to both", () => {
    expect(normalizeAuthMode(undefined)).toBe("both");
    expect(normalizeAuthMode("invalid-value")).toBe("both");
    expect(normalizeAuthMode("session")).toBe("session");
  });
});
