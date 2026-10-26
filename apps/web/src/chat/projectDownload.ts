import { useEffect, useState } from "react";
import { projectArchiveDownloadUrl, projectArchiveStatus, startProjectArchive } from "../api.ts";
import { message, strip } from "../format.ts";

export interface DownloadJob {
  workspace: string;
  label: string;
  id: string;
  filename: string;
  phase: "creating" | "ready" | "failed";
  error?: string;
}

const listeners = new Set<() => void>();
let job: DownloadJob | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

export function getProjectDownload(): DownloadJob | null {
  return job;
}

export function subscribeProjectDownload(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProjectDownload(): DownloadJob | null {
  const [current, setCurrent] = useState(getProjectDownload);
  useEffect(() => subscribeProjectDownload(() => setCurrent(getProjectDownload())), []);
  return current;
}

export function clearProjectDownload() {
  job = null;
  stopPoll();
  emit();
}

export function saveProjectDownload(id: string, filename: string) {
  const link = document.createElement("a");
  link.href = projectArchiveDownloadUrl(id);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export async function startProjectDownload(workspace: string, label: string) {
  if (job?.phase === "creating" && strip(job.workspace) === strip(workspace)) return;
  job = { workspace, label, id: "", filename: "", phase: "creating" };
  emit();
  try {
    const started = await startProjectArchive(workspace);
    if (job?.workspace !== workspace || job.phase !== "creating") return;
    job = { workspace, label, id: started.id, filename: started.filename, phase: "creating" };
    emit();
    void tick();
    ensurePoll();
  } catch (error) {
    if (job?.workspace !== workspace) return;
    job = { workspace, label, id: "", filename: "", phase: "failed", error: message(error) };
    stopPoll();
    emit();
  }
}

function ensurePoll() {
  if (timer != null) return;
  timer = setInterval(() => void tick(), 1000);
}

function stopPoll() {
  if (timer == null) return;
  clearInterval(timer);
  timer = undefined;
}

async function tick() {
  const current = job;
  if (!current || current.phase !== "creating" || !current.id) return;
  try {
    const status = await projectArchiveStatus(current.id);
    if (job?.id !== current.id || job.phase !== "creating") return;
    if (status.status === "ready") {
      job = { ...current, filename: status.filename || current.filename, phase: "ready" };
      stopPoll();
      emit();
    } else if (status.status === "failed") {
      job = { ...current, phase: "failed", error: status.error || "could not create the zip" };
      stopPoll();
      emit();
    }
  } catch (error) {
    if (job?.id !== current.id) return;
    job = { ...current, phase: "failed", error: message(error) };
    stopPoll();
    emit();
  }
}

function emit() {
  for (const listener of listeners) listener();
}
