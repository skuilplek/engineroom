import { useState } from "react";
import { relativeTime } from "../format.ts";
import { useErrors } from "../errors.tsx";

export function ErrorsView() {
  const { errors, remove, clear, report } = useErrors();
  const [busy, setBusy] = useState("");

  async function run(id: string, action: () => Promise<void>) {
    setBusy(id);
    try {
      await action();
    } catch (err) {
      report("Errors", err);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="errors-page">
      <header className="errors-head">
        <div>
          <p className="eyebrow">Account</p>
          <h2>Errors</h2>
        </div>
        {errors.length > 0 && (
          <button className="ghost" type="button" disabled={busy !== ""} onClick={() => void run("all", clear)}>
            {busy === "all" ? "Clearing…" : "Clear all"}
          </button>
        )}
      </header>
      <p className="muted">These are saved for this account, so a dismissed notice can be read again here.</p>
      {errors.length === 0 ? (
        <p className="muted">No errors saved.</p>
      ) : (
        <ul className="errors-list">
          {errors.map((item) => (
            <li className="error-entry" key={item.id}>
              <div className="error-entry-head">
                <strong>{item.action}</strong>
                <time dateTime={item.at} title={item.at}>{relativeTime(item.at)}</time>
              </div>
              <pre>{item.message}</pre>
              <div className="actions">
                <button className="ghost" type="button" disabled={busy !== ""} onClick={() => void run(item.id, () => remove(item.id))}>
                  {busy === item.id ? "Clearing…" : "Clear"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
