import express from "express";
import http from "http";
import os from "os";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { hasFfmpeg } from "./server/ffmpeg";
import { apiGuard, errorResponse, isLoopbackHost, listenHosts } from "./server/security";
import { registerAiRoutes } from "./server/routes/ai";
import { registerRenderRoutes } from "./server/routes/render";
import { registerAudioRoutes } from "./server/routes/audio";
import { registerCardRoutes } from "./server/routes/cards";
import { registerMediaRoutes } from "./server/routes/media";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3100;

/**
 * This computer only, unless HOST says otherwise. The server spends the Gemini
 * key in .env and runs ffmpeg on what it is sent, so other devices on the
 * network are an explicit opt-in (HOST=0.0.0.0), never the default.
 */
const HOST_SETTING = (process.env.HOST || "").trim();
const LAN = HOST_SETTING !== "" && !isLoopbackHost(HOST_SETTING);
/**
 * Always including both loopbacks (see listenHosts): http://localhost:PORT has
 * to keep working, also with LAN access on, because the browser keeps the
 * projects per address and that is the address the teacher opens.
 */
const LISTEN_HOSTS = listenHosts(HOST_SETTING);

/** Read from package.json so it cannot drift from the released version. */
const APP_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
})();

/*
 * Before anything reads a body: requests from other sites, or for another
 * host name (DNS rebinding), are turned away first.
 */
app.use("/api", apiGuard({ lan: LAN }));

// The largest JSON the app sends is a translate request with every line of a
// long project (and the rest as context): well under a megabyte even for a
// story of thousands of lines. Audio and video go as multipart, not JSON.
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", async (_req, res) => {
  res.json({
    status: "ok",
    app: "leen-kurdish-studio",
    version: APP_VERSION,
    ffmpeg: await hasFfmpeg(),
    serverKey: Boolean((process.env.GEMINI_API_KEY || "").trim()),
  });
});

registerAiRoutes(app);
registerRenderRoutes(app);
registerAudioRoutes(app);
registerCardRoutes(app);
registerMediaRoutes(app);

/* ------------------------------------------------------------------ */

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const { status, error } = errorResponse(err);
  if (status >= 500) console.error("Unhandled API error:", err);
  else console.warn(`Request refused (${status}): ${error}`);
  if (res.headersSent) return next(err);
  return res.status(status).json({ error });
});

/*
 * A last line of defence. An error thrown from a callback or a promise that
 * nobody awaited would otherwise take the whole server down, and with it
 * every other job and the teacher's open tab. Once the server is up, such an
 * error is logged and the server carries on; before that (a port in use, Vite
 * failing to start), it still stops the process.
 */
let started = false;

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  if (!started) process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  if (!started) process.exit(1);
});

/**
 * The built bundle serves the built client. Detected from the file being run as
 * well as NODE_ENV, because `NODE_ENV=production node …` does not work in the
 * Windows command prompt.
 */
const PRODUCTION = process.env.NODE_ENV === "production" || /server\.cjs$/.test(process.argv[1] || "");

function listenOn(host: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(PORT, host, () => {
      server.off("error", reject);
      // Errors after start-up (running out of file handles, say) are logged, not fatal.
      server.on("error", (err) => console.error(`Server error on ${host}:`, err));
      resolve(server);
    });
  });
}

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => Boolean(a && a.family === "IPv4" && !a.internal))
    .map((a) => a.address);
}

async function startServer() {
  if (!PRODUCTION) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          // Derived from PORT so a second copy on another port does not collide.
          port: PORT + 21678,
          // Live reload listens where the app does. With LAN access on it is
          // left to follow the page's own address, so other devices reach it.
          ...(LAN ? {} : { host: "127.0.0.1" }),
        },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  const [primary, ...extra] = LISTEN_HOSTS;
  try {
    await listenOn(primary);
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      console.error(`\nPort ${PORT} is already in use — the app is probably already running.`);
      console.error(`Open http://localhost:${PORT}, or start this copy elsewhere: PORT=${PORT + 1} npm run dev\n`);
    } else {
      console.error(`\nCould not start the server on ${primary}:${PORT}: ${err?.message || err}`);
      if (LAN) console.error(`Check HOST=${HOST_SETTING} (in .env or the environment): it must be an address of this computer.`);
      console.error("");
    }
    process.exit(1);
  }

  let url = `http://localhost:${PORT}`;
  for (const host of extra) {
    try {
      await listenOn(host);
    } catch (err: any) {
      // No IPv6 on this computer: 127.0.0.1 is all "localhost" can mean here.
      if (["EADDRNOTAVAIL", "EAFNOSUPPORT", "EINVAL"].includes(err?.code)) continue;
      // Something else has the port there, and "localhost" may reach it instead of the app.
      if (host === "::1") url = `http://127.0.0.1:${PORT}`;
      console.warn(
        `Another program is using port ${PORT} on ${host} (${err?.code || err})` +
          (host === "::1" ? `; open ${url} instead of localhost.` : ".")
      );
    }
  }

  started = true;
  console.log(`Leen Kurdish Studio ${APP_VERSION} running at ${url}`);
  if (LAN) {
    const where = lanAddresses().map((ip) => `http://${ip}:${PORT}`);
    console.warn(
      `\nLAN access is ON (HOST=${HOST_SETTING}). Other devices on this network can open the app` +
        (where.length ? ` at ${where.join(" or ")}` : "") +
        ` and use your Gemini key from .env.\nRemove HOST from the environment or .env to keep it to this computer.\n`
    );
  }
}

startServer().catch((err) => {
  console.error("The app could not start:", err);
  process.exit(1);
});
