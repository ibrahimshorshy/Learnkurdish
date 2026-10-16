import { useEffect, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Scissors, Play, Square, RotateCcw, X } from "lucide-react";
import type { LessonLine, TimeRange } from "../types";
import type { Playback } from "../audio/useRecordingAudio";
import { waveformPeaks, formatTime, levellingGain, playRange, stopPlayback } from "../audio/audioTools";
import { addCut, assemble, cutAt, restoreCutAt, subtractRanges } from "../audio/clipBuilder";

interface Props {
  mono: Float32Array;
  duration: number;
  lines: LessonLine[];
  selectedId: string | null;
  playhead: number | null;
  onSelect: (id: string) => void;
  onPlayLine: (line: LessonLine) => void;
  /** Called while an edge is dragged. */
  onRetime: (id: string, range: { start: number; end: number }) => void;
  /** Removed stretches of the recording, drawn struck out. Omit to hide cutting entirely. */
  cuts?: TimeRange[];
  onCutsChange?: (cuts: TimeRange[]) => void;
  /**
   * The app's player, for previewing a selection (so the playhead follows and
   * the other players stop). Without it, previews play directly.
   */
  playback?: Pick<Playback, "play" | "stop" | "playing">;
}

const HEIGHT = 132;
const EDGE_GRAB_PX = 7;
const ZOOMS = [1, 2, 4, 8, 16];
/** Shorter than this, a drag was a wobble of the mouse, not a selection. */
const MIN_SELECTION = 0.03;
/** "Hear without it" plays this much either side of the part. */
const PREVIEW_CONTEXT = 1.2;

type Drag =
  | { kind: "edge"; id: string; edge: "start" | "end" }
  | { kind: "select"; anchor: number; x: number; moved: boolean };

/**
 * The whole recording as a waveform, with each line drawn over it as a block.
 * Drag a block's edge to move where the line starts or ends; click a block to
 * select it and hear it.
 *
 * With cutting on (onCutsChange given), a stretch can be selected — in Cut
 * mode, or by holding Shift — and removed: a cough, a false start, an "um".
 * Nothing is deleted from the recording; the cut is skipped when each line's
 * clip is built, and can be restored at any time.
 */
