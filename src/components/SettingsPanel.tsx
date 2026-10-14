import { useRef, useState } from "react";
import { X, Eye, EyeOff, Upload, RotateCcw, CheckCircle2, XCircle } from "lucide-react";
import type { AppSettings } from "../utils/settings";
import type { Health } from "../utils/api";
import { TEXT_MODELS } from "../config/models";
import { AUDIENCE_LANGUAGES } from "../config/languages";

interface Props {
  settings: AppSettings;
  health: Health | null;
  onChange: (settings: AppSettings) => void;
  onClose: () => void;
}

export default function SettingsPanel({ settings, health, onChange, onClose }: Props) {
  const [showKey, setShowKey] = useState(false);
  const logoRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<AppSettings>) => onChange({ ...settings, ...patch });

  const toggleAudience = (id: string) => {
    const has = settings.audiences.includes(id);
    const next = has ? settings.audiences.filter((a) => a !== id) : [...settings.audiences, id];
    if (next.length) set({ audiences: AUDIENCE_LANGUAGES.map((a) => a.id).filter((a) => next.includes(a)) });
  };

  const onLogo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => set({ logoDataUrl: String(reader.result || "") });
    reader.readAsDataURL(file);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end" onClick={onClose}>
      <div
        className="w-full max-w-md h-full overflow-y-auto bg-ink border-l border-white/10 p-6 space-y-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <section className="space-y-2">
          <span className="label">Status</span>
          <StatusRow ok={Boolean(health)} text={health ? `Server running · v${health.version}` : "Server not reachable"} />
          <StatusRow
            ok={Boolean(health?.ffmpeg)}
            text={health?.ffmpeg ? "ffmpeg found — MP4 export works" : "ffmpeg missing — videos cannot be exported"}
          />
          <StatusRow
            ok={Boolean(health?.serverKey || settings.apiKey.trim())}
            text={
              settings.apiKey.trim()
                ? "Using the API key below"
                : health?.serverKey
                  ? "Using the API key from .env"
                  : "No API key yet — paste one below"
            }
          />
        </section>

        <section className="space-y-2">
          <label className="label" htmlFor="apikey">
            Gemini API key
          </label>
          <div className="flex gap-2">
            <input
              id="apikey"
              type={showKey ? "text" : "password"}
              className="field font-mono text-sm"
              placeholder={health?.serverKey ? "Using the key in .env" : "Paste your key"}
              value={settings.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
              autoComplete="off"
            />
            <button type="button" className="icon-btn !w-10 !h-10" onClick={() => setShowKey((v) => !v)}>
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="text-xs text-paper/45">
            Free at{" "}
            <a className="underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              aistudio.google.com/apikey
            </a>
            . Stored in this browser only; overrides the key in .env.
          </p>
        </section>

        <section className="space-y-3">
          <ModelSelect
            label="Model that listens (transcription)"
            value={settings.transcribeModel}
            onChange={(id) => set({ transcribeModel: id })}
          />
          <ModelSelect
            label="Model that translates"
            value={settings.translateModel}
            onChange={(id) => set({ translateModel: id })}
          />
          <p className="text-xs text-paper/45">
            If a model is busy or retired, the next one in line is used automatically.
          </p>
        </section>

        <section className="space-y-2">
          <span className="label">Translate new lessons into</span>
          <div className="space-y-1.5">
            {AUDIENCE_LANGUAGES.map((a) => (
              <label key={a.id} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-[#8bb942]"
                  checked={settings.audiences.includes(a.id)}
                  onChange={() => toggleAudience(a.id)}
                />
                <span>{a.label}</span>
                <span className="script text-paper/55">{a.nativeLabel}</span>
                {!a.enabledByDefault && <span className="text-[10px] text-kurd-sun uppercase font-bold">extra</span>}
              </label>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <span className="label">Recording</span>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 mt-0.5 accent-[#8bb942]"
              checked={settings.noiseSuppression}
              onChange={(e) => set({ noiseSuppression: e.target.checked })}
            />
            <span className="text-sm">
              Reduce background noise
              <span className="block text-xs text-paper/45">
                Helps in a noisy room. Turn it off in a quiet room for a more natural voice.
              </span>
            </span>
          </label>
        </section>

        <section className="space-y-2">
          <span className="label">Logo on the videos</span>
          <div className="flex items-center gap-3">
            <div className="w-24 h-14 rounded-lg bg-black/40 border border-white/10 flex items-center justify-center p-1">
              <img src={settings.logoDataUrl || "/logo.png"} alt="" className="max-w-full max-h-full" />
            </div>
            <input ref={logoRef} type="file" accept="image/*" className="hidden" onChange={onLogo} />
            <button type="button" className="btn btn-ghost" onClick={() => logoRef.current?.click()}>
              <Upload size={14} /> Replace
            </button>
            {settings.logoDataUrl && (
              <button type="button" className="btn btn-ghost" onClick={() => set({ logoDataUrl: "" })}>
                <RotateCcw size={14} /> Default
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function StatusRow({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? <CheckCircle2 size={16} className="text-brand-green" /> : <XCircle size={16} className="text-red-400" />}
      <span className={ok ? "text-paper/80" : "text-red-200"}>{text}</span>
    </div>
  );
}

function ModelSelect({ label, value, onChange }: { label: string; value: string; onChange: (id: string) => void }) {
  const known = TEXT_MODELS.some((m) => m.id === value);
  return (
    <div className="space-y-1.5">
      <span className="label">{label}</span>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        {!known && <option value={value}>{value}</option>}
        {TEXT_MODELS.map((m) => (
          <option key={m.id} value={m.id} className="bg-ink">
            {m.label}
          </option>
        ))}
      </select>
      {TEXT_MODELS.find((m) => m.id === value) && (
        <p className="text-xs text-paper/45">{TEXT_MODELS.find((m) => m.id === value)!.blurb}</p>
      )}
    </div>
  );
}
