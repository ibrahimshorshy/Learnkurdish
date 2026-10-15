import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import multer from "multer";
import { toBt709, hdrToSdr, isHdr, TAG_BT709 } from "../server/color.ts";
import { fieldStorage, videoExtension, uploadProblem, only, VIDEO_FORMATS, MB } from "../server/uploads.ts";
import { frameFilter, subtitleGraph, pngSize, bannerColour } from "../server/routes/media.ts";
import { check, done } from "./harness.mjs";

/* ---------- colour ---------- */

{
  check("a BT.709 source is read as BT.709", toBt709({ matrix: "bt709", range: "tv" }).startsWith("in_color_matrix=bt709:in_range=limited"));
  check("a BT.601 source is converted", toBt709({ matrix: "smpte170m" }).includes("in_color_matrix=smpte170m"));
  check("bt470bg uses scale's own name", toBt709({ matrix: "bt470bg", range: "pc" }).startsWith("in_color_matrix=bt470:in_range=full"));
  check("output is always BT.709 limited", toBt709({}).endsWith("out_color_matrix=bt709:out_range=tv"));
  check("untagged HD is read as BT.709", toBt709({}, { width: 1080, height: 1920 }).includes("in_color_matrix=bt709"));
  check("untagged SD is read as BT.601", toBt709({}, { width: 640, height: 480 }).includes("in_color_matrix=bt601"));
  check("untagged, size unknown: the frame's own tag", toBt709(undefined).includes("in_color_matrix=auto"));
}

{
  const hlg = { matrix: "bt2020nc", primaries: "bt2020", transfer: "arib-std-b67", range: "tv" };
  check("HLG is HDR", isHdr(hlg) && isHdr({ transfer: "smpte2084" }) && !isHdr({ transfer: "bt709" }) && !isHdr(undefined));
  check("SDR needs no tone-mapping", hdrToSdr({ transfer: "bt709" }, true) === "");
  const mapped = hdrToSdr(hlg, true);
  check("HLG is tone-mapped with zscale", mapped.includes("tin=arib-std-b67") && mapped.includes("tonemap=") && mapped.endsWith(TAG_BT709), mapped);
  const guessed = hdrToSdr({ transfer: "smpte2084" }, true);
  check("an HDR file that leaves its matrix out gets BT.2020 spelled out", guessed.includes("min=bt2020nc") && guessed.includes("pin=bt2020"), guessed);
  const fallback = hdrToSdr(hlg, false);
  check("without zscale, still converted from BT.2020 and labelled", fallback.startsWith("colorspace=") && !fallback.includes("zscale") && fallback.endsWith(TAG_BT709), fallback);
}

{
  const sdr = frameFilter("crop", { width: 1080, height: 1920, colour: { matrix: "bt709" } }, 1080, 1920);
  check("every frame is labelled BT.709", sdr.endsWith(`${TAG_BT709}[base]`), sdr);
  const blur = frameFilter("blur", { width: 1920, height: 1080, colour: { matrix: "smpte170m" } }, 1080, 1920);
  check("both blur branches convert the matrix", (blur.match(/in_color_matrix=smpte170m/g) || []).length === 2, blur);
  const hdr = frameFilter("crop", { width: 2160, height: 3840, colour: { transfer: "arib-std-b67", matrix: "bt2020nc" } }, 1080, 1920, { toneMapping: true });
  check("4K HDR is shrunk before tone-mapping", hdr.startsWith("[0:v]scale=1080:1920,zscale="), hdr);
  check("…and the rest works from the SDR picture", hdr.includes("[sdr]scale=1080:1920:in_color_matrix=bt709"), hdr);
  const small = frameFilter("crop", { width: 720, height: 1280, colour: { transfer: "arib-std-b67" } }, 1080, 1920, { toneMapping: true });
  check("a small HDR picture is never enlarged first", small.startsWith("[0:v]zscale="), small);
  const graph = subtitleGraph({ fit: "blur", source: { width: 1920, height: 1080 }, width: 1080, height: 1920, cues: { x: 0, y: 0 }, overlay: null });
  check("cue PNGs are converted with BT.709", graph.includes("[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[cueimg]"), graph);
}

