import { useEffect, useState, type FormEvent } from "react";
import type { ExtensionRecord, ExtensionScope } from "@engineroom/protocol";
import {
  installExtension,
  listAdminExtensions,
  listExtensions,
  removeExtension,
  setExtensionEnabled,
  updateExtension,
} from "../api.ts";
import { useReportError } from "../errors.tsx";
import { message } from "../format.ts";

export function PackagesSection({
  scope,
  onChanged,
}: {
  scope: ExtensionScope;
  onChanged?: () => void;
}) {
  const [packages, setPackages] = useState<ExtensionRecord[]>([]);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const report = useReportError();
  function setError(value: string) {
    if (value) report("Packages", value);
  }

  async function refresh() {
    if (scope === "site") {
      setPackages((await listAdminExtensions()).packages);
      return;
    }
    const listed = await listExtensions();
    setPackages(listed.user);
  }

  useEffect(() => {
    refresh().catch((err) => setError(message(err)));
  }, [scope]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function install(event: FormEvent) {
    event.preventDefault();
    const next = source.trim();
    if (!next) return;
    void run(async () => {
      await installExtension(next, scope);
      setSource("");
    });
  }

  return (
    <section className="package-section">
      <h2>Packages</h2>
      <p className="muted">
        Install a theme, document, or agent from a git URL or a directory on this machine. Packages stay out of the Engineroom checkout and start disabled.
      </p>
      <form className="package-install" onSubmit={install}>
        <label>
          Source
          <input
            value={source}
            placeholder="https://github.com/user/theme.git or /home/alice/themes/harbor"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setSource(event.target.value)}
          />
        </label>
        <button className="primary" type="submit" disabled={busy || !source.trim()}>Install</button>
      </form>
      {packages.length === 0 ? <p className="muted">No packages installed.</p> : (
        <div className="package-list">
          {packages.map((item) => (
            <article className="package-card" key={item.name}>
              <header>
                <div>
                  <strong>{item.name}</strong>
                  <span className={item.enabled ? "theme-badge" : "theme-badge"}>{item.enabled ? "Enabled" : "Disabled"}</span>
                </div>
                <span className="muted">{item.version}</span>
              </header>
              {item.description && <p className="muted">{item.description}</p>}
              {item.error && <p className="alert" role="alert">{item.error}</p>}
              <p className="muted package-source">{item.source}{item.commit ? ` @ ${item.commit.slice(0, 12)}` : ""}</p>
              <ul className="package-contributions">
                {item.themes.map((theme) => <li key={`theme-${theme.id}`}>Theme {theme.name}</li>)}
                {item.docs.map((doc) => <li key={`doc-${doc.id}`}>Doc {doc.title}</li>)}
                {item.agents.map((agent) => <li key={`agent-${agent.id}`}>Agent {agent.label}</li>)}
              </ul>
              <div className="package-actions">
                <button className="ghost" type="button" disabled={busy || Boolean(item.error)} onClick={() => void run(() => setExtensionEnabled(item.name, !item.enabled, scope))}>
                  {item.enabled ? "Disable" : "Enable"}
                </button>
                <button className="ghost" type="button" disabled={busy} onClick={() => void run(() => updateExtension(item.name, scope))}>Update</button>
                <button className="danger" type="button" disabled={busy} onClick={() => void run(() => removeExtension(item.name, scope))}>Remove</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
