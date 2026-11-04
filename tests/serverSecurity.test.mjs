/**
 * The server only does the app's own work: /api answers the app in a browser
 * on this computer, and the audio clean-up takes the WAV the app sends and
 * nothing else.
 *
 * The request guard and the error text are pure. The WAV checks run on files
 * written here; the parts that run ffmpeg are skipped, not failed, when it is
 * not installed.
 */
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { once } from "events";
import { execFileSync } from "child_process";
import express from "express";
import { apiGuard, requestProblem, isLoopbackHost, listenHosts, withoutPaths, errorResponse } from "../server/security.ts";
import {
  registerAudioRoutes,
  cancelSignal,
  inspectWav,
  cleanAudio,
  processAudioFile,
  readWav,
  writeWav16,
  MAX_AUDIO_SECONDS,
  PROCESS_RATE,
} from "../server/routes/audio.ts";
import { isAborted } from "../server/ffmpeg.ts";
import { check, done } from "./harness.mjs";

/* ---------------- who may call /api ---------------- */

const local = { lan: false };
const lan = { lan: true };
const ok = (headers, options = local) => requestProblem(headers, options) === null;

check("the app's own fetch passes", ok({ host: "localhost:3100", origin: "http://localhost:3100", "sec-fetch-site": "same-origin" }));
check("a GET from the app (no Origin) passes", ok({ host: "localhost:3100", "sec-fetch-site": "same-origin" }));
check("setup.mjs's health check (no Origin, no Sec-Fetch-Site) passes", ok({ host: "127.0.0.1:3100" }));
check("typing the address passes", ok({ host: "localhost:3100", "sec-fetch-site": "none" }));
check("127.0.0.1 and [::1] pass", ok({ host: "127.0.0.1:3100" }) && ok({ host: "[::1]:3100", origin: "http://[::1]:3100" }));
check("host names are not case-sensitive", ok({ host: "LocalHost:3100", origin: "http://localhost:3100" }));
check("DNS rebinding (another name for 127.0.0.1) is refused", !ok({ host: "attacker.example:3100" }));
check("a name that merely starts with localhost is refused", !ok({ host: "localhost.attacker.example:3100" }));
check("a missing Host is refused", !ok({}));
check("a malformed Host is refused", !ok({ host: "localhost:3100/x" }) && !ok({ host: "user@localhost" }));
check("a cross-site request is refused", !ok({ host: "localhost:3100", "sec-fetch-site": "cross-site" }));
check("same-site (another localhost port) is refused", !ok({ host: "localhost:3100", "sec-fetch-site": "same-site" }));
check("a foreign Origin is refused", !ok({ host: "localhost:3100", origin: "http://evil.example" }));
check("Origin on another port is refused", !ok({ host: "localhost:3100", origin: "http://localhost:5173" }));
check("Origin null (sandboxed frame, file://) is refused", !ok({ host: "localhost:3100", origin: "null" }));
check("a LAN address is refused unless LAN access is on", !ok({ host: "192.168.1.20:3100" }) && ok({ host: "192.168.1.20:3100", origin: "http://192.168.1.20:3100" }, lan));
check("LAN access still refuses DNS rebinding", !ok({ host: "attacker.example:3100" }, lan));
check("LAN access still refuses cross-site requests", !ok({ host: "192.168.1.20:3100", origin: "http://evil.example" }, lan));
check("this computer's own name is accepted with LAN access on", ok({ host: `${os.hostname().toLowerCase()}:3100` }, lan));
check(
  "HOST=localhost/127.0.0.1/::1 is not LAN access; 0.0.0.0 is",
  isLoopbackHost("localhost") && isLoopbackHost("127.0.0.1") && isLoopbackHost("::1") && !isLoopbackHost("0.0.0.0") && !isLoopbackHost("::")
);

/* ---------------- where it listens ---------------- */

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check("no HOST: both loopbacks, nothing else", same(listenHosts(""), ["127.0.0.1", "::1"]) && same(listenHosts("  "), ["127.0.0.1", "::1"]));
check("HOST=localhost or a loopback address: still loopback only", same(listenHosts("localhost"), ["127.0.0.1", "::1"]) && same(listenHosts("[::1]"), ["127.0.0.1", "::1"]));
check("HOST=0.0.0.0 also keeps ::1, so localhost works where it means IPv6", same(listenHosts("0.0.0.0"), ["0.0.0.0", "::1"]));
check("HOST=:: (dual stack) covers both loopbacks itself", same(listenHosts("::"), ["::"]) && same(listenHosts("[::]"), ["::"]));
check(
  "HOST=<one LAN address> keeps both loopbacks too, so localhost and setup.mjs's check still work",
  same(listenHosts("192.168.1.20"), ["192.168.1.20", "127.0.0.1", "::1"])
);

