# Auth Inbox 验证邮局 📬

[English](https://github.com/TooonyChen/AuthInbox/blob/main/README.md) | [简体中文](https://github.com/TooonyChen/AuthInbox/blob/main/README_CN.md)

**Auth Inbox** 是一个自建的开源多邮箱验证码的接码平台，基于 [Cloudflare](https://cloudflare.com/) 的免费服务。它可以自动处理收到的邮件，提取验证码或链接，并将其存储在数据库中。管理员可以通过一个用户友好的网页界面轻松查看提取的信息。AuthInbox 还支持通过 Bark 进行实时通知，使其成为一个全面且省心的邮件认证管理解决方案。

不想在主邮箱中收到广告和垃圾邮件？想要多个备用邮箱用于注册服务和网站？试试这个吧！

![框架](https://github.com/user-attachments/assets/43492318-0ea9-464d-94e2-f1c810c192e8)


---

## 目录 📑

- [功能](#features)
- [使用的技术](#technologies-used)
- [安装](#installation)
- [许可证](#license)
- [截图](#Screenshots)

---

## 功能 ✨

- **邮件处理**：自动捕获和存储收到的邮件。
- **验证码提取**：利用 AI 从邮件中提取验证码、链接和组织名称。
- **安全前端**：提供受 Basic Access Authentication 保护的网页界面，用于查看提取的验证码。
- **实时通知**：当提取到新的验证码时，可选通过 Bark 发送通知。
- **数据库集成**：将原始和处理过的邮件数据存储在 D1Database 中。

---

## 使用的技术 🛠️

- **Cloudflare Workers**: 无服务器平台，用于处理邮件处理和Web请求。
- **Cloudflare D1**: Cloudflare的无服务器SQL数据库，用于存储邮件数据。
- **TypeScript**: 强类型编程语言，确保代码的稳健性和可维护性。
- **AI 提示词优化**: 定制的提示确保从多种邮件格式中精确提取标题、代码和主题。
- **Google AI Studio API**: 利用优化的AI提示从邮件中提取相关信息，以提升数据的准确性和可靠性。
- **Bark API**: 可选集成，用于发送实时通知。
- **HTML/CSS**: 前端界面，具有响应式和现代化设计。
- **Google Fonts**: 通过一致的排版增强Web界面的视觉吸引力。


---

## AI 提示词优化 🧠

为了确保从收到的电子邮件中准确提取信息，我们使用Google AI Studio API实施了AI提示优化。通过设计精确且具有上下文意识的提示，AI可以可靠地识别和提取关键要素，如：

- **组织名称（标题）**: 识别发件人的组织或公司。
- **验证码/链接**: 提取账户验证所需的代码、链接或密码。
- **电子邮件主题**: 总结电子邮件的主要目的，例如“账户验证”或“密码重置”。

**提示词如下:**
```plaintext
Email content: [Insert raw email content here].

Please read the email and extract the following information:
1. Code/Link/Password from the email (if available).
2. Organization name (title) from which the email is sent.
3. A brief summary of the email's topic (e.g., 'account verification').

Format the output as JSON with this structure:
{
  "title": "The organization or company that sent the verification code (e.g., 'Netflix')",
  "code": "The extracted verification code, link, or password (e.g., '123456' or 'https://example.com/verify?code=123456')",
  "topic": "A brief summary of the email's topic (e.g., 'account verification')",
  "codeExist": 1
}

If both a code and a link are present, include both in the 'code' field like this:
"code": "code, link"

If there is no code, clickable link, or this is an advertisement email, return:
{
  "codeExist": 0
}

```

---

## 安装 ⚙️

0. **先决条件**

   1. 安装 [Wrangler](https://developers.cloudflare.com/workers/wrangler/get-started/)
   ```bash
   npm install wrangler -g
   ```

   2. 创建一个 [Google AI Studio API](https://aistudio.google.com/)

   3. 在你的 [Cloudflare](https://dash.cloudflare.com/) 账户上绑定一个域名

   4. （可选）下载[Bark App](https://bark.day.app/)，在App中获得一个Bark Token

2. **初始化**

   ```bash
   git clone https://github.com/TooonyChen/AuthInbox.git
   cd AuthInbox
   npm install
   ```

3. **创建 d1 数据库**

   当你第一次执行 [Wrangler](https://developers.cloudflare.com/workers/wrangler/get-started/) 登录命令时，系统会提示你登录。按提示操作即可。

   ```bash
   npx wrangler d1 execute inbox-d1 --local --file=./schema.sql # 创建名为 'inbox-d1' 的 d1 数据库
   ```
   你将会看到如下结果：
   ```bash
   ✅ Successfully created DB 'inbox-d1'

   [[d1_databases]]
   binding = "DB" # 在你的 Worker 中通过 env.DB 访问
   database_name = "inbox-d1"
   database_id = "<你的数据库的唯一ID>"
   ```
   请从终端复制结果，你将在下一步中使用它们。

4. **配置环境变量**

使用项目根目录下的 `wrangler.toml` 文件，并添加所需的环境变量：

   ```toml
   name = "auth-inbox"
   type = "typescript"

   [vars]
   UseBark = 'true' # 设置为 'true' 启用 Bark，设置为 'false' 禁用
   barkUrl = "https://api.day.app"
   barkTokens = "[token1, token2]" # 填写你 iOS 设备上的 Bark tokens，可从 https://bark.day.app/ 下载应用获取，可以填写多个。如果你只想用一个，那么填写 '[token1]'
   FrontEndAdminID = "admin" # 你的登录 ID
   FrontEndAdminPassword = "password" # 你的登录密码
   GoogleAPIKey = "xxxxxxxxxxx" # 你的 Google API key，如果没有可以前往 https://aistudio.google.com/ 生成一个

   [[d1_databases]] # 从步骤 2 的终端结果中复制这些行。
   binding = "DB"
   database_name = "inbox-d1" # 从步骤 2 中复制
   database_id = "<你的数据库的唯一ID>" # 从步骤 2 中复制
   ```

4. **部署你的 worker** 🌐

   部署你的 Worker 以使项目在互联网上可访问。运行以下命令：
   ```bash
   npx wrangler deploy
   ```
   你将看到如下输出：
   ```
   output: https://auth-inbox.<你的子域名>.workers.dev
   ```
   你现在可以访问该 URL 来查看你部署的 Auth Inbox 的邮件结果。

5. **设置邮件转发** ✉️

   前往 [Cloudflare Dashboard](https://dash.cloudflare.com/) -> `Websites` -> `<你的域名>` -> `Email` -> `Email-Routing` -> `Routing Rules`

   如果你想使用“接收所有地址”：
   ![image](https://github.com/user-attachments/assets/53e5a939-6b03-4ca6-826a-7a5f02f361ac)

   如果你想使用“自定义地址”：
   ![image](https://github.com/user-attachments/assets/b0d0ab94-c2ad-4870-ac08-d53e64b2c880)

7. **完成**✅

   一切设置完毕！现在可以试试了！

---

## 许可证 📜

本项目基于 [MIT License](LICENSE) 许可证。

---

## 截图 📸

![image](https://github.com/user-attachments/assets/41db550c-8340-4315-ba87-85330abc5dfb)


---

## 鸣谢 🙏

- 感谢 **Cloudflare Workers** 提供强大的无服务器平台。
- 感谢 **Google Gemini AI** 提供智能的邮件内容提取功能。
- 感谢 **Bark** 提供实时通知能力。
- 感谢 **开源社区** 为像 Auth Inbox 这样的项目提供灵感和支持。
- 感谢 **ChatGPT** 协助我写代码

---
## TODO 📝
- [ ] **多用户支持**：增加管理多用户的功能，以提高灵活性并扩展使用范围。
- [ ] **增强前端设计**：改进网页界面的UI/UX设计，使其更加现代化和用户友好。

- [ ] **API**: 添加API接口。

