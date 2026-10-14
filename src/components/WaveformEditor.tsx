import { useEffect, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import type { LessonLine } from "../types";
import { waveformPeaks, formatTime } from "../audio/audioTools";

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
}

const HEIGHT = 132;
const EDGE_GRAB_PX = 7;
const ZOOMS = [1, 2, 4, 8, 16];

/**
 * The whole recording as a waveform, with each line drawn over it as a block.
 * Drag a block's edge to move where the line starts or ends; click a block to
 * select it and hear it.
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
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [hoverEdge, setHoverEdge] = useState(false);
  const dragRef = useRef<{ id: string; edge: "start" | "end" } | null>(null);

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

    // Line blocks under the waveform.
    lines.forEach((line, i) => {
      const x0 = line.start * pxPerSecond;
      const x1 = line.end * pxPerSecond;
      const selected = line.id === selectedId;
      const color = i % 2 === 0 ? "51, 175, 213" : "139, 185, 66";
      ctx.fillStyle = `rgba(${color}, ${line.skip ? 0.05 : selected ? 0.28 : 0.13})`;
      ctx.fillRect(x0, 16, Math.max(1, x1 - x0), HEIGHT - 16);
      ctx.fillStyle = `rgba(${color}, ${selected ? 1 : 0.7})`;
      ctx.fillRect(x0, 16, 2, HEIGHT - 16);
      ctx.fillRect(x1 - 2, 16, 2, HEIGHT - 16);
      ctx.fillStyle = selected ? "#ffffff" : "rgba(215, 225, 242, 0.75)";
      ctx.font = "600 11px Inter, sans-serif";
      ctx.textBaseline = "top";
      if (x1 - x0 > 14) ctx.fillText(String(i + 1), x0 + 4, 2);
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

    if (playhead !== null) {
      ctx.fillStyle = "#FDC82F";
      ctx.fillRect(playhead * pxPerSecond - 1, 0, 2, HEIGHT);
    }
  }, [peaks, lines, selectedId, playhead, width, pxPerSecond, duration]);

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
    const edge = edgeAt(e.clientX);
    if (edge) {
      dragRef.current = edge;
      onSelect(edge.id);
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    const t = timeAt(e.clientX);
    const line = lines.find((l) => t >= l.start && t <= l.end);
    if (line) {
      onSelect(line.id);
      onPlayLine(line);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) {
      setHoverEdge(Boolean(edgeAt(e.clientX)));
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
    if (drag) {
      const line = lines.find((l) => l.id === drag.id);
      if (line) onPlayLine(line);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-paper/55">
          Click a block to hear the line. Drag a block's edge to move where it starts or ends.
        </p>
        <div className="flex items-center gap-1 shrink-0">
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
      <div ref={scrollRef} className="overflow-x-auto rounded-xl bg-black/30 border border-white/10">
        <canvas
          ref={canvasRef}
          className="block touch-none"
          style={{ cursor: hoverEdge || dragRef.current ? "ew-resize" : "pointer" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHoverEdge(false)}
        />
      </div>
    </div>
  );
}
