import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const configPath = process.env.QA_WRANGLER_CONFIG ?? "wrangler.toml";
const port = Number(process.env.QA_PORT ?? "8787");
const adminId = process.env.QA_ADMIN_ID ?? "admin";
const adminPassword = process.env.QA_ADMIN_PASSWORD ?? "qa-password";
const devVarsPath = ".dev.vars";
const workerUrl = `http://127.0.0.1:${port}/`;
const apiUrl = `http://127.0.0.1:${port}/api/_qa_probe`;

const previousDevVars = existsSync(devVarsPath) ? readFileSync(devVarsPath, "utf8") : null;
const tempDevVars = `FrontEndAdminPassword=${adminPassword}\nAI_API_KEY=qa-smoke-key\n`;
writeFileSync(devVarsPath, tempDevVars, "utf8");

const wranglerArgs = ["pnpm", "exec", "wrangler", "dev", "--config", configPath, "--local", "--port", String(port)];
const child = process.platform === "win32"
  ? spawn("cmd.exe", ["/d", "/s", "/c", `corepack ${wranglerArgs.join(" ")}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
  : spawn("corepack", wranglerArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

const stdoutLines = [];
const stderrLines = [];
const maxLogLines = 200;

function pushLog(target, chunk) {
  const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    target.push(line);
    if (target.length > maxLogLines) target.shift();
  }
}

child.stdout.on("data", (chunk) => pushLog(stdoutLines, chunk));
child.stderr.on("data", (chunk) => pushLog(stderrLines, chunk));

let readyResponse = null;
let lastError = null;

try {
  const auth = `Basic ${Buffer.from(`${adminId}:${adminPassword}`, "utf8").toString("base64")}`;

  for (let attempt = 1; attempt <= 45; attempt++) {
    await delay(1000);
    try {
      const response = await fetch(workerUrl, {
        signal: AbortSignal.timeout(3000),
        headers: { Authorization: auth },
      });
      readyResponse = response;
      if (response.status >= 200 && response.status < 500) {
        break;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (!readyResponse) {
    throw new Error(`Smoke test could not reach ${workerUrl}. Last error: ${String(lastError ?? "none")}`);
  }

  const rootBody = await readyResponse.text();
  const apiProbe = await fetch(apiUrl, {
    signal: AbortSignal.timeout(3000),
    headers: { Authorization: auth, Accept: "application/json" },
  });

  const checks = {
    status_200: readyResponse.status === 200,
    has_react_root: rootBody.includes('<div id="root"></div>'),
    api_probe_protected_or_not_found: apiProbe.status === 401 || apiProbe.status === 404,
    api_has_nosniff: apiProbe.headers.get("x-content-type-options") === "nosniff",
    api_has_referrer_policy: apiProbe.headers.get("referrer-policy") === "no-referrer",
  };

  const failedChecks = Object.entries(checks).filter(([, value]) => !value);
  if (failedChecks.length > 0) {
    throw new Error(
      `Assets smoke checks failed: ${failedChecks.map(([name]) => name).join(", ")} (api status=${apiProbe.status})`
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: workerUrl,
        checks,
      },
      null,
      2
    )
  );
} catch (error) {
  console.error("ASSETS smoke test failed.");
  console.error(String(error));
  if (stdoutLines.length > 0) {
    console.error("Recent wrangler stdout:");
    for (const line of stdoutLines.slice(-30)) console.error(line);
  }
  if (stderrLines.length > 0) {
    console.error("Recent wrangler stderr:");
    for (const line of stderrLines.slice(-30)) console.error(line);
  }
  process.exitCode = 1;
} finally {
  if (child.pid) {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Ignore cleanup failures in smoke mode.
      }
    } else if (!child.killed) {
      child.kill("SIGTERM");
      await delay(1500);
      if (!child.killed) child.kill("SIGKILL");
    }
  }

  if (previousDevVars === null) {
    rmSync(devVarsPath, { force: true });
  } else {
    writeFileSync(devVarsPath, previousDevVars, "utf8");
  }
}
