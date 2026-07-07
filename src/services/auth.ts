import { sign, verify } from "hono/jwt";
import type { AuthedUser, Role } from "../types";

const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 天

// ---------- 密码哈希 (Workers 原生 WebCrypto, 无第三方依赖) ----------

function toB64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromB64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    256,
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt.buffer)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number.parseInt(parts[1], 10);
  const salt = fromB64(parts[2]);
  const expected = fromB64(parts[3]);
  const actual = new Uint8Array(await pbkdf2(password, salt, iterations));
  if (actual.length !== expected.length) return false;
  // 常数时间比较
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

// ---------- Session JWT (HttpOnly cookie 里带) ----------

interface SessionPayload {
  sub: number;
  username: string;
  role: Role;
  exp: number;
  [key: string]: unknown;
}

export async function signSession(user: AuthedUser, secret: string): Promise<string> {
  const payload: SessionPayload = {
    sub: user.id,
    username: user.username,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  return sign(payload, secret);
}

export async function verifySession(token: string, secret: string): Promise<AuthedUser | null> {
  try {
    const payload = (await verify(token, secret, "HS256")) as unknown as SessionPayload;
    return { id: Number(payload.sub), username: payload.username, role: payload.role };
  } catch {
    return null;
  }
}

// ---------- API Key (MCP 用) ----------

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `aik_${hex}`;
}

export async function findUserByApiKey(db: D1Database, rawKey: string): Promise<AuthedUser | null> {
  if (!rawKey.startsWith("aik_")) return null;
  const keyHash = await sha256Hex(rawKey);
  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.role, k.id AS key_id
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ? LIMIT 1`,
    )
    .bind(keyHash)
    .first<{ id: number; username: string; role: Role; key_id: number }>();
  if (!row) return null;

  // 更新 last_used_at, 失败不影响主流程
  db.prepare("UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(row.key_id)
    .run()
    .catch(() => {});

  return { id: row.id, username: row.username, role: row.role };
}
