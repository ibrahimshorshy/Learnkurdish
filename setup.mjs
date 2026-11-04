/**
 * One-command setup and launch.
 *
 * Checks the toolchain, installs dependencies, asks for an API key the first
 * time, starts the server and opens the browser. Safe to re-run — anything
 * already done is skipped.
 *
 *   npm run go
 */

import { execSync, spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { createConnection } from "net";
import { createInterface } from "readline/promises";
import { stdin, stdout, platform } from "process";

const PORT = process.env.PORT || 3100;
const URL = `http://localhost:${PORT}`;

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const ok = (m) => console.log(`${c.green}✓${c.reset} ${m}`);
const warn = (m) => console.log(`${c.yellow}!${c.reset} ${m}`);
const fail = (m) => console.log(`${c.red}✗${c.reset} ${m}`);
const step = (m) => console.log(`\n${c.bold}${m}${c.reset}`);

function has(command) {
  const probe = platform === "win32" ? "where" : "which";
  return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

console.log(`\n${c.bold}${c.cyan}Leen Kurdish Studio${c.reset} ${c.dim}— setup${c.reset}`);

/* 1. Node version -------------------------------------------------------- */
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  fail(`Node ${process.versions.node} is too old. Install Node 20 or newer from https://nodejs.org`);
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

/* 2. Leftovers from older versions --------------------------------------- */

// This project has never shipped a PostCSS or Tailwind config — Tailwind v4
// runs through a Vite plugin instead. So if one of these is sitting here, it
// came from an older export that was unzipped into the same folder, and it
// will break the build: the v3-era config asks PostCSS to load `tailwindcss`
// as a plugin, which either errors outright or, if an old Tailwind 3 is
// installed anywhere above this folder, fails with "`@layer base` is used but
// no matching `@tailwind base` directive is present".
//
// Renamed rather than deleted, so nothing is destroyed if the guess is wrong.
const stale = [
  "postcss.config.js", "postcss.config.cjs", "postcss.config.mjs", "postcss.config.ts",
  "tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs", "tailwind.config.ts",
].filter(existsSync);

if (stale.length) {
  warn(`Found ${stale.length} config file(s) left over from an older version.`);
  for (const file of stale) {
    const parked = `${file}.old`;
    try {
      renameSync(file, parked);
      console.log(`  ${c.dim}renamed${c.reset} ${file} ${c.dim}→${c.reset} ${parked}`);
    } catch {
      fail(`Could not rename ${file}. Delete it by hand and run this again.`);
      process.exit(1);
    }
  }
  ok("Moved them aside — this version does not use them.");
}

/* 3. Dependencies -------------------------------------------------------- */

// Checking only that node_modules exists is not enough. Unzipping a new
// version into a folder that already had an old one leaves the old
// node_modules in place, setup declares itself satisfied, and the app then
// runs against last version's libraries — which is its own confusing pile of
// errors. Stamping what was installed makes an upgrade install itself.
const depStamp = "node_modules/.leen-kurdish-install-stamp";
const wantStamp = createHash("sha256")
  .update(readFileSync("package.json", "utf8"))
  .digest("hex");
const haveStamp = existsSync(depStamp) ? readFileSync(depStamp, "utf8").trim() : null;

if (haveStamp === wantStamp) {
  ok("Dependencies are up to date");
} else {
  step(
    haveStamp === null && existsSync("node_modules")
      ? "Dependencies look like they came from an older version — reinstalling..."
      : "Installing dependencies (takes a minute)..."
  );
  try {
    execSync("npm install --no-audit --no-fund", { stdio: "inherit" });
    writeFileSync(depStamp, wantStamp);
    ok("Dependencies installed");
  } catch {
    fail("npm install failed. Scroll up for the reason.");
    process.exit(1);
  }
}

/* 4. ffmpeg -------------------------------------------------------------- */
if (has("ffmpeg")) {
  ok("ffmpeg found — MP4 export enabled");
} else {
  warn("ffmpeg not found. It is needed to turn a lesson into an MP4.");

  // Windows and macOS both have a package manager we can drive directly, so
  // offer to do it rather than leaving the user to copy a command.
  const installer =
    platform === "win32" && has("winget")
      ? { cmd: "winget", args: ["install", "--id", "Gyan.FFmpeg", "-e", "--accept-package-agreements", "--accept-source-agreements"] }
      : platform === "darwin" && has("brew")
      ? { cmd: "brew", args: ["install", "ffmpeg"] }
      : null;

  if (installer) {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question(`\n  Install it now with ${c.bold}${installer.cmd}${c.reset}? [Y/n] `)).trim().toLowerCase();
    rl.close();

    if (answer === "" || answer === "y" || answer === "yes") {
      step("Installing ffmpeg...");
      const result = spawnSync(installer.cmd, installer.args, { stdio: "inherit", shell: platform === "win32" });
      if (result.status === 0) {
        ok("ffmpeg installed");
        console.log(`  ${c.dim}Windows needs a new terminal to see it — close this window and`);
        console.log(`  double-click Kurdish-Studio.bat again once, then you're set.${c.reset}`);
      } else {
        fail("ffmpeg install did not complete. You can carry on without it for now.");
      }
    }
  } else {
    const howto =
      platform === "darwin"
        ? "brew install ffmpeg"
        : platform === "win32"
        ? "winget install Gyan.FFmpeg"
        : "sudo apt install ffmpeg";
    console.log(`  ${c.dim}Install it with:${c.reset} ${c.bold}${howto}${c.reset}${c.dim}, then re-run this.${c.reset}`);
  }
}

/* 5. API key ------------------------------------------------------------- */
const hasKey =
  existsSync(".env") && /GEMINI_API_KEY\s*=\s*"?[^"\s]{10,}/.test(readFileSync(".env", "utf8"));

