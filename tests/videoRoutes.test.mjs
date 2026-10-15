/**
 * The video routes end to end with the real ffmpeg: what the app sends, and
 * what a crafted request must not get. Skipped when ffmpeg is not installed.
 */
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { check, near, done } from "./harness.mjs";

function installed(tool) {
  try {
    execFileSync(tool, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!installed("ffmpeg") || !installed("ffprobe")) {
  console.log("SKIP  ffmpeg and ffprobe are not installed");
  done("video routes");
  process.exit(0);
}

// Every temporary file the routes make lands here, so leftovers can be counted.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "leen-routes-"));
const temp = path.join(scratch, "temp");
const media = path.join(scratch, "media");
const outside = path.join(scratch, "private");
for (const dir of [temp, media, outside]) fs.mkdirSync(dir);
process.env.TMPDIR = process.env.TEMP = process.env.TMP = temp;

const { registerMediaRoutes } = await import("../server/routes/media.ts");
const { registerRenderRoutes } = await import("../server/routes/render.ts");

const run = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const file = (name) => path.join(media, name);

/* ---------- test media ---------- */

// A picture that flashes white at 2.0s, and a sound track that starts 0.5s
// late with a beep that, on the video's clock, is also at 2.0s.
run([
  "-f", "lavfi", "-i", "color=black:s=320x240:r=30:d=3,drawbox=w=iw:h=ih:color=white:t=fill:enable='between(t,2,2.099)'",
  "-itsoffset", "0.5", "-f", "lavfi", "-i", "aevalsrc='if(between(t,1.5,1.6),sin(2*PI*1000*t),0)':s=48000:d=2.5",
  "-c:v", "libx264", "-preset", "ultrafast", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
  "-c:a", "aac", file("late.mp4"),
]);
// Subtitle bands: opaque green and yellow boxes on transparency.
for (const [name, colour] of [["a.png", "0x00FE00"], ["b.png", "0xFFFF00"]]) {
  run(["-f", "lavfi", "-i", `color=c=black@0.0:s=320x80,format=rgba,drawbox=x=20:y=10:w=280:h=60:color=${colour}@1:t=fill:replace=1`, "-frames:v", "1", file(name)]);
}
// A PNG header that claims 0x0.
{
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  fs.writeFileSync(file("zero.png"), head);
}
// Card frames as the canvas renderer sends them (JPEG, BT.601 full range), and its mixdown.
run(["-f", "lavfi", "-i", "color=c=0x0000FE:s=240x426:r=30:d=1", "-q:v", "3", file("%06d.jpg")]);
run(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "1", "-c:a", "pcm_s16le", file("mix.wav")]);
// A file outside the temp folder, and a playlist that points at it.
run(["-f", "lavfi", "-i", "testsrc2=s=160x120:d=2", "-f", "lavfi", "-i", "sine=d=2", "-c:v", "mpeg2video", "-c:a", "mp2", "-f", "mpegts", path.join(outside, "private.ts")]);
fs.writeFileSync(file("x.m3u8"), `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:2.0,\n${path.join(outside, "private.ts")}\n#EXT-X-ENDLIST\n`);

/** Where the first loud sample is, playing the sound straight through as a player that ignores timestamp holes would. */
function beepAt(input, isWav = false) {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", input, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  for (let i = 0; i + 1 < raw.length; i += 2) if (Math.abs(raw.readInt16LE(i)) > 8000) return i / 2 / 48000;
  return isWav ? -1 : null;
}
function streams(input) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", input]).toString());
}
function pixel(input, time, x, y) {
  const out = execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", input, "-frames:v", "1",
    "-vf", `scale=in_color_matrix=bt709:in_range=tv,format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-",
  ]);
  return [...out.subarray(0, 3)];
}
const blob = async (name, type = "application/octet-stream") => new Blob([fs.readFileSync(file(name))], { type });

/* ---------- the server ---------- */

const app = express();
app.use(express.json());
registerRenderRoutes(app);
registerMediaRoutes(app);
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function post(route, fields) {
  const form = new FormData();
  for (const [name, value, filename] of fields) {
    if (value instanceof Blob) form.append(name, value, filename);
    else form.append(name, String(value));
  }
  const res = await fetch(base + route, { method: "POST", body: form });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}
const saved = (name, body) => {
  const target = path.join(scratch, name);
  fs.writeFileSync(target, body);
  return target;
};

try {
  /* extract-audio */
  {
    const { res, body } = await post("/api/media/extract-audio", [["video", await blob("late.mp4"), "clip.MP4"]]);
    check("extract-audio answers with a WAV", res.status === 200 && res.headers.get("content-type") === "audio/wav", String(res.status));
    check("…and the video's size and length", res.headers.get("x-media-width") === "320" && near(Number(res.headers.get("x-media-duration")), 3, 0.05));
    const beep = beepAt(saved("late.wav", body), true);
    check("the WAV is on the video's clock (late start padded)", near(beep, 2.0, 0.03), String(beep));

    const playlist = await post("/api/media/extract-audio", [["video", await blob("x.m3u8"), "x.m3u8"]]);
    check("a playlist posing as a video is refused", playlist.res.status === 400 && playlist.body.length < 500, `${playlist.res.status} ${playlist.body.length} bytes`);
  }

  /* subtitled render */
  const cueFields = async () => [
    ["width", 320], ["height", 568], ["fit", "blur"], ["cueX", 0], ["cueY", 400],
    ["cues", JSON.stringify([{ file: "c0.png", start: 0.5, end: 1.5 }, { file: "c1.png", start: 1.5, end: 2.8 }])],
    ["cue", await blob("a.png", "image/png"), "c0.png"],
    ["cue", await blob("b.png", "image/png"), "c1.png"],
  ];
  let subtitled = "";
  {
    const zero = await post("/api/render/subtitled?job=zero", [
      ["width", 320], ["height", 568], ["cues", JSON.stringify([{ file: "z.png", start: 0, end: 1 }])],
      ["cue", await blob("zero.png", "image/png"), "z.png"],
      ["video", await blob("late.mp4"), "v.mp4"],
    ]);
    check("a 0x0 subtitle image is a 400, not a crash", zero.res.status === 400, String(zero.res.status));

    const { res, body } = await post("/api/render/subtitled?job=ok", [...(await cueFields()), ["video", await blob("late.mp4"), "v.mov"]]);
    check("the subtitled render answers with an MP4", res.status === 200 && body.length > 1000, `${res.status} ${body.subarray(0, 200)}`);
    subtitled = saved("subtitled.mp4", body);
    const info = streams(subtitled);
    const video = info.streams.find((s) => s.codec_type === "video");
    const audio = info.streams.find((s) => s.codec_type === "audio");
    check("subtitled output is labelled BT.709 SDR", video?.color_space === "bt709" && video?.color_transfer === "bt709" && video?.color_primaries === "bt709", JSON.stringify(video));
    check("its sound starts with the picture", near(Number(audio?.start_time), 0, 0.01), audio?.start_time);
    const beep = beepAt(subtitled);
    check("the video's own sound stays in step with the picture", near(beep, 2.0, 0.03), String(beep));
    const green = pixel(subtitled, 1.0, 160, 440);
    check("the subtitle keeps its colour (BT.709 matrix)", green[0] < 12 && green[1] > 240 && green[2] < 12, green.join());
    const progress = await (await fetch(`${base}/api/render/subtitled/progress?job=ok`)).json();
    check("the job ends as done", progress.stage === "done" && progress.fraction === 1, JSON.stringify(progress));
  }

  /* render session: start, frames, finish */
  let card = "";
  {
    const start = await (await fetch(`${base}/api/render/start`, { method: "POST" })).json();
    const frames = [];
    for (let i = 0; i < 30; i++) frames.push(["frames", await blob(`${String(i + 1).padStart(6, "0")}.jpg`, "image/jpeg"), `f${i}.jpg`]);
    const sent = await post("/api/render/frames", [["sessionId", start.sessionId], ["startIndex", 0], ...frames]);
    check("frames are stored", sent.res.status === 200 && JSON.parse(sent.body).total === 30, sent.body.toString());
    const { res, body } = await post("/api/render/finish", [["sessionId", start.sessionId], ["audio", await blob("mix.wav", "audio/wav"), "audio.wav"], ["fps", 30]]);
    check("finish answers with an MP4", res.status === 200 && body.length > 1000, String(res.status));
    card = saved("card.mp4", body);
    const video = streams(card).streams.find((s) => s.codec_type === "video");
    check("a card is converted and labelled BT.709 like the video", video?.color_space === "bt709" && video?.color_range === "tv", JSON.stringify(video));
    const blue = pixel(card, 0.5, 120, 200);
    check("…keeping its colours", blue[0] < 8 && blue[1] < 8 && blue[2] > 240, blue.join());
    const again = await post("/api/render/finish", [["sessionId", start.sessionId], ["fps", 30]]);
    check("a finished session is gone", again.res.status === 404);
  }

  /* join */
  {
    const part = (p) => new Blob([fs.readFileSync(p)], { type: "video/mp4" });
    const { res, body } = await post("/api/render/join", [
      ["parts", part(card), "part0.mp4"],
      ["parts", part(subtitled), "part1.mp4"],
      ["width", 320], ["height", 568],
    ]);
    check("join answers with an MP4", res.status === 200 && body.length > 1000, `${res.status} ${body.subarray(0, 200)}`);
    const joined = saved("joined.mp4", body);
    const video = streams(joined).streams.find((s) => s.codec_type === "video");
    check("the joined file is labelled BT.709", video?.color_space === "bt709" && video?.color_primaries === "bt709", JSON.stringify(video));
    const beep = beepAt(joined);
    check("after the title card the sound is still in step", near(beep, 3.0, 0.06), String(beep));
    const green = pixel(joined, 2.0, 160, 440);
    check("the subtitle keeps its colour after the card", green[1] > 240 && green[0] < 12, green.join());

    const playlist = await post("/api/render/join", [
      ["parts", await blob("x.m3u8"), "part0.mp4"],
      ["parts", part(card), "part1.mp4"],
    ]);
    check("join refuses a playlist part", playlist.res.status === 400, String(playlist.res.status));
  }

  // Everything is removed in the background once each response is over.
  await new Promise((r) => setTimeout(r, 1500));
  // (tsx may keep its compile cache in the same folder; that is not the app's.)
  const left = fs.readdirSync(temp).filter((name) => !/^(tsx-|node-compile-cache)/.test(name));
  check("no temporary files are left behind", left.length === 0, left.join());
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

done("video routes");
