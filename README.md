# AuthInbox v2 骨架

Hono 重构 + 多用户/授权 + Remote MCP Server。本目录是可直接落进现有仓库的骨架，前端部分需要你自己把 Basic Auth 换成登录页（见下文）。

## 目录结构

```
migrations/
  0001_baseline.sql        # 现有 schema, 幂等
  0002_multi_user.sql      # users / api_keys / grants / category 列
src/
  index.ts                 # WorkerEntrypoint 壳: fetch → Hono, email → handler
  app.ts                   # Hono app + 认证边界
  types.ts                 # Env / AppEnv / 分类枚举
  middleware/auth.ts       # sessionAuth / requireAdmin / apiKeyAuth
  routes/
    auth.ts                # /api/auth: setup, login, logout, me
    mails.ts               # /api/mails: 列表 + 详情 (自动按用户过滤)
    admin.ts               # /api/admin: users + grants 管理
    keys.ts                # /api/keys: 自助签发 MCP API key
  services/
    auth.ts                # PBKDF2 / JWT / API key
    mail.ts                # visibleMails — 唯一的权限过滤查询层
    classify.ts            # LLM 提取 (prompt 加了 category)
    mime.ts                # MIME/encoded-word 解码、HTML 去标签、推广邮件识别
  email/
    handler.ts             # email() 逻辑, 写入 category
    rpcEmail.ts            # 原样保留
  mcp/server.ts            # /mcp: list_addresses / list_codes / get_latest_code / wait_for_code
```

## 从现有仓库迁移

1. 安装依赖:

   ```bash
   pnpm add hono @hono/mcp @modelcontextprotocol/sdk zod
   ```

2. 设置 secret（JWT 签名用，随便一串长随机字符串）。生产环境不要把它写进 `wrangler.toml`:

   ```bash
   pnpm exec wrangler secret put JWT_SECRET
   ```

3. `FrontEndAdminID` / `FrontEndAdminPassword` 已被 users 表取代，不再需要配置。首次部署后在登录页创建第一个 admin。

4. 迁移数据库。`pnpm run deploy` 会自动先执行远端 D1 migrations 再部署 Worker；也可以单独执行:

   ```bash
   pnpm run db:migrate:remote
   ```

5. 部署后创建第一个 admin。登录页会自动检测 `GET /api/auth/setup`；users 表为空时会显示创建 admin 表单。也可以用 API:

   ```bash
   curl -X POST https://your.domain/api/auth/setup \
     -H 'Content-Type: application/json' \
     -d '{"username":"tony","password":"一个强密码"}'
   ```

## 前端 (web/, 已完成)

沿用原有主题（近黑 + 薄荷绿 #5fe0c0 + Manrope / IBM Plex Mono + 左上光晕），零新依赖，新增两个 shadcn 组件（input、label）。

- `src/api.ts`: 统一 fetch 层、类型、分类常量（与后端 MAIL_CATEGORIES 同步维护）
- `src/App.tsx`: 挂载时 GET `/api/auth/me`，401 进登录页；顶部导航按角色渲染，右上角显示当前用户和角色
- `src/pages/LoginPage.tsx`: 登录页。会先查 GET `/api/auth/setup`，users 表为空时自动切成"创建 admin 账号"模式，建号后直接登录，不用手动 curl setup 接口
- `src/pages/InboxPage.tsx`: 列表加了分类徽章列和发件方搜索（回车触发，走 `service` 参数）。详情页按角色分叉：admin 保留 Extracted / Raw / Rendered 三个 tab（DOMPurify + sandboxed iframe 逻辑原样保留）；user 只渲染 Extracted 面板，底部一行说明原文仅 admin 可见
- `src/pages/KeysPage.tsx`: 自助创建 / 吊销 API key，明文只展示一次（带复制按钮），右侧卡片给出 MCP server URL 和 Claude Code 接入命令（自动取当前域名）
- `src/pages/AdminPage.tsx`: 左卡片用户管理（建号、删号，不能删自己），右卡片授权管理（选用户、填 GLOB pattern、点选分类）。选中敏感分类时出现红色确认框，对应后端的 `allow_sensitive`，不勾的话服务端会把敏感分类从 grant 里剔除
- 分类徽章配色：login_code 用主题薄荷绿，registration 天蓝，payment 琥珀，敏感类暗红，legacy 虚线灰

旧的 `src/index.html` 服务端兜底页在这版里去掉了，因为它无法感知用户身份。如果你想保留 no-JS 兜底，可以在 `app.ts` 的 SPA fallback 前加一个 session 校验的服务端渲染路由。

## 授权模型

- grant = (user, 地址 pattern, 允许的分类, 是否放行敏感类)
- pattern 用 SQLite GLOB：`netflix@mail.tony.dev` 精确，`*@mail.tony.dev` 通配
- 分类由 LLM 在提取时打标：`login_code` / `registration` / `password_reset` / `account_security` / `payment` / `other`
- `password_reset` 和 `account_security` 是敏感类：grant 里就算写了，`allow_sensitive = 0` 时服务层也会剔除
- 迁移前的历史邮件 category 为 `legacy`，永远只有 admin 可见
- 普通用户在任何接口（含 MCP）都拿不到邮件原文 raw，只能看到提取后的结构化结果

给 user 开一个典型 grant：

```bash
curl -X POST https://your.domain/api/admin/grants \
  -H 'Content-Type: application/json' -b 'authinbox_session=...' \
  -d '{
    "userId": 2,
    "addressPattern": "*@mail.tony.dev",
    "allowedCategories": ["login_code", "registration"]
  }'
```

这样 user 2 能看到发到该域名任何地址的 Netflix 登录验证码，但看不到 Netflix 改密码邮件。

## MCP 接入

1. 用户登录 web 后 POST `/api/keys` 拿到 `aik_xxx`（只显示一次）。
2. Claude Code:

   ```bash
   claude mcp add --transport http authinbox https://your.domain/mcp \
     --header "Authorization: Bearer aik_xxx"
   ```

3. Tools:
   - `list_addresses`: 该 key 对应用户可见的收件地址
   - `list_codes` / `get_latest_code`: 查验证码
   - `wait_for_code`: 阻塞等新码（最长 55s，只返回调用之后到达的邮件），agent 注册流程的关键工具

claude.ai 的远程连接器要求 OAuth，这版先不做；以后要接的话在 `/mcp` 前面套 Cloudflare 的 `workers-oauth-provider` 即可，tool 层不用动。

## 验证清单

- [ ] 旧邮件进件流程不变：发一封测试邮件，raw_mails 和 code_mails 都有记录，category 有值
- [ ] 推广邮件仍然在 LLM 之前被拦截
- [ ] user 登录后 `/api/mails` 只返回 grant 范围内、非敏感分类的邮件
- [ ] user 请求 `/api/mails/:id` 越权时返回 404
- [ ] user 的 MCP key 调 `list_codes` 结果与 web 端一致
- [ ] `wait_for_code` 期间发送邮件，能在轮询里被捞到
- [ ] Bark 推送不变