{
  const c = bannerColour(" hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67, progressive), 1280x720");
  check("banner colour: HLG", c.transfer === "arib-std-b67" && c.matrix === "bt2020nc" && c.range === "tv" && c.pixelFormat === "yuv420p10le", JSON.stringify(c));
  const one = bannerColour(" h264 (High), yuv420p(tv, bt709), 1920x1080");
  check("banner colour: one name for all three", one.matrix === "bt709" && one.transfer === "bt709", JSON.stringify(one));
  const jpeg = bannerColour(" mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 64x64");
  check("banner colour: unknown parts left out", jpeg.matrix === "bt470bg" && jpeg.transfer === undefined && jpeg.range === "pc", JSON.stringify(jpeg));
  check("banner colour: nothing said", bannerColour(" h264, yuv420p, 64x64").matrix === undefined);
}

/* ---------- PNG header ---------- */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "leen-test-"));
{
  const png = (w, h) => {
    const head = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
    head.writeUInt32BE(13, 8);
    head.write("IHDR", 12, "latin1");
    head.writeUInt32BE(w, 16);
    head.writeUInt32BE(h, 20);
    return head;
  };
  const file = (name, data) => {
    const p = path.join(scratch, name);
    fs.writeFileSync(p, data);
    return p;
  };
  const size = pngSize(file("ok.png", png(1080, 300)));
  check("PNG size read from the header", size?.width === 1080 && size?.height === 300, JSON.stringify(size));
  check("0x0 is read as such (the route refuses it)", pngSize(file("zero.png", png(0, 0)))?.width === 0);
  check("not a PNG: null", pngSize(file("m3u8.png", "#EXTM3U\n#EXT-X-TARGETDURATION:10\n")) === null);
  check("too short: null", pngSize(file("short.png", Buffer.from([0x89, 0x50]))) === null);
  check("missing file: null, not a throw", pngSize(path.join(scratch, "gone.png")) === null);
}

/* ---------- upload names and limits ---------- */

check("phone video extensions are kept", [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp"].every((e) => videoExtension(`clip${e.toUpperCase()}`) === e));
check("a playlist extension is dropped", videoExtension("x.m3u8") === "" && videoExtension("x.ffconcat") === "" && videoExtension(undefined) === "");
check("ffmpeg is told which containers to accept", only(VIDEO_FORMATS)[0] === "-format_whitelist" && /matroska/.test(VIDEO_FORMATS) && !/hls|concat/.test(VIDEO_FORMATS));
check("too large is a 413", uploadProblem(new multer.MulterError("LIMIT_FILE_SIZE", "cue"))?.status === 413);
check("other errors are not upload problems", uploadProblem(new Error("x")) === null);

/** Runs a multer middleware over a hand-made multipart body. */
function runUpload(middleware, parts) {
  const boundary = "----leen-test-boundary";
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"; filename="${part.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(part.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  const req = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) };
  return new Promise((resolve) => middleware(req, {}, (err) => resolve({ err, req })));
}

{
  const dir = fs.mkdtempSync(path.join(scratch, "up-"));
  const upload = multer({
    storage: fieldStorage(() => dir, {
      video: { maxBytes: 4 * MB, extension: videoExtension },
      cue: { maxBytes: 1000, maxTotalBytes: 1500, extension: () => ".png" },
    }),
  }).fields([{ name: "video", maxCount: 1 }, { name: "cue", maxCount: 5 }]);

  const ok = await runUpload(upload, [
    { field: "video", name: "x.m3u8", data: Buffer.from("#EXTM3U\n") },
    { field: "cue", name: "cue-00000.m3u8", data: Buffer.alloc(500) },
  ]);
  const names = ok.err ? [] : [ok.req.files.video[0].filename, ok.req.files.cue[0].filename];
  check("uploads are named by the server", !ok.err && names[0] === "video-1" && names[1] === "cue-2.png", String(ok.err || names.join()));
  check("the browser's name is still known", ok.req.files?.cue?.[0]?.originalname === "cue-00000.m3u8");

  const big = await runUpload(upload, [{ field: "cue", name: "a.png", data: Buffer.alloc(1001) }]);
  check("a file over its field's limit is refused", big.err?.code === "LIMIT_FILE_SIZE" && big.err?.field === "cue", String(big.err));
  const many = await runUpload(upload, [
    { field: "cue", name: "a.png", data: Buffer.alloc(800) },
    { field: "cue", name: "b.png", data: Buffer.alloc(800) },
  ]);
  check("a field over its total is refused", many.err?.code === "LIMIT_FILE_SIZE", String(many.err));
  // Removal of the partial copies is asynchronous.
  await new Promise((r) => setTimeout(r, 300));
  const left = fs.readdirSync(dir).filter((f) => f.startsWith("cue-") && f !== "cue-2.png");
  check("refused files are not left on disk", left.length === 0, left.join());
}

fs.rmSync(scratch, { recursive: true, force: true });
done("media server");
