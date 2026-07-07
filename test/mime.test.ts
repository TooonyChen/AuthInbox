import { describe, expect, it } from "vitest";
import { decodeMimeHeader, decodeQuotedPrintable, extractMailBodies } from "../src/services/mime";

describe("mime decoding", () => {
  it("decodes UTF-8 base64 body parts as Unicode text", () => {
    const rawEmail = [
      'Content-Type: multipart/alternative; boundary="mail-boundary"',
      "",
      "--mail-boundary",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      "5Lit5paH6aqM6K+B56CB77yaMTIzNDU2",
      "--mail-boundary--",
      "",
    ].join("\r\n");

    expect(extractMailBodies(rawEmail).textBody).toBe("中文验证码：123456");
  });

  it("decodes single-part base64 HTML emails", () => {
    const rawEmail = [
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      "PGh0bWw+PGJvZHk+PHA+5Lit5paH6aqM6K+B56CB77yaMTIzNDU2PC9wPjwvYm9keT48L2h0bWw+",
      "",
    ].join("\r\n");

    const bodies = extractMailBodies(rawEmail);
    expect(bodies.htmlBody).toContain("中文验证码：123456");
    expect(bodies.textBody).toBe("中文验证码：123456");
  });

  it("decodes UTF-8 quoted-printable body parts as Unicode text", () => {
    expect(decodeQuotedPrintable("=E4=B8=AD=E6=96=87=E9=AA=8C=E8=AF=81=E7=A0=81=EF=BC=9A123456")).toBe(
      "中文验证码：123456",
    );
  });

  it("decodes RFC 2047 encoded subject headers", () => {
    expect(decodeMimeHeader("=?UTF-8?B?6aqM6K+B56CB?=")).toBe("验证码");
  });
});
