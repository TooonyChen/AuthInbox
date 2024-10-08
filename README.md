# Auth Inbox 📬

[English](https://github.com/TooonyChen/AuthInbox/blob/main/README.md) | [简体中文](https://github.com/TooonyChen/AuthInbox/blob/main/README_CN.md)

**Auth Inbox** is an open-source project that securely receive and views authentication emails using [Cloudflare](https://cloudflare.com/)'s free serverless services. It automatically processes incoming emails, extracts verification codes or links, and stores them in a database. A user-friendly web interface is provided for administrators to easily review the extracted information. AuthInbox also supports real-time notifications via Bark, making it a comprehensive and hassle-free solution for email authentication management.

Don't wanna receive ads and spams on your main email? Want a bunch of alternative email for register services and websites? Try this **secure**, **serverless**, **light** service!


![Framework](https://github.com/user-attachments/assets/3459c921-0a2f-4788-ab12-fe199fb44974)


---

## Table of Contents 📑

- [Features](#features)
- [Technologies Used](#technologies-used)
- [Installation](#installation)
- [License](#license)
- [Screenshots](#Screenshots)

---

## Features ✨

- **Email Processing**: Automatically captures and stores incoming emails.
- **Code Extraction**: Utilizes AI to extract verification codes, links, and organization names from emails.
- **Secure Front-End**: Provides a web interface protected by Basic Access Authentication for viewing extracted codes.
- **Real-Time Notifications**: Optionally sends notifications via Bark when new codes are extracted.
- **Database Integration**: Stores raw and processed email data in a Cloudflare D1 Database.

---

## Technologies Used 🛠️

- **Cloudflare Workers**: Serverless platform for handling email processing and web requests.
- **Cloudflare D1**: Cloudflare's serverless SQL database for storing email data.
- **TypeScript**: Strongly typed programming language for robust and maintainable code.
- **Google AI Studio API**: Utilized for extracting relevant information from emails with optimized AI prompts to enhance data accuracy and reliability.
- **AI Prompt Optimization**: Custom-crafted prompts ensure precise extraction of titles, codes, and topics from varied email formats.
- **Bark API**: Optional integration for sending real-time notifications.
- **HTML/CSS**: Front-end interface with responsive and modern design.

---

## AI Prompt Optimization 🧠

To ensure accurate extraction of information from incoming emails, we've implemented AI prompt optimization using the Google AI Studio API. By crafting precise and context-aware prompts, the AI can reliably identify and extract key elements such as:

- **Organization Name (Title)**: Identifies the sender's organization or company.
- **Verification Code/Link**: Extracts codes, links, or passwords necessary for account verification.
- **Email Topic**: Summarizes the main purpose of the email, such as 'account verification' or 'password reset'.

**Prompt:**
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

## Installation ⚙️
0. **Prerequisites**

   1. Install [Wrangler](https://developers.cloudflare.com/workers/wrangler/get-started/)
   ```bash
   npm install wrangler -g
   ```

   2. Create a [Google AI Studio API](https://aistudio.google.com/)

   3. Bind a domain to your [Cloudflare](https://dash.cloudflare.com/) account

   4. (Optional) Download the [Bark App](https://bark.day.app/) and get a Bark Token from the App

2. **Initialization**

   ```bash
   git clone https://github.com/TooonyChen/AuthInbox.git
   cd AuthInbox
   npm install
   ```

3. **create d1 database**

   When you execute the [Wrangler](https://developers.cloudflare.com/workers/wrangler/get-started/) login command for the first time, you will be prompted to log in. Just follow the prompts.

   ```bash
   npx wrangler d1 execute inbox-d1 --local --file=./schema.sql # creating a d1 database called 'inbox-d1'
   ```
   you will get the result like this:
   ```bash
   ✅ Successfully created DB 'inbox-d1'

   [[d1_databases]]
   binding = "DB" # available in your Worker on env.DB
   database_name = "inbox-d1"
   database_id = "<unique-ID-for-your-database>"
   ```
   please copy the result from your terminal, you will use them in the next step

4. **Configure Environment Variables**

Use `wrangler.toml` file in the project root with the necessary environment variables:

   ```toml
   name = "auth-inbox"
   type = "typescript"

   [vars]
   UseBark = "true" # set 'true' to use or 'false' to not use
   barkUrl = "https://api.day.app"
   barkTokens = "[token1, token2]" # set to your bark tokens on your iOS device, download it from https://bark.day.app/, you can use multiple tokens, if you only use one, then set it to '[token1]'
   FrontEndAdminID = "admin" # your login
   FrontEndAdminPassword = "password" # your password
   GoogleAPIKey = "xxxxxxxxxxx" # your google api, go to https://aistudio.google.com/ to generate one if u dont have

   [[d1_databases]] # Copy the lines obtained from step 2 from your terminal.
   binding = "DB"
   database_name = "inbox-d1" # Copy from step 2
   database_id = "<unique-ID-for-your-database>" # Copy from step 2
   ```
4. **Deploy your own worker** 🌐
   Deploy your Worker to make your project accessible on the Internet. Run:
   ```bash
   npx wrangler deploy
   ```
   You will get output like this:
   ```
   Outputs: https://auth-inbox.<YOUR_SUBDOMAIN>.workers.dev
   ```
   You can now visit the URL for your newly depolyed Auth Inbox for checking the email results.
5. **Set Email Forwarding** ✉️
   Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) -> `Websites` -> `<your-domain>` -> `Email` -> `Email-Routing` -> `Routing Rules`

   if you want to use `catch-all address`:
   ![image](https://github.com/user-attachments/assets/53e5a939-6b03-4ca6-826a-7a5f02f361ac)

   if you want to use `custom address`:
   ![image](https://github.com/user-attachments/assets/b0d0ab94-c2ad-4870-ac08-d53e64b2c880)

7. **Done**✅

   All set! Try it now!


---

## License 📜

This project is licensed under the [MIT License](LICENSE).

---

## Screenshots 📸

![image](https://github.com/user-attachments/assets/ec14d226-ae82-4689-b44d-22850002c34c)


---

## Acknowledgements 🙏

- **Cloudflare Workers** for providing a powerful serverless platform.
- **Google Gemini AI** for enabling intelligent email content extraction.
- **Bark** for real-time notification capabilities.
- **Open Source Community** for inspiring and supporting projects like AuthInbox.
- **ChatGPT** for helping me writing some of the code.

---

## TODO 📝

- [ ] **Multi-User Support**: Add functionality to manage multiple users for increased flexibility and broader usage.
- [ ] **Enhance Front-End Design**: Improve the UI/UX of the web interface for a more modern and user-friendly experience.
- [ ] **API**: Add API functionality.

---
