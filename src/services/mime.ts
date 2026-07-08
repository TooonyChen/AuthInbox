/*
 * MIME 正文/头部解码工具。邮件正文经常是 base64 或 quoted-printable
 * 包着 UTF-8/GBK 字节；不能把 atob()/=HH 的结果直接当 JS 字符串。
 */

export function decodeQuotedPrintable(text: string): string {
  return decodeBytes(decodeQuotedPrintableBytes(text), "utf-8");
}

function normaliseCharset(charset: string | null | undefined): string {
  const value = (charset ?? "utf-8").trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (!value || value === "utf8" || value === "us-ascii") return "utf-8";
  if (value === "gb2312" || value === "gbk" || value === "gb_2312-80") return "gb18030";
  return value;
}

function decodeBytes(bytes: Uint8Array, charset: string | null | undefined): string {
  try {
    return new TextDecoder(normaliseCharset(charset)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function binaryStringToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function decodeBase64Bytes(text: string): Uint8Array {
  return binaryStringToBytes(atob(text.replace(/\s/g, "")));
}

function decodeQuotedPrintableBytes(text: string, headerMode = false): Uint8Array {
  const input = (headerMode ? text.replace(/_/g, " ") : text).replace(/=\r?\n/g, "");
  const bytes: number[] = [];

  for (let i = 0; i < input.length; i++) {
    if (input[i] === "=" && /^[A-Fa-f0-9]{2}$/.test(input.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(input.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(input.charCodeAt(i) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

function unfoldHeaders(headers: string): string {
  return headers.replace(/\r?\n[ \t]+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getHeader(headers: string, name: string): string | null {
  const match = unfoldHeaders(headers).match(new RegExp(`^${escapeRegExp(name)}:\\s*([^\\r\\n]*)`, "im"));
  return match?.[1]?.trim() ?? null;
}

function getCharset(contentType: string | null): string {
  return contentType?.match(/;\s*charset="?([^";\r\n]+)"?/i)?.[1] ?? "utf-8";
}

function decodeBodyPart(body: string, encoding: string, charset: string): string {
  if (encoding === "base64") {
    try {
      return decodeBytes(decodeBase64Bytes(body), charset);
    } catch {
      return body;
    }
  }
  if (encoding === "quoted-printable") {
    return decodeBytes(decodeQuotedPrintableBytes(body), charset);
  }
  return body;
}

export function decodeMimeHeader(value: string | null): string | null {
  if (!value) return value;

  return value
    .replace(/(=\?[^?]+\?[bqBQ]\?[^?]*\?=)\s+(?==\?[^?]+\?[bqBQ]\?)/g, "$1")
    .replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_match, charset, encoding, encoded) => {
      try {
        const bytes =
          encoding.toLowerCase() === "b"
            ? decodeBase64Bytes(encoded)
            : decodeQuotedPrintableBytes(encoded, true);
        return decodeBytes(bytes, charset);
      } catch {
        return _match;
      }
    });
}

export function stripHtmlTags(text: string): string {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 主题看起来像验证码/事务性邮件 (verification, OTP, sign-in, reset, 验证码…)。
// 只用来豁免 List-Unsubscribe 这一条弱信号, 不影响下面强信号的判定。
const TRANSACTIONAL_SUBJECT_RE =
  /\b(codes?|otp|2fa|mfa|pin|passcodes?|passwords?|verif\w*|confirm\w*|activat\w*|authenticat\w*|one[- ]?time|single[- ]?use|magic link|sign[- ]?in|log[- ]?in|reset)\b|验证|驗證|校验|校驗|认证|認證|登录|登錄|登入|一次性|动态密码|動態密碼|認証|ワンタイム|パスワード|인증|확인/i;

export function isPromotionalEmail(headers: Headers, rawEmail: string): boolean {
  // 强信号: 真正的邮件列表 / 群发
  if (headers.get("List-ID") || headers.get("List-Post")) {
    return true;
  }

  const precedence = headers.get("Precedence")?.toLowerCase() ?? "";
  if (precedence === "bulk" || precedence === "list") {
    return true;
  }

  // 强信号: 营销平台的 campaign 头
  const rawHeaders = rawEmail.slice(0, rawEmail.search(/\r?\n\r?\n/) + 1 || 4000);
  if (
    /^X-Campaign(-ID)?:/im.test(rawHeaders) ||
    /^X-Mailer:\s*(mailchimp|sendgrid|klaviyo|brevo|sendinblue|constant.contact|hubspot)/im.test(
      rawHeaders,
    ) ||
    /^X-SFMC-Stack:/im.test(rawHeaders) ||
    /^X-Marketo-/im.test(rawHeaders)
  ) {
    return true;
  }

  // 弱信号: List-Unsubscribe 单独出现不足以定罪 —— Gmail/Yahoo 2024 起的
  // bulk sender 规则迫使大发件方 (Netflix/SES 等) 给验证码等事务邮件也带上它。
  // 主题像事务邮件时豁免, 放行给 LLM (真广告在 prompt 里仍会被判 codeExist=0)。
  if (headers.get("List-Unsubscribe")) {
    const subject = decodeMimeHeader(headers.get("Subject")) ?? "";
    return !TRANSACTIONAL_SUBJECT_RE.test(subject);
  }

  return false;
}

export function extractMailBodies(rawEmail: string): {
  textBody: string | null;
  htmlBody: string | null;
} {
  const topLevel = rawEmail.match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
  const topHeaders = topLevel?.[1] ?? "";
  const topBody = topLevel?.[2] ?? rawEmail;
  const topContentType = getHeader(topHeaders, "Content-Type");
  const boundaryMatch = topContentType?.match(/boundary="?([^"\r\n;]+)"?/i);

  if (boundaryMatch) {
    const boundary = boundaryMatch[1].trim();
    const escapedBoundary = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = topBody.split(new RegExp(`--${escapedBoundary}(?:--)?\\r?\\n?`));

    let textBody: string | null = null;
    let htmlBody: string | null = null;

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed === "--") continue;

      const headerBodyMatch = trimmed.match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
      if (!headerBodyMatch) continue;

      const headers = headerBodyMatch[1];
      const body = headerBodyMatch[2].trim();
      if (!body) continue;

      const contentTypeHeader = getHeader(headers, "Content-Type");
      const contentType = contentTypeHeader?.split(";")[0]?.trim().toLowerCase() ?? "";
      const encoding = getHeader(headers, "Content-Transfer-Encoding")?.toLowerCase() ?? "";
      const decoded = decodeBodyPart(body, encoding, getCharset(contentTypeHeader));

      if (contentType.includes("text/html") && !htmlBody) {
        htmlBody = decoded.trim();
      } else if (contentType.includes("text/plain") && !textBody) {
        textBody = decoded.trim();
      }
    }

    if (htmlBody || textBody) {
      if (!textBody && htmlBody) textBody = stripHtmlTags(htmlBody);
      return { textBody, htmlBody };
    }
  }

  const encoding = getHeader(topHeaders, "Content-Transfer-Encoding")?.toLowerCase() ?? "";
  const decodedBody = decodeBodyPart(topBody, encoding, getCharset(topContentType));
  const topMimeType = topContentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const htmlMatch = decodedBody.match(/<html[\s\S]*<\/html>/i) ?? decodedBody.match(/<body[\s\S]*<\/body>/i);
  const htmlBody = htmlMatch ? htmlMatch[0].trim() : null;

  const decodedText = topMimeType.includes("text/html") ? stripHtmlTags(decodedBody) : decodedBody.trim();
  const textBody = decodedText ? decodedText : htmlBody ? stripHtmlTags(htmlBody) : null;

  return { textBody, htmlBody };
}