export default function WaveformEditor({
  mono,
  duration,
  lines,
  selectedId,
  playhead,
  onSelect,
  onPlayLine,
  onRetime,
  cuts,
  onCutsChange,
  playback,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [hoverEdge, setHoverEdge] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const dragRef = useRef<Drag | null>(null);

  const canCut = Boolean(onCutsChange);
  const [cutMode, setCutMode] = useState(false);
  const [selection, setSelection] = useState<TimeRange | null>(null);
  const [activeCut, setActiveCut] = useState<TimeRange | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);

  // A cut restored from elsewhere ("Restore all") is no longer there to show.
  const shownCut =
    activeCut && (cuts ?? []).some((c) => c.start === activeCut.start && c.end === activeCut.end) ? activeCut : null;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const width = Math.min(16000, Math.max(200, Math.round(containerWidth * zoom)));
  const peaks = useMemo(() => waveformPeaks(mono, width), [mono, width]);
  const pxPerSecond = duration > 0 ? width / duration : 1;
  const sampleRate = duration > 0 ? Math.round(mono.length / duration) : 48000;
  const gain = useMemo(() => levellingGain(mono), [mono]);

  // Keep the selected line in view when zoomed in.
  useEffect(() => {
    const el = scrollRef.current;
    const line = lines.find((l) => l.id === selectedId);
    if (!el || !line || zoom === 1) return;
    const x = line.start * pxPerSecond;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 60) {
      el.scrollTo({ left: Math.max(0, x - 40), behavior: "smooth" });
    }
  }, [selectedId, zoom, pxPerSecond, lines]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${HEIGHT}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);

    const mid = HEIGHT / 2 + 8;
    const amp = HEIGHT / 2 - 14;

    // Line blocks under the waveform. A line with its own take does not use
    // this part of the recording, so it is drawn faint.
    lines.forEach((line, i) => {
      const x0 = line.start * pxPerSecond;
      const x1 = line.end * pxPerSecond;
      const selected = line.id === selectedId;
      const color = i % 2 === 0 ? "51, 175, 213" : "139, 185, 66";
      const faint = line.skip || line.take;
      ctx.fillStyle = `rgba(${color}, ${faint ? 0.05 : selected ? 0.28 : 0.13})`;
      ctx.fillRect(x0, 16, Math.max(1, x1 - x0), HEIGHT - 16);
      ctx.fillStyle = `rgba(${color}, ${selected ? 1 : 0.7})`;
      ctx.fillRect(x0, 16, 2, HEIGHT - 16);
      ctx.fillRect(x1 - 2, 16, 2, HEIGHT - 16);
      ctx.fillStyle = selected ? "#ffffff" : "rgba(215, 225, 242, 0.75)";
      ctx.font = "600 11px Inter, sans-serif";
      ctx.textBaseline = "top";
      const label = line.take && x1 - x0 > 48 ? `${i + 1} · take` : String(i + 1);
      if (x1 - x0 > 14) ctx.fillText(label, x0 + 4, 2);
    });

    // Waveform.
    ctx.fillStyle = "rgba(215, 225, 242, 0.55)";
    for (let x = 0; x < width; x++) {
      const hi = peaks.max[x] * amp;
      const lo = peaks.min[x] * amp;
      ctx.fillRect(x, mid - hi, 1, Math.max(1, hi - lo));
    }

    // Seconds ruler.
    ctx.fillStyle = "rgba(215, 225, 242, 0.35)";
    ctx.font = "10px Inter, sans-serif";
    ctx.textBaseline = "bottom";
    const step = pxPerSecond > 120 ? 1 : pxPerSecond > 40 ? 5 : pxPerSecond > 10 ? 10 : 30;
    for (let t = step; t < duration; t += step) {
      const x = t * pxPerSecond;
      ctx.fillRect(x, HEIGHT - 6, 1, 6);
      ctx.fillText(formatTime(t, 0), x + 3, HEIGHT - 1);
    }

    // Cut regions: struck out, so it is obvious they will not be heard.
    for (const cut of cuts ?? []) {
      const x0 = cut.start * pxPerSecond;
      const x1 = cut.end * pxPerSecond;
      const active = shownCut && cut.start === shownCut.start && cut.end === shownCut.end;
      ctx.fillStyle = `rgba(224, 49, 58, ${active ? 0.34 : 0.22})`;
      ctx.fillRect(x0, 16, Math.max(1, x1 - x0), HEIGHT - 16);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 16, Math.max(1, x1 - x0), HEIGHT - 16);
      ctx.clip();
      ctx.strokeStyle = "rgba(224, 49, 58, 0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0 - HEIGHT; x < x1; x += 7) {
        ctx.moveTo(x, HEIGHT);
        ctx.lineTo(x + HEIGHT - 16, 16);
      }
      ctx.stroke();
      ctx.restore();
      if (active) {
        ctx.strokeStyle = "rgba(255, 140, 140, 0.95)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 1, 17, Math.max(1, x1 - x0 - 2), HEIGHT - 18);
      }
    }

    // The part being selected for cutting.
    if (selection) {
      const x0 = selection.start * pxPerSecond;
      const x1 = selection.end * pxPerSecond;
      ctx.fillStyle = "rgba(253, 200, 47, 0.22)";
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), HEIGHT);
      ctx.fillStyle = "#FDC82F";
      ctx.fillRect(x0 - 1, 0, 2, HEIGHT);
      ctx.fillRect(x1 - 1, 0, 2, HEIGHT);
    }

    if (playhead !== null) {
      ctx.fillStyle = "#FDC82F";
      ctx.fillRect(playhead * pxPerSecond - 1, 0, 2, HEIGHT);
    }
  }, [peaks, lines, selectedId, playhead, width, pxPerSecond, duration, cuts, selection, shownCut]);

  const timeAt = (clientX: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - rect.left) / pxPerSecond));
  };

  const edgeAt = (clientX: number): { id: string; edge: "start" | "end" } | null => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = clientX - rect.left;
    let best: { id: string; edge: "start" | "end"; d: number } | null = null;
    for (const line of lines) {
      for (const edge of ["start", "end"] as const) {
        const d = Math.abs(line[edge] * pxPerSecond - x);
        if (d <= EDGE_GRAB_PX && (!best || d < best.d)) best = { id: line.id, edge, d };
      }
    }
    return best ? { id: best.id, edge: best.edge } : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const t = timeAt(e.clientX);
    if (canCut && (cutMode || e.shiftKey)) {
      dragRef.current = { kind: "select", anchor: t, x: e.clientX, moved: false };
      (e.target as Element).setPointerCapture(e.pointerId);
      scrollRef.current?.focus({ preventScroll: true });
      return;
    }
    const edge = edgeAt(e.clientX);
    if (edge) {
      dragRef.current = { kind: "edge", ...edge };
      onSelect(edge.id);
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (canCut) {
      setSelection(null);
      setActiveCut(cutAt(cuts ?? [], t) ?? null);
    }
    const line = lines.find((l) => t >= l.start && t <= l.end);
    if (line) {
      onSelect(line.id);
      onPlayLine(line);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) {
      setShiftHeld(e.shiftKey);
      setHoverEdge(!cutMode && !e.shiftKey && Boolean(edgeAt(e.clientX)));
      return;
    }
    if (drag.kind === "select") {
      if (!drag.moved && Math.abs(e.clientX - drag.x) < 4) return;
      drag.moved = true;
      const t = timeAt(e.clientX);
      setSelection({ start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) });
      setActiveCut(null);
      return;
    }
    const index = lines.findIndex((l) => l.id === drag.id);
    if (index < 0) return;
    const line = lines[index];
    const t = timeAt(e.clientX);
    const MIN = 0.15;
    if (drag.edge === "start") {
      const floor = index > 0 ? lines[index - 1].end : 0;
      onRetime(line.id, { start: Math.max(floor, Math.min(t, line.end - MIN)), end: line.end });
    } else {
      const ceiling = index < lines.length - 1 ? lines[index + 1].start : duration;
      onRetime(line.id, { start: line.start, end: Math.min(ceiling, Math.max(t, line.start + MIN)) });
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === "select") {
      if (!drag.moved) {
        // A click in Cut mode: pick a removed part to restore, or the line under it.
        const hit = cutAt(cuts ?? [], drag.anchor);
        setSelection(null);
        setActiveCut(hit ?? null);
        const line = lines.find((l) => drag.anchor >= l.start && drag.anchor <= l.end);
        if (!hit && line) onSelect(line.id);
      } else {
        setSelection((s) => (s && s.end - s.start >= MIN_SELECTION ? s : null));
      }
      return;
    }
    const line = lines.find((l) => l.id === drag.id);
    if (line) onPlayLine(line);
  };

  /* ---------- previews and edits ---------- */

  /** A stretch of the recording as its own buffer. */
  const bufferFor = (from: number, to: number): AudioBuffer => {
    const a = Math.max(0, Math.floor(from * sampleRate));
    const b = Math.min(mono.length, Math.ceil(to * sampleRate));
    const buffer = new AudioBuffer({ length: Math.max(1, b - a), numberOfChannels: 1, sampleRate });
    buffer.getChannelData(0).set(mono.subarray(a, b));
    return buffer;
  };

  const previewKey = (what: string) => `wave:${what}`;
  const isPreviewing = (what: string) =>
    playback ? playback.playing?.key === previewKey(what) : localPreview === previewKey(what);

  /**
   * "part": the stretch itself. "without": a moment either side of it, joined
   * the way the video joins a cut, so you hear whether the cut sounds natural.
   */
  const preview = (what: "part" | "without" | "cut", range: TimeRange) => {
    const key = previewKey(what);
    if (isPreviewing(what)) {
      if (playback) playback.stop();
      else stopPlayback();
      setLocalPreview(null);
      return;
    }
    let clip: AudioBuffer;
    let span: TimeRange;
    if (what === "without") {
      const from = Math.max(0, range.start - PREVIEW_CONTEXT);
      const to = Math.min(duration, range.end + PREVIEW_CONTEXT);
      const pieces = subtractRanges(from, to, [...(cuts ?? []), range]).map((p) => ({
        start: p.start - from,
        end: p.end - from,
      }));
      if (!pieces.length) return;
      clip = assemble(bufferFor(from, to), pieces, gain);
      span = { start: from, end: to };
    } else {
      const buffer = bufferFor(range.start, range.end);
      clip = assemble(buffer, [{ start: 0, end: buffer.duration }], gain);
      span = range;
    }
    if (playback) {
      void playback.play(key, clip, span);
    } else {
      setLocalPreview(key);
      void playRange(clip, 0, clip.duration, () => setLocalPreview((k) => (k === key ? null : k)));
    }
  };

  const removeSelection = () => {
    if (!selection || !onCutsChange) return;
    onCutsChange(addCut(cuts ?? [], selection));
    setSelection(null);
    playback?.stop();
  };

  const restore = (cut: TimeRange) => {
    if (!onCutsChange) return;
    onCutsChange(restoreCutAt(cuts ?? [], (cut.start + cut.end) / 2));
    setActiveCut(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setSelection(null);
      setActiveCut(null);
    } else if ((e.key === "Delete" || e.key === "Backspace") && selection) {
      e.preventDefault();
      removeSelection();
    }
  };

  const toggleCutMode = () => {
    setCutMode((on) => !on);
    setSelection(null);
    setActiveCut(null);
  };

  const cursor = canCut && (cutMode || shiftHeld) ? "crosshair" : hoverEdge || dragRef.current ? "ew-resize" : "pointer";
  const length = (r: TimeRange) => (r.end - r.start).toFixed(2);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-paper/55">
          {cutMode
            ? "Drag over a part to cut it out: a cough, a false start, a long silence. Click a removed part to restore it."
            : `Click a block to hear the line. Drag a block's edge to move where it starts or ends.${
                canCut ? " Shift-drag to select a part to cut." : ""
              }`}
        </p>
        <div className="flex items-center gap-1 shrink-0">
          {canCut && (
            <button
              type="button"
              className={`btn btn-ghost !py-1 !px-2.5 !text-xs mr-1 ${cutMode ? "!bg-kurd-red/25 !border-kurd-red/60 !text-white" : ""}`}
              title={cutMode ? "Leave Cut mode" : "Cut mode: select parts of the recording to leave out"}
              aria-pressed={cutMode}
              onClick={toggleCutMode}
            >
              <Scissors size={14} /> Cut
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Zoom out"
            disabled={zoom === ZOOMS[0]}
            onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)])}
          >
            <ZoomOut size={16} />
          </button>
          <span className="text-xs text-paper/60 w-8 text-center">{zoom}×</span>
          <button
            type="button"
            className="icon-btn"
            title="Zoom in"
            disabled={zoom === ZOOMS[ZOOMS.length - 1]}
            onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)])}
          >
            <ZoomIn size={16} />
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`overflow-x-auto rounded-xl bg-black/30 border outline-none ${
          cutMode ? "border-kurd-red/40" : "border-white/10"
        }`}
      >
        <canvas
          ref={canvasRef}
          className="block touch-none"
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHoverEdge(false)}
        />
      </div>

      {canCut && selection && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-kurd-sun/40 bg-kurd-sun/10 px-3 py-2 text-xs">
          <span className="text-paper/85">
            Selected <span className="font-mono tabular-nums">{formatTime(selection.start, 2)}</span> –{" "}
            <span className="font-mono tabular-nums">{formatTime(selection.end, 2)}</span>{" "}
            <span className="text-paper/50">({length(selection)}s)</span>
          </span>
          <span className="flex flex-wrap gap-1.5 ml-auto">
            <PreviewButton label="Play it" playing={isPreviewing("part")} onClick={() => preview("part", selection)} />
            <PreviewButton label="Hear without it" playing={isPreviewing("without")} onClick={() => preview("without", selection)} />
            <button type="button" className="btn btn-danger !py-1 !px-2.5 !text-xs" onClick={removeSelection} title="Delete key also works">
              <Scissors size={12} /> Remove this part
            </button>
            <button type="button" className="icon-btn !w-7 !h-7" title="Clear the selection (Esc)" onClick={() => setSelection(null)}>
              <X size={14} />
            </button>
          </span>
        </div>
      )}

      {canCut && shownCut && !selection && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-kurd-red/40 bg-kurd-red/10 px-3 py-2 text-xs">
          <span className="text-paper/85">
            Removed <span className="font-mono tabular-nums">{formatTime(shownCut.start, 2)}</span> –{" "}
            <span className="font-mono tabular-nums">{formatTime(shownCut.end, 2)}</span>{" "}
            <span className="text-paper/50">({length(shownCut)}s, not heard in the video)</span>
          </span>
          <span className="flex flex-wrap gap-1.5 ml-auto">
            <PreviewButton label="Play it" playing={isPreviewing("cut")} onClick={() => preview("cut", shownCut)} />
            <button type="button" className="btn btn-ghost !py-1 !px-2.5 !text-xs" onClick={() => restore(shownCut)}>
              <RotateCcw size={12} /> Restore
            </button>
            <button type="button" className="icon-btn !w-7 !h-7" title="Close" onClick={() => setActiveCut(null)}>
              <X size={14} />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function PreviewButton({ label, playing, onClick }: { label: string; playing: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`btn btn-ghost !py-1 !px-2.5 !text-xs ${playing ? "!bg-brand-blue/30 !text-white" : ""}`}
      onClick={onClick}
    >
      {playing ? <Square size={11} fill="currentColor" /> : <Play size={12} />} {label}
    </button>
  );
}
