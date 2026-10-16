import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings, Library, Mic2, Plus, Check, X, Loader2, Film, MessagesSquare, BookOpen } from "lucide-react";
import type { Project, ProjectKind, StepId } from "./types";
import { KINDS, stepsFor } from "./types";
import { createProject, getProject, projectLabel, saveProject } from "./utils/projectStore";
import { createProjectWriter, inOrder, recordingSignature, type Patch } from "./utils/projectWrites";
import { confirmLeave, workInProgress } from "./utils/leaveGuard";
import { LAST_PROJECT_KEY, loadSettings, saveSettings, type AppSettings } from "./utils/settings";
import { getHealth, type Health } from "./utils/api";
import { useLessonAudio, usePlayback } from "./audio/useRecordingAudio";
import { transcribeRecording, translateLines } from "./lessonActions";
import RecordStep from "./components/RecordStep";
import StorySourceStep from "./components/StorySourceStep";
import VideoSourceStep from "./components/VideoSourceStep";
import TranscriptStep from "./components/TranscriptStep";
import TranslateStep from "./components/TranslateStep";
import OutputStep from "./components/OutputStep";
import SubtitleOutputStep from "./components/SubtitleOutputStep";
import LibraryTab from "./components/LibraryTab";
import SettingsPanel from "./components/SettingsPanel";

type Tab = ProjectKind | "library";

/** An AI step running for one project. */
interface Job {
  what: "transcribe" | "translate";
  /** The one line being re-translated, if that is all it is. */
  lineId: string | null;
}

/**
 * What a write that moves the open project to another step does about work in
 * progress on the screen it would take away (a recording, a render): "ask"
 * first, "stay" on this step (for results that land on their own), or "go"
 * (already asked).
 */
type StepChange = "ask" | "stay" | "go";

const KIND_ICONS: Record<ProjectKind, React.ReactNode> = {
  lesson: <Mic2 size={16} />,
  video: <Film size={16} />,
  dialogue: <MessagesSquare size={16} />,
  story: <BookOpen size={16} />,
};

const lastKey = (kind: ProjectKind) => `${LAST_PROJECT_KEY}:${kind}`;
const LAST_TAB_KEY = "leen-kurdish-last-tab";

/** Whether a project has anything worth keeping yet. */
function hasContent(p: Project): boolean {
  return Boolean(p.recording || p.lines.length || p.sourceVideo || p.storyText?.trim() || p.script?.length);
}

/**
 * 1.0 remembered one project, with no kind; it was a lesson. Moved once to
 * the lesson's own key, so that after "New lesson" or deleting the lesson the
 * old one does not come back in its place.
 */
