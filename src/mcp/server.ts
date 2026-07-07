import { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppEnv, AuthedUser } from "../types";
import { visibleAddresses, visibleMails } from "../services/mail";

/*
 * Remote MCP server, Streamable HTTP, 无状态 (不需要 Durable Objects)。
 * 认证在路由层由 apiKeyAuth 完成, 这里拿到的 user 已经是校验过的身份。
 * 所有 tool 都走 services/mail.ts, 权限过滤和 REST 完全同源。
 *
 * 客户端接入 (支持自定义 header 的客户端, 如 Claude Code):
 *   claude mcp add --transport http authinbox https://your.domain/mcp \
 *     --header "Authorization: Bearer aik_xxx"
 */

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function buildServer(db: D1Database, user: AuthedUser): McpServer {
  const server = new McpServer({ name: "authinbox", version: "2.0.0" });

  server.tool(
    "list_addresses",
    "List the inbox email addresses the current user is allowed to read. Use these addresses when signing up for services.",
    {},
    async () => {
      const addresses = await visibleAddresses(db, user);
      return textResult({ addresses });
    },
  );

  server.tool(
    "list_codes",
    "List recent verification codes/links visible to the current user, newest first. Optionally filter by recipient address or sender service name.",
    {
      to_addr: z.string().optional().describe("Exact recipient address, e.g. netflix@mail.example.com"),
      service: z.string().optional().describe("Fuzzy match on sender org/address, e.g. 'netflix'"),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ to_addr, service, limit }) => {
      const { items } = await visibleMails(db, user, { toAddr: to_addr, service, limit });
      return textResult({
        count: items.length,
        mails: items.map((m) => ({
          id: m.id,
          from: m.fromOrg ?? m.fromAddr,
          to: m.toAddr,
          topic: m.topic,
          code: m.code,
          category: m.category,
          receivedAt: m.createdAt,
        })),
      });
    },
  );

  server.tool(
    "get_latest_code",
    "Get the single most recent verification code/link for an address or service. Returns null if nothing is visible.",
    {
      to_addr: z.string().optional(),
      service: z.string().optional(),
    },
    async ({ to_addr, service }) => {
      const { items } = await visibleMails(db, user, { toAddr: to_addr, service, limit: 1 });
      const m = items[0];
      return textResult(
        m
          ? { code: m.code, from: m.fromOrg ?? m.fromAddr, topic: m.topic, receivedAt: m.createdAt }
          : { code: null },
      );
    },
  );

  server.tool(
    "wait_for_code",
    "Block and wait for a NEW verification code to arrive at the given address. Use this right after triggering a signup/login email. Only returns codes received after this call started. Times out after timeout_s seconds.",
    {
      to_addr: z.string().describe("The address you expect the code at"),
      service: z.string().optional().describe("Optionally narrow to a sender, e.g. 'netflix'"),
      timeout_s: z.number().int().min(5).max(55).default(30),
    },
    async ({ to_addr, service, timeout_s }) => {
      const startedAt = Date.now();
      const pollIntervalMs = 3000;

      while (Date.now() - startedAt < timeout_s * 1000) {
        const { items } = await visibleMails(db, user, {
          toAddr: to_addr,
          service,
          sinceMs: startedAt,
          limit: 1,
        });
        if (items.length > 0) {
          const m = items[0];
          return textResult({
            code: m.code,
            from: m.fromOrg ?? m.fromAddr,
            topic: m.topic,
            category: m.category,
            receivedAt: m.createdAt,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      return textResult({
        code: null,
        error: `Timed out after ${timeout_s}s. The email may not have arrived yet, or it was classified into a category you don't have access to. You can retry.`,
      });
    },
  );

  return server;
}

// 挂载: app.route('/mcp', mcpApp), 外层已套 apiKeyAuth
const mcpApp = new Hono<AppEnv>();

mcpApp.all("/", async (c) => {
  const server = buildServer(c.env.DB, c.get("user"));
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

export default mcpApp;
