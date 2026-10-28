import { useEffect, useState } from "react";
import type { ExtensionRecord } from "@engineroom/protocol";
import { listExtensions, readExtensionDoc } from "../api.ts";
import { Markdown } from "../chat/Markdown.tsx";
import { useReportError } from "../errors.tsx";

interface DocLink {
  scope: "site" | "user";
  packageName: string;
  id: string;
  title: string;
}

export function DocsView() {
  const [docs, setDocs] = useState<DocLink[]>([]);
  const [selected, setSelected] = useState<DocLink | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [failed, setFailed] = useState(false);
  const report = useReportError();

  useEffect(() => {
    listExtensions().then((listed) => {
      const links = docsFrom(listed.site, "site").concat(docsFrom(listed.user, "user"));
      setDocs(links);
      setSelected(links[0] ?? null);
    }).catch((err) => {
      setFailed(true);
      report("Docs", err);
    });
  }, [report]);

  useEffect(() => {
    if (!selected) {
      setMarkdown("");
      return;
    }
    let cancel = false;
    readExtensionDoc(selected.scope, selected.packageName, selected.id).then((page) => {
      if (!cancel) setMarkdown(page.markdown);
    }).catch((err) => {
      if (!cancel) report("Docs", err);
    });
    return () => {
      cancel = true;
    };
  }, [selected, report]);

  const siteDocs = docs.filter((doc) => doc.scope === "site");
  const userDocs = docs.filter((doc) => doc.scope === "user");

  return (
    <div className="docs-page">
      <header>
        <p className="eyebrow">Reference</p>
        <h2>Docs</h2>
      </header>
      {failed ? <p className="muted">Documents could not be loaded.</p> : docs.length === 0 ? <p className="muted">No documents from installed packages.</p> : (
        <div className="docs-layout">
          <nav className="docs-list" aria-label="Documents">
            <DocGroup label="Site" docs={siteDocs} selected={selected} onSelect={setSelected} />
            <DocGroup label="Yours" docs={userDocs} selected={selected} onSelect={setSelected} />
          </nav>
          <article className="docs-article">
            {selected && <h3>{selected.title}</h3>}
            {markdown && <Markdown text={markdown} />}
          </article>
        </div>
      )}
    </div>
  );
}

function docsFrom(packages: ExtensionRecord[], scope: "site" | "user"): DocLink[] {
  const links: DocLink[] = [];
  for (const item of packages) {
    if (!item.enabled || item.error) continue;
    for (const doc of item.docs) {
      links.push({ scope, packageName: item.name, id: doc.id, title: doc.title });
    }
  }
  return links;
}

function DocGroup({
  label,
  docs,
  selected,
  onSelect,
}: {
  label: string;
  docs: DocLink[];
  selected: DocLink | null;
  onSelect: (doc: DocLink) => void;
}) {
  if (docs.length === 0) return null;
  return (
    <div>
      <p className="section-label">{label}</p>
      {docs.map((doc) => {
        const active = selected?.scope === doc.scope && selected.packageName === doc.packageName && selected.id === doc.id;
        return (
          <button
            key={`${doc.scope}-${doc.packageName}-${doc.id}`}
            className={active ? "docs-link active" : "docs-link"}
            type="button"
            onClick={() => onSelect(doc)}
          >
            {doc.title}
          </button>
        );
      })}
    </div>
  );
}
