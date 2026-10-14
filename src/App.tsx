import { useCallback, useEffect, useRef, useState } from "react";
import { Settings, Library, Mic2, Plus, Check, X, Loader2 } from "lucide-react";
import type { Project, StepId } from "./types";
import { STEPS } from "./types";
import { createProject, getProject, projectLabel, saveProject } from "./utils/projectStore";
import { LAST_PROJECT_KEY, loadSettings, saveSettings, type AppSettings } from "./utils/settings";
import { getHealth, type Health } from "./utils/api";
import { useRecordingAudio, usePlayback } from "./audio/useRecordingAudio";
import { transcribeRecording, translateLines } from "./lessonActions";
import RecordStep from "./components/RecordStep";
import TranscriptStep from "./components/TranscriptStep";
import TranslateStep from "./components/TranslateStep";
import VideoStep from "./components/VideoStep";
import LibraryTab from "./components/LibraryTab";
import SettingsPanel from "./components/SettingsPanel";

type Patch = Partial<Project> | ((p: Project) => Partial<Project>);

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [health, setHealth] = useState<Health | null>(null);
  const [tab, setTab] = useState<"studio" | "library">("studio");
  const [showSettings, setShowSettings] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [busy, setBusy] = useState<null | "transcribe" | "translate">(null);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { audio, error: audioError } = useRecordingAudio(project?.recording);
  const playback = usePlayback(audio);

  /* ---------- settings and server status ---------- */

  useEffect(() => saveSettings(settings), [settings]);

  useEffect(() => {
    void getHealth().then(setHealth);
  }, [showSettings]);

  /* ---------- the open project ---------- */

  useEffect(() => {
    const lastId = localStorage.getItem(LAST_PROJECT_KEY);
    (lastId ? getProject(lastId) : Promise.resolve(null))
      .catch(() => null)
      .then((found) => setProject(found ?? createProject(loadSettings().audiences)));
  }, []);

  const update = useCallback((patch: Patch) => {
    setProject((p) => (p ? { ...p, ...(typeof patch === "function" ? patch(p) : patch), updatedAt: Date.now() } : p));
  }, []);

  // Autosave, a moment after the last change. A project with nothing in it yet
  // is not saved, so opening the app does not litter the library.
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!project) return;
    if (!project.recording && !project.lines.length) return;
    localStorage.setItem(LAST_PROJECT_KEY, project.id);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveProject(project).catch((err) => setError(`Could not save to this browser: ${err?.message || err}`));
    }, 400);
  }, [project]);

  const newLesson = () => {
    playback.stop();
    setProject(createProject(settings.audiences, project?.video));
    localStorage.removeItem(LAST_PROJECT_KEY);
    setTab("studio");
    setError(null);
  };

  const openProject = (p: Project) => {
    playback.stop();
    setProject(p);
    localStorage.setItem(LAST_PROJECT_KEY, p.id);
    setTab("studio");
    setError(null);
  };

  /* ---------- AI steps ---------- */

  const runTranscribe = async () => {
    if (!project || !audio) return;
    setBusy("transcribe");
    setError(null);
    try {
      update(await transcribeRecording(project, audio, settings));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const runTranslate = async (ids?: string[], instruction?: string) => {
    if (!project) return;
    setBusy("translate");
    setBusyLineId(ids?.length === 1 ? ids[0] : null);
    setError(null);
    try {
      const apply = await translateLines(project, settings, { onlyIds: ids, instruction });
      update((p) => ({ ...apply(p), ...(ids ? {} : { step: "translate" as StepId }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setBusyLineId(null);
    }
  };

  /* ---------- steps ---------- */

  const reachable = (id: StepId): boolean => {
    if (!project) return false;
    switch (id) {
      case "record":
        return true;
      case "transcript":
        return Boolean(project.recording);
      case "translate":
        return project.lines.some((l) => l.kurdish.trim());
      case "video":
        return project.lines.some((l) => Object.values(l.translations).some((t) => t?.trim()));
    }
  };

  const goTo = (step: StepId) => {
    if (!reachable(step)) return;
    playback.stop();
    update({ step });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Never sit on a step whose inputs are gone.
  const step: StepId = project && reachable(project.step) ? project.step : "record";
  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const logoSrc = settings.logoDataUrl || "/logo.png";

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#03101f]/85 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center gap-4">
          <img src="/logo.svg" alt="Leen" className="h-8 w-auto" />
          <div className="leading-tight">
            <div className="font-bold">Kurdish Studio</div>
            <div className="text-[11px] text-paper/55">
              <span className="script">سۆرانی</span> → Arabic · English
            </div>
          </div>
          <nav className="ml-auto flex items-center gap-1">
            <TabButton active={tab === "studio"} onClick={() => setTab("studio")}>
              <Mic2 size={16} /> Studio
            </TabButton>
            <TabButton active={tab === "library"} onClick={() => setTab("library")}>
              <Library size={16} /> Library
            </TabButton>
            <button
              type="button"
              className="icon-btn !w-10 !h-10 ml-1 relative"
              title="Settings"
              onClick={() => setShowSettings(true)}
            >
              <Settings size={19} />
              {health && (!health.ffmpeg || !(health.serverKey || settings.apiKey.trim())) && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-kurd-red" />
              )}
            </button>
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-5">
        {tab === "library" ? (
          <LibraryTab
            currentId={project?.id ?? null}
            onOpen={openProject}
            onNew={newLesson}
            onDeletedCurrent={newLesson}
          />
        ) : !project ? (
          <div className="flex justify-center py-20 text-paper/60">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <input
                className="bg-transparent text-lg font-semibold outline-none border-b border-transparent focus:border-brand-blue min-w-0 flex-1"
                placeholder={projectLabel(project)}
                value={project.name}
                onChange={(e) => update({ name: e.target.value })}
                aria-label="Lesson name"
              />
              {project.usage.costUsd > 0 && (
                <span className="text-xs text-paper/45" title="Estimated from list prices">
                  AI cost so far ≈ ${project.usage.costUsd.toFixed(4)}
                </span>
              )}
              <button type="button" className="btn btn-ghost" onClick={newLesson}>
                <Plus size={15} /> New lesson
              </button>
            </div>

            <ol className="grid grid-cols-4 gap-2">
              {STEPS.map((s, i) => {
                const active = s.id === step;
                const done = i < stepIndex;
                const enabled = reachable(s.id);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => goTo(s.id)}
                      disabled={!enabled}
                      className={`w-full text-left rounded-xl px-3 py-2.5 border transition-colors ${
                        active
                          ? "border-brand-blue bg-brand-blue/15"
                          : enabled
                            ? "border-white/10 hover:bg-white/5 cursor-pointer"
                            : "border-white/5 opacity-40 cursor-not-allowed"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                            active ? "bg-brand-blue text-white" : done ? "bg-brand-green/80 text-white" : "bg-white/10"
                          }`}
                        >
                          {done ? <Check size={13} /> : i + 1}
                        </span>
                        <span className="font-semibold text-sm truncate">{s.label}</span>
                      </div>
                      <div className="hidden sm:block text-[11px] text-paper/50 mt-0.5 pl-8 truncate">{s.hint}</div>
                    </button>
                  </li>
                );
              })}
            </ol>

            {error && (
              <div className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                <span className="flex-1 whitespace-pre-wrap">{error}</span>
                <button type="button" className="icon-btn !w-6 !h-6" onClick={() => setError(null)}>
                  <X size={14} />
                </button>
              </div>
            )}

            {step === "record" && (
              <RecordStep
                project={project}
                settings={settings}
                audio={audio}
                audioError={audioError}
                busy={busy === "transcribe"}
                update={update}
                onTranscribe={runTranscribe}
              />
            )}
            {step === "transcript" && (
              <TranscriptStep
                project={project}
                audio={audio}
                playback={playback}
                enabledAudiences={settings.audiences}
                busy={busy !== null}
                update={update}
                onTranslate={() => runTranslate()}
              />
            )}
            {step === "translate" && (
              <TranslateStep
                project={project}
                audio={audio}
                playback={playback}
                busy={busy !== null}
                busyLineId={busyLineId}
                update={update}
                onTranslateAll={() => runTranslate()}
                onTranslateLines={(ids, instruction) => runTranslate(ids, instruction)}
                onApprove={() => {
                  update({ approvedAt: Date.now(), step: "video" });
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
            )}
            {step === "video" && (
              <VideoStep project={project} audio={audio} ffmpeg={health?.ffmpeg ?? null} logoSrc={logoSrc} update={update} />
            )}
          </>
        )}
      </main>

      {showSettings && (
        <SettingsPanel settings={settings} health={health} onChange={setSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-colors ${
        active ? "bg-white/10 text-white" : "text-paper/60 hover:text-white hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}
