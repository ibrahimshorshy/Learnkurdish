/**
 * Who may talk to the app's server.
 *
 * The server holds the Gemini key from .env and runs ffmpeg on what it is
 * sent, so only the app itself, in a browser on this computer, should reach
 * /api. Two things keep everyone else out:
 *
 *   1. It listens on the loopback address only (see server.ts). LAN access is
 *      an explicit opt-in: HOST=0.0.0.0.
 *   2. Every /api request is checked here, because a web page can still reach
 *      the loopback address from the teacher's own browser:
 *        - DNS rebinding: a site points its own name at 127.0.0.1, so its page
 *          counts as "same origin" and can read the answers. The Host header
 *          still carries the site's name, so it must be localhost or an
 *          address.
 *        - Cross-site requests: any page can fire a form POST at localhost
 *          without asking. Browsers mark those with Sec-Fetch-Site and Origin.
 *
 * The app's own requests are same-origin and pass; so does the health check
 * from setup.mjs, which sends no Origin at all.
 */

import net from "net";
import os from "os";
import type { NextFunction, Request, Response } from "express";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Whether a HOST setting means "this computer only". */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_NAMES.has(host.trim().toLowerCase());
}

/** The hostname and port in a Host header, normalised the way browsers write origins; null when it is not one. */
function parseHost(hostHeader: string): URL | null {
  if (!hostHeader || /[\s/\\@?#]/.test(hostHeader)) return null;
  try {
    return new URL(`http://${hostHeader}`);
  } catch {
    return null;
  }
}

function isIpLiteral(hostname: string): boolean {
  return net.isIP(hostname.replace(/^\[|\]$/g, "")) !== 0;
}

/**
 * This computer's own name, which other devices may use to reach it when LAN
 * access is on. Only the bare name and its .local form: allowing any name that
 * starts with it would let "teacher-pc.attacker.example" rebind its way in.
 */
function isOwnHostname(hostname: string): boolean {
  const own = os.hostname().trim().toLowerCase();
  return Boolean(own) && (hostname === own || hostname === `${own}.local`);
}

export interface GuardOptions {
  /** HOST opts into LAN access: other devices reach the app by this computer's address or name. */
  lan: boolean;
}

export interface GuardHeaders {
  host?: string;
  origin?: string;
  "sec-fetch-site"?: string;
}

/**
 * Why a request to /api must be refused, or null when it may go ahead.
 * Pure, so it can be tested without a server.
 */
export function requestProblem(headers: GuardHeaders, options: GuardOptions): string | null {
  const host = parseHost(String(headers.host || ""));
  if (!host) return "The request did not say which address it was for.";
  const hostname = host.hostname.toLowerCase();
  const hostAllowed =
    LOOPBACK_NAMES.has(hostname) || (options.lan && (isIpLiteral(hostname) || isOwnHostname(hostname)));
  if (!hostAllowed) {
    return options.lan
      ? `The app does not answer to “${hostname}”. Open it by this computer's IP address instead.`
      : `The app only answers at localhost, not “${hostname}”.`;
  }

  // Only browsers send this, and they always do for fetches: "same-origin" is
  // the app itself, "none" is the teacher typing the address. Anything else is
  // another site (or another app on a different localhost port).
  const site = String(headers["sec-fetch-site"] || "").toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return "Requests from other websites are not accepted.";

  // Older browsers without Sec-Fetch-Site still send Origin on a POST.
  if (headers.origin !== undefined) {
    let origin: URL | null = null;
    try {
      origin = new URL(String(headers.origin));
    } catch {
      origin = null;
    }
    if (!origin || (origin.protocol !== "http:" && origin.protocol !== "https:") || origin.host !== host.host) {
      return "Requests from other websites are not accepted.";
    }
  }
  return null;
}

/** Express middleware for /api: answers 403 for anything requestProblem refuses. */
export function apiGuard(options: GuardOptions) {
  let lastLogged = 0;
  return (req: Request, res: Response, next: NextFunction) => {
    const problem = requestProblem(
      {
        host: req.headers.host,
        origin: req.headers.origin,
        "sec-fetch-site": req.headers["sec-fetch-site"] as string | undefined,
      },
      options
    );
    if (!problem) return next();
    // One line now and then, not one per request: a page hammering the port should not flood the window.
    const now = Date.now();
    if (now - lastLogged > 5000) {
      lastLogged = now;
      console.warn(
        `Refused ${req.method} ${req.baseUrl}${req.path} (host ${req.headers.host || "none"}, origin ${req.headers.origin || "none"}, ` +
          `site ${req.headers["sec-fetch-site"] || "none"}): ${problem}`
      );
    }
    res.status(403).json({ error: problem });
  };
}

/* ------------------------------------------------------------------ */
/* Error text that is safe to send                                      */
/* ------------------------------------------------------------------ */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * An error message with this computer's folders taken out: temporary file
 * names mean nothing to the teacher, and the folder layout is nobody else's
 * business.
 */
export function withoutPaths(message: string): string {
  let text = message;
  const roots = [os.tmpdir(), process.cwd(), os.homedir()]
    .filter((root) => root && root.length > 1)
    .sort((a, b) => b.length - a.length);
  for (const root of roots) {
    text = text.replace(new RegExp(`${escapeRegExp(root)}[^\\s'":,)]*`, "gi"), "the file");
  }
  return text;
}

const MULTER_LIMITS: Record<string, string> = {
  LIMIT_FILE_SIZE: "That file is too big for the app's server.",
  LIMIT_FILE_COUNT: "Too many files were sent at once.",
  LIMIT_PART_COUNT: "The request had too many parts.",
  LIMIT_FIELD_COUNT: "The request had too many fields.",
  LIMIT_FIELD_VALUE: "A field in the request was too long.",
  LIMIT_FIELD_KEY: "A field name in the request was too long.",
};

/**
 * The status and message to send for an error that reached the last handler.
 * Upload and body limits are the sender's problem (4xx), not a server fault.
 */
export function errorResponse(err: any): { status: number; error: string } {
  if (err?.name === "MulterError") {
    const limit = MULTER_LIMITS[err.code];
    if (limit) return { status: 413, error: limit };
    return { status: 400, error: `The upload was not in the expected form (${String(err.message || err.code)}).` };
  }
  if (err?.type === "entity.too.large") return { status: 413, error: "The request is too large." };
  if (err?.type === "entity.parse.failed") return { status: 400, error: "The request was not valid JSON." };
  const status = Number(err?.status || err?.statusCode);
  if (status >= 400 && status < 500 && err?.expose) return { status, error: withoutPaths(String(err.message || "Bad request.")) };
  return { status: 500, error: withoutPaths(String(err?.message || "Internal server error")) };
}