/* ---------------- error text ---------------- */

{
  const tmpFile = path.join(os.tmpdir(), "abc123", "stage.wav");
  const said = withoutPaths(`ENOENT: no such file or directory, open '${tmpFile}'`);
  check("temporary paths are taken out of error text", !said.includes(os.tmpdir()) && said.includes("the file"), said);
  const multer = errorResponse({ name: "MulterError", code: "LIMIT_FILE_SIZE", message: "File too large" });
  check("an upload over its limit is a 413, not a 500", multer.status === 413);
  check("an unexpected upload field is a 400", errorResponse({ name: "MulterError", code: "LIMIT_UNEXPECTED_FILE", message: "Unexpected field" }).status === 400);
  check("a JSON body over the limit is a 413", errorResponse({ type: "entity.too.large", status: 413, expose: true }).status === 413);
  check("broken JSON is a 400", errorResponse({ type: "entity.parse.failed", status: 400, expose: true }).status === 400);
  const crash = errorResponse(new Error(`EACCES: permission denied, open '${path.join(process.cwd(), "secret.txt")}'`));
  check("a server fault is a 500 without this computer's folders", crash.status === 500 && !crash.error.includes(process.cwd()), crash.error);
}

/* ---------------- the WAV the clean-up takes ---------------- */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leen-ku-sec-test-"));
const file = (name, bytes) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
};
async function refusal(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

/** A WAV header with the given format fields, then `dataBytes` of silence. */
function wavWith({ format = 1, channels = 1, rate = 48000, bits = 16, blockAlign = channels * (bits / 8), dataBytes = 9600, dataSize } = {}) {
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(format, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * blockAlign, 28);
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(bits, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataSize ?? dataBytes, 40);
  return out;
}

try {
  const app = await inspectWav(file("app.wav", writeWav16(new Float32Array(48000), 48000)));
  check("the app's own WAV passes, with its length", app.frames === 48000 && app.sampleRate === 48000 && app.seconds === 1);
  const stereo = await inspectWav(file("stereo.wav", wavWith({ channels: 2, rate: 44100, dataBytes: 44100 * 4 })));
  check("stereo 44.1kHz 16-bit passes", stereo.frames === 44100 && stereo.channels === 2);
  const streamed = await inspectWav(file("streamed.wav", wavWith({ dataBytes: 9600, dataSize: 0xffffffff })));
  check("a streamed WAV (size 0xFFFFFFFF) is measured from the file", streamed.frames === 4800);
  const cut = await inspectWav(file("cut.wav", wavWith({ dataBytes: 9600, dataSize: 96000 })));
  check("a cut-off WAV counts only the audio that is there", cut.frames === 4800);

  const mpd = file(
    "manifest",
    `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><BaseURL>/etc/secret.m4a</BaseURL></MPD>`
  );
  const notWav = await refusal(inspectWav(mpd));
  check("a DASH manifest is refused as not WAV (415)", notWav?.status === 415, String(notWav?.message));
  const adpcm = await refusal(inspectWav(file("adpcm.wav", wavWith({ format: 2, bits: 4, blockAlign: 256 }))));
  check("a compressed WAV (ADPCM) is refused (415)", adpcm?.status === 415, String(adpcm?.message));
  const float = await refusal(inspectWav(file("float.wav", wavWith({ format: 3, bits: 32 }))));
  check("a float WAV is refused (415)", float?.status === 415);
  const tinyRate = await refusal(inspectWav(file("rate.wav", wavWith({ rate: 100 }))));
  check("a made-up sample rate is refused (415)", tinyRate?.status === 415);
  const many = await refusal(inspectWav(file("channels.wav", wavWith({ channels: 6 }))));
  check("more than two channels is refused (415)", many?.status === 415);
  const empty = await refusal(inspectWav(file("empty.wav", wavWith({ dataBytes: 0 }))));
  check("an empty WAV is refused (400)", empty?.status === 400);

  // Longer than the cap: a sparse file, so the test writes a header and no audio.
  const longPath = file("long.wav", wavWith({ rate: 8000, dataBytes: 0, dataSize: 0xffffffff }));
  fs.truncateSync(longPath, 44 + (MAX_AUDIO_SECONDS + 60) * 8000 * 2);
  const tooLong = await refusal(inspectWav(longPath));
  check("a recording over the cap is refused (413) before any decoding", tooLong?.status === 413 && /Raw/.test(tooLong.message), String(tooLong?.message));
  check("the cap is at least three hours", MAX_AUDIO_SECONDS >= 3 * 3600);
} catch (err) {
  check("WAV checks ran", false, String(err?.stack || err));
}

/* ---------------- through ffmpeg ---------------- */

let ffmpegOk = false;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  ffmpegOk = true;
} catch {
  console.log("SKIP  ffmpeg is not installed — the ffmpeg checks did not run");
}