function migrateLastProject(): void {
  try {
    const legacy = localStorage.getItem(LAST_PROJECT_KEY);
    if (legacy === null) return;
    if (localStorage.getItem(lastKey("lesson")) === null) localStorage.setItem(lastKey("lesson"), legacy);
    localStorage.removeItem(LAST_PROJECT_KEY);
  } catch {
    // Blocked storage: there is nothing to remember either way.
  }
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [health, setHealth] = useState<Health | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    migrateLastProject();
    const saved = localStorage.getItem(LAST_TAB_KEY) as Tab | null;
    return saved && (saved === "library" || KINDS.some((k) => k.id === saved)) ? saved : "lesson";
  });
  const [showSettings, setShowSettings] = useState(false);
  const [project, setProjectState] = useState<Project | null>(null);
  /** AI steps running, by project: each project shows only its own. */
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  /** The error shown, and the project it is about (null: not about one). */
  const [error, setError] = useState<{ projectId: string | null; message: string } | null>(null);

  const playback = usePlayback();

  /* ---------- settings and server status ---------- */

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => {
    void getHealth().then(setHealth);
  }, [showSettings]);
  useEffect(() => {
    localStorage.setItem(LAST_TAB_KEY, tab);
  }, [tab]);

  /* ---------- the open project, one per kind ---------- */

  // Set the moment another project is opened, not on the next render, so
  // work that finishes in between already sees which project is open.
  const projectRef = useRef<Project | null>(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const saveTimer = useRef<number | null>(null);
  /** Bumped by every choice of project, so a slower load cannot overrule a newer choice. */
  const loadSeq = useRef(0);

  const cancelAutosave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
  }, []);

  /** Saves the open project now, rather than after the autosave pause. */
  const flushSave = useCallback(() => {
    cancelAutosave();
    const p = projectRef.current;
    if (p && hasContent(p)) void saveProject(p).catch(() => {});
  }, [cancelAutosave]);

  /**
   * Makes `next` the open project. The one it replaces is saved first, unless
   * it is being deleted. An error stays only if it is about `next`.
   */
  const showProject = useCallback(
    (next: Project | null, savePrevious = true) => {
      const prev = projectRef.current;
      if (prev && prev.id !== next?.id) {
        if (savePrevious) flushSave();
        else cancelAutosave();
      }
      projectRef.current = next;
      setProjectState(next);
      setError((e) => (e?.projectId && e.projectId === next?.id ? e : null));
    },
    [flushSave, cancelAutosave]
  );

  // Results that land after an await go into the project they were started
  // for: in memory if it is still open, else into its saved copy.
  const writer = useMemo(
    () =>
      createProjectWriter({
        current: () => projectRef.current,
        commit: (next) => {
          projectRef.current = next;
          setProjectState(next);
        },
        load: getProject,
        save: saveProject,
      }),
    []
  );

  /** Writes into project `projectId`, open or not. See StepChange for `stepChange`. */
  const writeProject = useCallback(
    (projectId: string, patch: Patch, stepChange: StepChange = "ask") =>
      writer(projectId, (p) => {
        const changes = typeof patch === "function" ? patch(p) : patch;
        const leaves = changes.step !== undefined && changes.step !== p.step && projectRef.current?.id === p.id;
        if (leaves && stepChange !== "go" && workInProgress().length && (stepChange === "stay" || !confirmLeave())) {
          const { step: _step, ...rest } = changes;
          return rest;
        }
        return changes;
      }).catch((err) => {
        setError({ projectId, message: `Could not save to this browser: ${err?.message || err}` });
        return null;
      }),
    [writer]
  );

  // What the steps get as `update`: bound to the project they show, so a step
  // that awaits something (an upload, a recording, a voice, a render) writes
  // into the project it was working on even if another is open by then. The
  // studio below is keyed by the project, so no step outlives its project.
  const openId = project?.id ?? null;
  const update = useMemo(
    () => (patch: Patch) => {
      if (openId) void writeProject(openId, patch);
    },
    [openId, writeProject]
  );

  /** Opens the last project of `kind`, or a fresh one. */
  const loadKind = useCallback(
    (kind: ProjectKind) => {
      const seq = ++loadSeq.current;
      // Queued behind any result still being written into a closed project.
      void inOrder(async () => {
        const lastId = localStorage.getItem(lastKey(kind));
        const found = lastId ? await getProject(lastId).catch(() => null) : null;
        // Another tab or project was chosen while this one loaded.
        if (seq !== loadSeq.current || tabRef.current !== kind) return;
        showProject(found && found.kind === kind ? found : createProject(kind, loadSettings().audiences));
      });
    },
    [showProject]
  );

  useEffect(() => {
    const kind = tab === "library" ? null : tab;
    if (!kind) return;
    if (projectRef.current?.kind === kind) {
      // Back on the open project's tab: a load still running for another tab is void.
      loadSeq.current++;
      return;
    }
    playback.stop();
    loadKind(kind);
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleaned-up audio is stored in the project it was made for, so it survives
  // a reload and a video made before cleaning finished is flagged as old.
  const audio = useLessonAudio(project, writeProject);

  // Autosave, a moment after the last change. A project with nothing in it yet
  // is not saved, so opening a section does not litter the library.
  useEffect(() => {
    cancelAutosave();
    if (!project || !hasContent(project)) return;
    localStorage.setItem(lastKey(project.kind), project.id);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      saveProject(project).catch((err) =>
        setError({ projectId: project.id, message: `Could not save to this browser: ${err?.message || err}` })
      );
    }, 400);
  }, [project, cancelAutosave]);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      flushSave();
      // A recording, render or upload in progress would be lost: the browser asks.
      if (workInProgress().length) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [flushSave]);

  const chooseTab = (next: Tab) => {
    if (next === tab) {
      // Only if a load went missing: the tab's project is not the open one.
      if (next !== "library" && projectRef.current?.kind !== next && confirmLeave()) loadKind(next);
      return;
    }
    if (!confirmLeave()) return;
    // The Library lists what is saved, so the open project is saved first.
    if (next === "library") flushSave();
    setTab(next);
  };

  const newProject = () => {
    if (!confirmLeave()) return;
    const current = projectRef.current;
    const kind = tab === "library" ? current?.kind ?? "lesson" : tab;
    loadSeq.current++;
    playback.stop();
    showProject(createProject(kind, settings.audiences, current?.kind === kind ? current.video : undefined));
    localStorage.removeItem(lastKey(kind));
    setTab(kind);
  };

  const openProject = (p: Project) => {
    // Already open: the copy in memory is newer than the list's, which was
    // read when the Library opened.
    if (p.id === projectRef.current?.id) {
      setTab(p.kind);
      return;
    }
    if (!confirmLeave()) return;
    const seq = ++loadSeq.current;
    void inOrder(async () => {
      // Read again: a result that landed in it since the list was read is in the saved copy.
      const fresh = await getProject(p.id).catch(() => p);
      if (seq !== loadSeq.current || !fresh) return;
      playback.stop();
      showProject(fresh);
      localStorage.setItem(lastKey(fresh.kind), fresh.id);
      setTab(fresh.kind);
    });
  };

  /* ---------- AI steps ---------- */

  const startJob = (projectId: string, job: Job) => {
    setJobs((all) => ({ ...all, [projectId]: job }));
    setError((e) => (!e || !e.projectId || e.projectId === projectId ? null : e));
  };
  const endJob = (projectId: string) =>
    setJobs((all) => {
      const { [projectId]: _done, ...rest } = all;
      return rest;
    });
  const failJob = (projectId: string, err: unknown) =>
    setError({ projectId, message: err instanceof Error ? err.message : String(err) });

  const runTranscribe = async () => {
    const source = audio.sources.main ?? audio.raw;
    if (!project || !source || jobs[project.id]) return;
    const started = project;
    const projectId = started.id;
    // Which recording was heard. If it is replaced before the answer comes,
    // the answer's lines and times belong to audio that is gone.
    const heard = recordingSignature(started.recording);
    startJob(projectId, { what: "transcribe", lineId: null });
    try {
      const apply = await transcribeRecording(started, source, settings);
      let replaced = false;
      await writeProject(
        projectId,
        (p) => {
          if (recordingSignature(p.recording) !== heard) {
            replaced = true;
            return {};
          }
          return apply(p);
        },
        "stay"
      );
      if (replaced) {
        failJob(
          projectId,
          "The recording was replaced while the old one was being transcribed, so those lines were not used. Transcribe the new one."
        );
      }
    } catch (err) {
      failJob(projectId, err);
    } finally {
      endJob(projectId);
    }
  };

  const runTranslate = async (ids?: string[], instruction?: string) => {
    if (!project || jobs[project.id]) return;
    const started = project;
    const projectId = started.id;
    startJob(projectId, { what: "translate", lineId: ids?.length === 1 ? ids[0] : null });
    try {
      const apply = await translateLines(started, settings, { onlyIds: ids, instruction });
      await writeProject(projectId, (p) => ({ ...apply(p), ...(ids ? {} : { step: "translate" as StepId }) }), "stay");
    } catch (err) {
      failJob(projectId, err);
    } finally {
      endJob(projectId);
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

  // Never sit on a step whose inputs are gone.
  const step: StepId = project && reachable(project.step) ? project.step : "record";

  const goTo = (target: StepId) => {
    if (!project || !reachable(target)) return;
    // Another step unmounts this one, and whatever it is recording or rendering.
    if (target !== step && !confirmLeave()) return;
    playback.stop();
    if (target !== project.step) void writeProject(project.id, { step: target }, "go");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const job = project ? jobs[project.id] : undefined;
  const shownError = error && (!error.projectId || error.projectId === project?.id) ? error.message : null;
  const steps = stepsFor(project?.kind ?? "lesson");
  const stepIndex = steps.findIndex((s) => s.id === step);
  const logoSrc = settings.logoDataUrl || "/logo.png";
  const showStudio = tab !== "library" && project?.kind === tab;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#03101f]/85 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center gap-3">
          <img src="/logo.svg" alt="Leen" className="h-8 w-auto" />
          <div className="leading-tight hidden md:block">
            <div className="font-bold">Kurdish Studio</div>
            <div className="text-[11px] text-paper/55">
              <span className="script">سۆرانی</span> → Arabic · English
            </div>
          </div>
          <nav className="ml-auto flex items-center gap-1 overflow-x-auto">
            {KINDS.map((k) => (
              <TabButton key={k.id} active={tab === k.id} onClick={() => chooseTab(k.id)} title={k.blurb}>
                {KIND_ICONS[k.id]} <span className="hidden sm:inline">{k.label}</span>
              </TabButton>
            ))}
            <span className="w-px h-6 bg-white/10 mx-1" />
            <TabButton active={tab === "library"} onClick={() => chooseTab("library")} title="Every project you made">
              <Library size={16} /> <span className="hidden sm:inline">Library</span>
            </TabButton>
            <button
              type="button"
              className="icon-btn !w-10 !h-10 ml-1 relative shrink-0"
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
            onNew={newProject}
            onDeletingCurrent={() => {
              const current = projectRef.current;
              if (!current) return;
              loadSeq.current++;
              localStorage.removeItem(lastKey(current.kind));
              // Not saved on the way out: it is being deleted, and must not come back.
              showProject(createProject(current.kind, settings.audiences), false);
            }}
          />
        ) : !showStudio || !project ? (
          <div className="flex justify-center py-20 text-paper/60">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          // Keyed by the project: every step starts fresh with it, and work a
          // step had running belongs to the project it was started on.
          <Fragment key={project.id}>
            <div className="flex flex-wrap items-center gap-3">
              <input
                className="bg-transparent text-lg font-semibold outline-none border-b border-transparent focus:border-brand-blue min-w-0 flex-1"
                placeholder={projectLabel(project)}
                value={project.name}
                onChange={(e) => update({ name: e.target.value })}
                aria-label="Project name"
              />
              {project.usage.costUsd > 0 && (
                <span className="text-xs text-paper/45" title="Estimated from list prices">
                  AI cost so far ≈ ${project.usage.costUsd.toFixed(4)}
                </span>
              )}
              <button type="button" className="btn btn-ghost" onClick={newProject}>
                <Plus size={15} /> New {KINDS.find((k) => k.id === project.kind)?.label.toLowerCase()}
              </button>
            </div>

            <ol className="grid grid-cols-4 gap-2">
              {steps.map((s, i) => {
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

            {shownError && (
              <div className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                <span className="flex-1 whitespace-pre-wrap">{shownError}</span>
                <button type="button" className="icon-btn !w-6 !h-6" onClick={() => setError(null)}>
                  <X size={14} />
                </button>
              </div>
            )}

            {step === "record" &&
              (project.kind === "video" ? (
                <VideoSourceStep
                  project={project}
                  settings={settings}
                  audio={audio}
                  busy={job?.what === "transcribe"}
                  update={update}
                  onTranscribe={runTranscribe}
                />
              ) : project.kind === "story" ? (
                <StorySourceStep
                  project={project}
                  settings={settings}
                  audio={audio.raw}
                  audioError={audio.error}
                  busy={job?.what === "transcribe"}
                  update={update}
                  onTranscribe={runTranscribe}
                />
              ) : (
                <RecordStep
                  project={project}
                  settings={settings}
                  audio={audio.raw}
                  audioError={audio.error}
                  busy={job?.what === "transcribe"}
                  update={update}
                  onTranscribe={runTranscribe}
                />
              ))}
            {step === "transcript" && (
              <TranscriptStep
                project={project}
                audio={audio}
                playback={playback}
                settings={settings}
                enabledAudiences={settings.audiences}
                busy={Boolean(job)}
                update={update}
                onTranslate={() => runTranslate()}
              />
            )}
            {step === "translate" && (
              <TranslateStep
                project={project}
                audio={audio}
                playback={playback}
                settings={settings}
                busy={Boolean(job)}
                busyLineId={job?.lineId ?? null}
                update={update}
                onTranslateAll={() => runTranslate()}
                onTranslateLines={(ids, instruction) => runTranslate(ids, instruction)}
                onApprove={() => {
                  update({ approvedAt: Date.now(), step: "video" });
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
            )}
            {step === "video" &&
              (project.kind === "video" ? (
                <SubtitleOutputStep
                  project={project}
                  sources={audio.sources}
                  processing={audio.processing.state === "processing"}
                  settings={settings}
                  ffmpeg={health?.ffmpeg ?? null}
                  logoSrc={logoSrc}
                  update={update}
                />
              ) : (
                <OutputStep
                  project={project}
                  sources={audio.sources}
                  processing={audio.processing.state === "processing"}
                  settings={settings}
                  ffmpeg={health?.ffmpeg ?? null}
                  logoSrc={logoSrc}
                  update={update}
                />
              ))}
          </Fragment>
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
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-colors shrink-0 ${
        active ? "bg-white/10 text-white" : "text-paper/60 hover:text-white hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}
