import { useEffect, useState, type FormEvent } from "react";
import {
  addSiteDoc,
  listSiteDocs,
  readSiteDoc,
  removeSiteDoc,
  updateSiteDoc,
  type SiteDocLink,
} from "../api.ts";
import { useReportError } from "../errors.tsx";
import { message } from "../format.ts";

interface Draft extends SiteDocLink {
  markdown: string;
  file: File | null;
}

export function SiteDocsSection({ onCount }: { onCount?: (count: number) => void }) {
  const [docs, setDocs] = useState<Draft[]>([]);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const report = useReportError();

  function setError(value: string) {
    if (value) report("Docs", value);
  }

  async function refresh() {
    const listed = await listSiteDocs();
    const pages = await Promise.all(listed.docs.map(async (doc) => {
      const page = await readSiteDoc(doc.id);
      return { id: doc.id, title: page.title, markdown: page.markdown, file: null };
    }));
    setDocs(pages);
    setRevision((current) => current + 1);
    onCount?.(pages.length);
  }

  useEffect(() => {
    refresh().catch((err) => setError(message(err)));
  }, []);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const next = file;
    if (!next) return;
    void run(async () => {
      await addSiteDoc(title.trim(), next);
      setTitle("");
      setFile(null);
      form.reset();
    });
  }

  function patch(id: string, next: Partial<Draft>) {
    setDocs((current) => current.map((doc) => (doc.id === id ? { ...doc, ...next } : doc)));
  }

  return (
    <>
      <section>
        <h2>Site documents</h2>
        <p className="muted">
          Add a markdown file for everyone signed in. It appears under Site in Docs and stays on this server, outside the Engineroom checkout.
          The title needs a letter. On call is stored once, and a later rename keeps that document.
        </p>
        <form className="site-doc-add" onSubmit={add}>
          <label>
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="On call" required />
          </label>
          <label>
            Markdown file
            <input
              type="file"
              accept=".md,text/markdown"
              required
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <button className="primary" type="submit" disabled={busy || !title.trim() || !file}>Add document</button>
        </form>
      </section>
      {docs.length === 0 ? <p className="muted">No site documents yet.</p> : (
        <div className="site-doc-list">
          {docs.map((doc) => (
            <article className="agents-card" key={doc.id}>
              <label>
                Title
                <input value={doc.title} onChange={(event) => patch(doc.id, { title: event.target.value })} />
              </label>
              <label>
                Markdown
                <textarea
                  className="site-doc-markdown"
                  rows={12}
                  value={doc.markdown}
                  spellCheck
                  onChange={(event) => patch(doc.id, { markdown: event.target.value })}
                />
              </label>
              <label>
                Replace with a file
                <input
                  key={`${doc.id}-${revision}`}
                  type="file"
                  accept=".md,text/markdown"
                  onChange={(event) => patch(doc.id, { file: event.target.files?.[0] ?? null })}
                />
              </label>
              {doc.file && <p className="muted">Update replaces the text with {doc.file.name}.</p>}
              <div className="row-actions">
                <button className="primary" type="button" disabled={busy || !doc.title.trim()} onClick={() => void run(() => updateSiteDoc(doc.id, doc.title.trim(), doc.markdown, doc.file ?? undefined))}>
                  Update
                </button>
                <button className="danger" type="button" disabled={busy} onClick={() => void run(() => removeSiteDoc(doc.id))}>
                  Remove
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