if (ffmpegOk) {
  try {
    // A real file the manifest points at: ffmpeg's DASH demuxer would decode it.
    const secret = path.join(dir, "secret.m4a");
    execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "aac", secret]);
    const manifest = file(
      "upload",
      `<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT2S" minBufferTime="PT1S"><Period><AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="128000" codecs="mp4a.40.2"><BaseURL>${secret}</BaseURL></Representation></AdaptationSet></Period></MPD>`
    );
    const work = fs.mkdtempSync(path.join(dir, "w-"));
    const refused = await refusal(processAudioFile(manifest, "raw", false, work));
    check("a manifest pointing at another file is refused, not decoded", refused?.status === 415, String(refused?.message));

    // Second fence: even past the header check, ffmpeg is told the input is WAV.
    const pinned = await refusal(
      cleanAudio(manifest, { sampleRate: 48000, channels: 1, frames: 96000, seconds: 2 }, "raw", false, fs.mkdtempSync(path.join(dir, "w-")))
    );
    check("ffmpeg itself will not read the manifest as DASH (-f wav)", Boolean(pinned) && !isAborted(pinned), String(pinned?.message).slice(0, 200));

    // The app's own WAV still comes back the same length, 48kHz mono 16-bit.
    const voice = Float32Array.from({ length: 44100 * 2 }, (_, i) => Math.sin(i / 11) * 0.3);
    const voicePath = file("voice.wav", writeWav16(voice, 44100));
    const result = await processAudioFile(voicePath, "clean", false, fs.mkdtempSync(path.join(dir, "w-")));
    const back = readWav(result.wav);
    check(
      "a 44.1kHz WAV from the app comes back as 48kHz mono 16-bit of the same length",
      back.sampleRate === PROCESS_RATE && back.channels === 1 && back.samples.length === 2 * PROCESS_RATE && result.samples === 2 * PROCESS_RATE,
      `${back.samples.length}`
    );

    // A cancelled request stops its ffmpeg instead of running to the end.
    const longVoice = path.join(dir, "long-voice.wav");
    execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=d=600:a=0.1", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", longVoice]);
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 300);
    const stopped = await refusal(processAudioFile(longVoice, "noisy", true, fs.mkdtempSync(path.join(dir, "w-")), controller.signal));
    const took = Date.now() - started;
    check("a cancelled clean-up stops early (ToolAborted)", isAborted(stopped) && took < 3000, `${took}ms, ${stopped?.message}`);
    const already = new AbortController();
    already.abort();
    const never = await refusal(processAudioFile(voicePath, "clean", false, fs.mkdtempSync(path.join(dir, "w-")), already.signal));
    check("an already-cancelled clean-up does not start", isAborted(never));
  } catch (err) {
    check("ffmpeg checks ran", false, String(err?.stack || err).slice(-400));
  }
}

/* ---------------- a real server ---------------- */

/*
 * The guard and the audio route mounted as server.ts mounts them, on a port
 * the system picks (port 0), so this never collides with a running app.
 */
const logged = [];
for (const level of ["log", "warn", "error"]) {
  const original = console[level];
  console[level] = (...args) => {
    logged.push(args.map(String).join(" "));
    original(...args);
  };
}

