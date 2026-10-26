import { useEffect, useState, type FormEvent } from "react";
import type { ChatMeta, RepositoryEntry } from "@engineroom/protocol";
import { relativeTime, strip, workspaceLabel } from "../format.ts";

export function HomeView({
  repos,
  chats,
  home,
  projectCreate,
  onPickProject,
  onOpen,
  onCreateProject,
}: {
  repos: RepositoryEntry[];
  chats: ChatMeta[];
  home: string;
  projectCreate: boolean;
  onPickProject: (path: string) => void;
  onOpen: (chat: ChatMeta) => void;
  onCreateProject: (name: string, url: string) => Promise<void>;
}) {
  const active = repos.filter((repo) => !repo.archived);
  const activeKeys = new Set(active.map((repo) => strip(repo.path)));
  const [project, setProject] = useState(() => (active.length === 1 ? active[0]!.path : ""));
  const recent = [...chats]
    .filter((chat) => activeKeys.has(strip(chat.workspace)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8);

  useEffect(() => {
    const next = repos.filter((repo) => !repo.archived);
    setProject((current) => {
      if (next.some((repo) => repo.path === current)) return current;
      return next.length === 1 ? next[0]!.path : "";
    });
  }, [repos]);

  return (
    <div className="start home">
      <h1>What do you want to work on?</h1>
      <section className="home-card">
        <h2>New chat</h2>
        {active.length > 0 ? (
          <>
            <label>
              Project
              <select aria-label="Project" value={project} onChange={(event) => setProject(event.target.value)}>
                {active.length > 1 && <option value="">Choose a project</option>}
                {active.map((repo) => (
                  <option key={repo.path} value={repo.path}>{repo.name}</option>
                ))}
              </select>
            </label>
            <button className="primary" type="button" disabled={!project} onClick={() => onPickProject(project)}>
              Start chat
            </button>
          </>
        ) : (
          <p className="muted">
            {projectCreate
              ? "Add a project to start a chat."
              : "A repository has to be enabled before you can start a chat."}
          </p>
        )}
      </section>
      {projectCreate && <NewProjectCard onCreate={onCreateProject} />}
      {recent.length > 0 && (
        <section className="home-card">
          <h2>Recent chats</h2>
          <div className="home-chats">
            {recent.map((chat) => (
              <button className="chat-row" key={chat.id} type="button" onClick={() => onOpen(chat)}>
                <span className="chat-title">{chat.title}</span>
                <span className="chat-time">{workspaceLabel(chat.workspace, home, repos)} · {relativeTime(chat.updatedAt)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function NewProjectCard({ onCreate }: { onCreate: (name: string, url: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onCreate(name.trim(), url.trim());
      setName("");
      setUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create the project");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="home-card">
      <h2>New project</h2>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Folder name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="widget" required />
        </label>
        <label>
          Git URL
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Leave blank to start an empty repository"
          />
        </label>
        {error && <p className="alert" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create project"}</button>
      </form>
    </section>
  );
}
