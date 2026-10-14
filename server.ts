import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { hasFfmpeg } from "./server/ffmpeg";
import { registerAiRoutes } from "./server/routes/ai";
import { registerRenderRoutes } from "./server/routes/render";
import { registerAudioRoutes } from "./server/routes/audio";
import { registerCardRoutes } from "./server/routes/cards";
import { registerMediaRoutes } from "./server/routes/media";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3100;

/** Read from package.json so it cannot drift from the released version. */
const APP_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
})();

app.use(express.json({ limit: "25mb" }));

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
  console.error("Unhandled API error:", err);
  if (res.headersSent) return next(err);
  return res.status(500).json({ error: err?.message || "Internal server error" });
});

/**
 * The built bundle serves the built client. Detected from the file being run as
 * well as NODE_ENV, because `NODE_ENV=production node …` does not work in the
 * Windows command prompt.
 */
const PRODUCTION = process.env.NODE_ENV === "production" || /server\.cjs$/.test(process.argv[1] || "");

async function startServer() {
  if (!PRODUCTION) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // Derived from PORT so a second copy on another port does not collide.
        hmr: { port: PORT + 21678 },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Leen Kurdish Studio ${APP_VERSION} running at http://localhost:${PORT}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nPort ${PORT} is already in use — the app is probably already running.`);
      console.error(`Open http://localhost:${PORT}, or start this copy elsewhere: PORT=${PORT + 1} npm run dev\n`);
      process.exit(1);
    }
    throw err;
  });
}

startServer();