if (hasKey) {
  ok("API key found in .env");
} else {
  step("Gemini API key needed");
  console.log(`  ${c.dim}Get one free at${c.reset} https://aistudio.google.com/apikey`);
  const rl = createInterface({ input: stdin, output: stdout });
  const key = (await rl.question(`\n  Paste your key here: `)).trim();
  rl.close();

  if (!key) {
    fail("No key entered. Re-run when you have one, or paste it into the app's own key box later.");
    process.exit(1);
  }
  writeFileSync(".env", `GEMINI_API_KEY="${key}"\nPORT=${PORT}\n`);
  ok("Saved to .env (this file is gitignored — it never leaves your machine)");
}

/* 6. Is it already running? ---------------------------------------------- */

const openBrowser = (url) => {
  const opener = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  spawnSync(opener, [url], { stdio: "ignore", shell: platform === "win32" });
};

/** Whether anything is listening on a port at one address. */
function listening(host, port) {
  return new Promise((resolve) => {
    const probe = createConnection({ host, port });
    probe.setTimeout(600);
    probe.on("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("timeout", () => {
      probe.destroy();
      resolve(false);
    });
    probe.on("error", () => resolve(false));
  });
}

/**
 * Whether anything at all is listening on a port, at either loopback. The
 * browser may take "localhost" to ::1 first (Windows does), so a program there
 * counts even when 127.0.0.1 is free. Without IPv6 the ::1 probe just fails.
 */
async function portTaken(port) {
  return (await listening("127.0.0.1", port)) || (await listening("::1", port));
}

/**
 * Whether the thing on that port is us, rather than some unrelated program.
 * Asked by address rather than at "localhost", which Node may resolve to ::1
 * first even on a computer without IPv6. The app listens on 127.0.0.1 (and
 * ::1 where there is one) unless HOST says otherwise; the browser still opens
 * localhost, because it keeps the projects per address.
 */
async function isOurApp(port) {
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      const res = await fetch(`http://${host}:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) continue;
      const body = await res.json();
      if (body?.status === "ok" && body?.app === "leen-kurdish-studio") return true;
    } catch {
      // Nothing there, or not us: try the other loopback.
    }
  }
  return false;
}

let port = Number(PORT);

if (await portTaken(port)) {
  if (await isOurApp(port)) {
    // The overwhelmingly common case: Kurdish-Studio.bat double-clicked twice. Starting a
    // second copy would only fail, so hand them the one already running.
    step("The app is already running");
    ok(`Opening ${c.cyan}${URL}${c.reset}`);
    console.log(
      `\n  ${c.dim}It was started in another window. Close that window to stop it.${c.reset}\n`
    );
    openBrowser(URL);
    process.exit(0);
  }

  // Something else owns the port. Step aside rather than refusing to start.
  warn(`Port ${port} is taken by another program.`);
  let candidate = port + 1;
  while (candidate < port + 20 && (await portTaken(candidate))) candidate++;

  if (candidate >= port + 20) {
    fail("Could not find a free port. Close some programs and try again.");
    process.exit(1);
  }
  port = candidate;
  ok(`Using port ${port} instead.`);
}

/* 7. Launch -------------------------------------------------------------- */
const url = `http://localhost:${port}`;
step(`Starting the app at ${c.cyan}${url}${c.reset}`);
console.log(`${c.dim}Press Ctrl+C to stop.${c.reset}\n`);

const server = spawn("npx", ["tsx", "server.ts"], {
  stdio: "inherit",
  shell: platform === "win32",
  env: { ...process.env, PORT: String(port) },
});

// Open the tab once the server answers, rather than after a guess: starting
// Vite can take a while on a slow laptop, and a tab opened too early shows
// "connection refused". After a minute, open it anyway.
(async () => {
  const until = Date.now() + 60_000;
  while (Date.now() < until && !(await isOurApp(port))) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  openBrowser(url);
})();

server.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.kill(sig);
    process.exit(0);
  });
}
