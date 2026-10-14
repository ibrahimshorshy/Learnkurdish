import { useEffect, useState } from "react";
import { FolderOpen, Trash2, Mic, Film, Plus, Loader2 } from "lucide-react";
import type { Project } from "../types";
import { KINDS, stepsFor } from "../types";
import { deleteProject, formatBytes, listProjects, projectLabel } from "../utils/projectStore";
import { formatTime } from "../audio/audioTools";

interface Props {
  currentId: string | null;
  onOpen: (project: Project) => void;
  onNew: () => void;
  /** Called after the current project is deleted. */
  onDeletedCurrent: () => void;
}

export default function LibraryTab({ currentId, onOpen, onNew, onDeletedCurrent }: Props) {
  const [projects, setProjects] = useState<Project[] | null>(null);

  const refresh = () => listProjects().then(setProjects).catch(() => setProjects([]));
  useEffect(() => {
    void refresh();
  }, []);

  const remove = async (project: Project) => {
    if (!window.confirm(`Delete “${projectLabel(project)}”? The recording and its videos are deleted too.`)) return;
    await deleteProject(project.id);
    if (project.id === currentId) onDeletedCurrent();
    void refresh();
  };

  if (!projects) {
    return (
      <div className="flex justify-center py-20 text-paper/60">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Your projects</h2>
          <p className="text-sm text-paper/55">
            Kept on this computer until you delete them — your recordings are not uploaded anywhere except to the AI
            for transcription.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onNew}>
          <Plus size={16} /> New
        </button>
      </div>

      {!projects.length && <div className="card p-10 text-center text-paper/60">No lessons yet.</div>}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {projects.map((project) => {
          const size =
            (project.recording?.blob.size ?? 0) + project.renders.reduce((sum, r) => sum + r.blob.size, 0);
          const step = stepsFor(project.kind).find((s) => s.id === project.step);
          const kind = KINDS.find((k) => k.id === project.kind);
          return (
            <div
              key={project.id}
              className={`card p-4 space-y-3 ${project.id === currentId ? "!border-brand-blue/60" : ""}`}
            >
              <div>
                <span className="text-[10px] uppercase font-bold tracking-wider text-brand-blue">{kind?.label}</span>
                <h3 className="font-semibold truncate" title={projectLabel(project)}>
                  {projectLabel(project)}
                </h3>
                {project.titles.ar && (
                  <p dir="rtl" className="script text-sm text-paper/60 truncate">
                    {project.titles.ar}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-paper/55">
                <span className="inline-flex items-center gap-1">
                  <Mic size={12} /> {project.recording ? formatTime(project.recording.durationSeconds, 0) : "—"}
                </span>
                <span>{project.lines.length} lines</span>
                <span className="inline-flex items-center gap-1">
                  <Film size={12} /> {project.renders.length}
                </span>
                <span>{formatBytes(size)}</span>
                {project.usage.costUsd > 0 && <span>≈ ${project.usage.costUsd.toFixed(3)}</span>}
              </div>
              <div className="text-xs text-paper/45">
                {step?.label} · edited {new Date(project.updatedAt).toLocaleString()}
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn btn-ghost flex-1" onClick={() => onOpen(project)}>
                  <FolderOpen size={15} /> Open
                </button>
                <button type="button" className="btn btn-danger" onClick={() => remove(project)} title="Delete">
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
