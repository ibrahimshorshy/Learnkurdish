/** Small form controls shared by every step. */

import { useState } from "react";
import { Check, Copy, Download, Trash2 } from "lucide-react";
import type { RenderedVideo } from "../types";
import { findAudienceLanguage } from "../config/languages";
import { formatBytes } from "../utils/projectStore";
import { formatTime } from "../audio/audioTools";
import { useObjectUrl } from "../utils/useObjectUrl";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

export function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex rounded-lg bg-black/30 border border-white/10 p-0.5">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`flex-1 px-2 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
            value === id ? "bg-brand-blue/30 text-white" : "text-paper/55 hover:text-white"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-[#33afd5]"
      />
      <span className="text-sm font-mono w-12 text-right">
        {value.toFixed(step < 0.1 ? 2 : 1)}
        {suffix}
      </span>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 accent-[#8bb942]"
      />
      <span className="text-paper/85">{children}</span>
    </label>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 whitespace-pre-wrap">
      {children}
    </p>
  );
}

export function languagesLabel(languages: string[]): string {
  return languages.map((id) => findAudienceLanguage(id)?.label ?? id).join(" + ");
}

/** A finished video: player, download, copy caption, delete. */
export function VideoCard({
  video,
  stale,
  caption,
  onDownload,
  onDelete,
}: {
  video: RenderedVideo;
  stale: boolean;
  caption: string;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const url = useObjectUrl(video.blob);
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-xl border border-white/10 bg-black/25 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-sm">{languagesLabel(video.languages)}</span>
        <span className="text-xs text-paper/50">
          {formatTime(video.durationSeconds, 0)} · {formatBytes(video.blob.size)}
        </span>
      </div>
      {url && <video src={url} controls playsInline className="w-full rounded-lg aspect-[9/16] bg-black" />}
      {stale && <p className="text-xs text-kurd-sun">Made before your latest edits — make it again to include them.</p>}
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary flex-1" onClick={onDownload}>
          <Download size={15} /> MP4
        </button>
        {caption && (
          <button
            type="button"
            className="btn btn-ghost"
            title="Copy the post caption"
            onClick={() => {
              void navigator.clipboard.writeText(caption);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        )}
        <button
          type="button"
          className="btn btn-danger"
          title="Delete this video"
          onClick={() => window.confirm("Delete this video?") && onDelete()}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}
