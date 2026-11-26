import { useEffect, useState } from "react";
import { deleteTrash, listTrash, type TrashListing } from "../api.ts";
import { useReportError } from "../errors.tsx";
import { message, relativeTime } from "../format.ts";

export function TrashSection() {
  const [entries, setEntries] = useState<TrashListing[]>([]);
  const [busy, setBusy] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const report = useReportError();
  function setError(value: string) {
    if (value) report("Trash", value);
  }

  useEffect(() => {
    let cancelled = false;
    listTrash()
      .then((result) => {
        if (!cancelled) setEntries(result.entries);
      })
      .catch((err) => {
        if (!cancelled) {
          setFailed(true);
          setError(message(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    setBusy("refresh");
    setError("");
    try {
      setEntries((await listTrash()).entries);
      setFailed(false);
    } catch (err) {
      setFailed(true);
      setError(message(err));
    } finally {
      setBusy("");
    }
  }

  async function remove(entry: TrashListing) {
    const label = `${entry.name} in ${entry.username}'s trash`;
    // Emptying the trash cannot be undone, so the folder name is typed back
    // the same way deleting a project asks for it.
    const typed = window.prompt(`This permanently deletes ${label}. Type the project name to confirm.`);
    if (typed === null) return;
    if (typed.trim() !== entry.name) {
      setError("The name did not match, so nothing was deleted.");
      return;
    }
    setBusy(`${entry.username}/${entry.id}`);
    setError("");
    try {
      setEntries((await deleteTrash(entry.username, entry.id)).entries);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy("");
    }
  }

  const total = entries.reduce((sum, entry) => sum + entry.chats, 0);

  return (
    <div className="trash-page">
      <header className="repos-head">
        <div>
          <h2>Deleted projects</h2>
          <p className="muted">
            Deleting a project moves its folder and chats to <code>~/.trash</code> in that person&apos;s home, so the
            work is still there. Emptying the trash cannot be undone. Chats are counted with the project, and a deleted
            project no longer appears for the person who deleted it.
          </p>
        </div>
        <button className="ghost" type="button" disabled={busy !== ""} onClick={() => void refresh()}>
          {busy === "refresh" ? "Reading…" : "Refresh"}
        </button>
      </header>
      {failed ? (
        <p className="muted">The trash could not be read. The error is saved under Errors.</p>
      ) : loaded && entries.length === 0 ? (
        <p className="muted">The trash is empty.</p>
      ) : (
        <>
          <p className="muted">
            {entries.length === 0
              ? "Reading the trash…"
              : `${entries.length} ${entries.length === 1 ? "project" : "projects"} and ${total} ${total === 1 ? "chat" : "chats"}.`}
          </p>
          <div className="repos-table-wrap">
            <table className="repos-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Person</th>
                  <th>Deleted</th>
                  <th>Chats</th>
                  <th>Delete</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const id = `${entry.username}/${entry.id}`;
                  return (
                    <tr key={id}>
                      <td>
                        {entry.name}
                        <span className="trash-origin">{entry.path ? `from ${entry.path}` : entry.id}</span>
                      </td>
                      <td>{entry.username}</td>
                      <td>
                        {entry.deletedAt ? (
                          <time dateTime={entry.deletedAt} title={entry.deletedAt}>
                            {relativeTime(entry.deletedAt)}
                          </time>
                        ) : (
                          "Unknown"
                        )}
                      </td>
                      <td>{entry.chats}</td>
                      <td>
                        <button className="danger" type="button" disabled={busy !== ""} onClick={() => void remove(entry)}>
                          {busy === id ? "Deleting…" : "Delete"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