/** One request by hand, so Host and the moment of hanging up are ours to choose. */
function rawRequest(port, { method = "GET", path: target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers, agent: false }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function multipart(fields, fileName, fileBytes) {
  const boundary = "----leen-test-boundary";
  const parts = Object.entries(fields).map(
    ([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
  );
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${fileName}"\r\nContent-Type: audio/wav\r\n\r\n`),
    fileBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );
  const body = Buffer.concat(parts);
  return { body, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(body.length) } };
}

const app = express();
app.use("/api", apiGuard({ lan: false }));
app.use(express.json({ limit: "5mb" }));
app.get("/api/ping", (_req, res) => res.json({ ok: true }));
app.post("/api/echo", (req, res) => res.json({ size: JSON.stringify(req.body).length }));
app.get("/api/hangup", async (req, res) => {
  // Waits for the client to leave, as a long upload still being saved would.
  if (!req.socket.destroyed) await once(req.socket, "close");
  hangupSignal = cancelSignal(req, res);
});
let hangupSignal = null;
registerAudioRoutes(app);
app.use((err, _req, res, next) => {
  const { status, error } = errorResponse(err);
  if (res.headersSent) return next(err);
  res.status(status).json({ error });
});
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;

try {
  const health = await fetch(`http://127.0.0.1:${port}/api/ping`);
  check("a plain fetch with no Origin (setup.mjs's health check) gets through", health.status === 200);
  const viaLocalhost = await rawRequest(port, { path: "/api/ping", headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, "Sec-Fetch-Site": "same-origin" } });
  check("the app's own request gets through", viaLocalhost.status === 200);

  const rebound = await rawRequest(port, { path: "/api/ping", headers: { Host: `attacker.example:${port}` } });
  check(
    "a request for another host name is refused with a 403 and a JSON reason",
    rebound.status === 403 && /localhost/.test(JSON.parse(rebound.body.toString()).error || "")
  );
  const crossSite = await rawRequest(port, {
    method: "POST",
    path: "/api/audio/process",
    headers: { Host: `localhost:${port}`, Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site", ...multipart({ preset: "raw" }, "a.wav", Buffer.alloc(64)).headers },
    body: multipart({ preset: "raw" }, "a.wav", Buffer.alloc(64)).body,
  });
  check("a cross-site upload is refused before it reaches the route", crossSite.status === 403);

  const big = JSON.stringify({ lines: Array.from({ length: 100000 }, () => "ئەمە دێڕێکی کوردییە بۆ تاقیکردنەوە") });
  const tooBig = await rawRequest(port, {
    method: "POST",
    path: "/api/echo",
    headers: { Host: `localhost:${port}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(big)) },
    body: big,
  });
  check(
    "a JSON body over the limit is a 413 with a plain message",
    tooBig.status === 413 && JSON.parse(tooBig.body.toString()).error === "The request is too large.",
    `${tooBig.status} ${Buffer.byteLength(big)} bytes`
  );
  const story = JSON.stringify({ lines: Array.from({ length: 3000 }, () => "ئەمە دێڕێکی کوردییە بۆ تاقیکردنەوە، کە درێژترە لە دێڕێکی ئاسایی چیرۆکێک") });
  const fits = await rawRequest(port, {
    method: "POST",
    path: "/api/echo",
    headers: { Host: `localhost:${port}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(story)) },
    body: story,
  });
  check("a translate request for a 3000-line story fits the JSON limit", fits.status === 200, `${fits.status}`);

  // A client that hung up before the route began (its upload still being saved).
  const gone = http.request({ host: "127.0.0.1", port, path: "/api/hangup", agent: false });
  gone.on("error", () => {});
  gone.end();
  await new Promise((resolve) => setTimeout(resolve, 100));
  gone.destroy();
  for (let i = 0; i < 50 && !hangupSignal; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  check("a client that left before the route began counts as cancelled from the start", hangupSignal?.aborted === true);

  if (ffmpegOk) {
    const minute = writeWav16(Float32Array.from({ length: 48000 * 60 }, (_, i) => Math.sin(i / 13) * 0.2), 48000);
    const upload = multipart({ preset: "raw", room: "0" }, "audio.wav", minute);

    // Read to the last byte and hang up at once, as curl does: that is a finished request, not a cancel.
    logged.length = 0;
    const full = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: "/api/audio/process", headers: { Host: `localhost:${port}`, ...upload.headers }, agent: false },
        (res) => {
          let got = 0;
          const expected = Number(res.headers["content-length"]);
          res.on("data", (c) => {
            got += c.length;
            if (got >= expected) {
              req.destroy();
              resolve({ status: res.statusCode, got, expected });
            }
          });
          res.on("end", () => resolve({ status: res.statusCode, got, expected }));
        }
      );
      req.on("error", reject);
      req.end(upload.body);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    check(
      "a full download that hangs up straight after is not logged as a cancel",
      full.status === 200 && full.got === full.expected && full.expected === 44 + 48000 * 60 * 2 && !logged.some((l) => /stopped/.test(l)),
      `${full.got}/${full.expected} ${logged.filter((l) => /clean-up/i.test(l)).join(" | ")}`
    );

    // Hang up after the first bytes of the answer: the rest is never made.
    logged.length = 0;
    await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: "/api/audio/process", headers: { Host: `localhost:${port}`, ...upload.headers }, agent: false },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        }
      );
      req.on("error", () => {});
      req.end(upload.body);
      setTimeout(() => reject(new Error("no answer")), 20000);
    });
    for (let i = 0; i < 50 && !logged.some((l) => /stopped/.test(l)); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    check("a download dropped half way stops the route (and its clean-up runs)", logged.some((l) => /stopped/.test(l)), logged.join(" | "));
  }
} catch (err) {
  check("server checks ran", false, String(err?.stack || err).slice(-400));
} finally {
  server.close();
  server.closeAllConnections?.();
}

fs.rmSync(dir, { recursive: true, force: true });
done("serverSecurity");
