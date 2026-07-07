import { Hono } from "hono";
import type { AppEnv } from "../types";
import { visibleMailById, visibleMails } from "../services/mail";
import { extractMailBodies } from "../services/mime";

const mails = new Hono<AppEnv>();

// GET /api/mails?page=1&pageSize=20&to_addr=xxx&service=netflix
mails.get("/", async (c) => {
  const user = c.get("user");
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(c.req.query("pageSize") ?? "20", 10) || 20),
  );

  const { total, items } = await visibleMails(c.env.DB, user, {
    toAddr: c.req.query("to_addr") || undefined,
    service: c.req.query("service") || undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return c.json({ page, pageSize, total, items });
});

// GET /api/mails/:id
mails.get("/:id{[0-9]+}", async (c) => {
  const user = c.get("user");
  const mailId = Number.parseInt(c.req.param("id"), 10);

  const row = await visibleMailById(c.env.DB, user, mailId);
  if (!row) {
    // 越权和不存在返回同一个 404, 不泄露资源存在性
    return c.json({ error: "Mail not found" }, 404);
  }

  // raw 只有 admin 拿得到 (mail service 已控制), body 解析同理
  const { textBody, htmlBody } = row.raw
    ? extractMailBodies(row.raw)
    : { textBody: null, htmlBody: null };

  return c.json({ ...row, textBody, htmlBody });
});

export default mails;
