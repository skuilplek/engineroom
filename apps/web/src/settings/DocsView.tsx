import { useEffect, useState } from "react";
import { agentLabel, displayModelName, type AgentOptionChoice, type ExtensionRecord } from "@engineroom/protocol";
import { listExtensions, listSiteDocs, readExtensionDoc, readSiteDoc, type Session, type SiteDocLink } from "../api.ts";
import { Markdown } from "../chat/Markdown.tsx";
import { useReportError } from "../errors.tsx";
import adminGuide from "../../../../docs/guide/admin.md?raw";
import chatsGuide from "../../../../docs/guide/chats.md?raw";
import customizeGuide from "../../../../docs/guide/customize.md?raw";
import filesGuide from "../../../../docs/guide/files.md?raw";
import gitGuide from "../../../../docs/guide/git.md?raw";
import howGuide from "../../../../docs/guide/how-it-works.md?raw";
import projectsGuide from "../../../../docs/guide/projects.md?raw";
import terminalGuide from "../../../../docs/guide/terminal.md?raw";
import accountGuide from "../../../../docs/guide/your-account.md?raw";

interface DocLink {
  scope: "site" | "user";
  packageName: string;
  id: string;
  title: string;
}

type GuideId = "how" | "account" | "projects" | "chats" | "git" | "files" | "terminal" | "customize" | "enabled" | "admin";

const GUIDE: { id: GuideId; title: string; markdown?: string; admin?: boolean }[] = [
  { id: "how", title: "How it works", markdown: howGuide },
  { id: "account", title: "Your account", markdown: accountGuide },
  { id: "projects", title: "Projects", markdown: projectsGuide },
  { id: "chats", title: "Chats", markdown: chatsGuide },
  { id: "git", title: "Git", markdown: gitGuide },
  { id: "files", title: "Files", markdown: filesGuide },
  { id: "terminal", title: "Terminal", markdown: terminalGuide },
  { id: "customize", title: "Customize", markdown: customizeGuide },
  { id: "enabled", title: "What's enabled" },
  { id: "admin", title: "Admin", markdown: adminGuide, admin: true },
];

type Page =
  | { kind: "guide"; id: GuideId }
  | { kind: "package"; doc: DocLink }
  | { kind: "site"; id: string };

export function DocsView({ session }: { session: Session }) {
  const [docs, setDocs] = useState<DocLink[]>([]);
  const [siteDocs, setSiteDocs] = useState<SiteDocLink[]>([]);
  const [page, setPage] = useState<Page>({ kind: "guide", id: "how" });
  const [markdown, setMarkdown] = useState("");
  const [failed, setFailed] = useState(false);
  const [siteFailed, setSiteFailed] = useState(false);
  const report = useReportError();
  const selected = page.kind === "package" ? page.doc : null;
  const siteSelected = page.kind === "site" ? siteDocs.find((doc) => doc.id === page.id) : undefined;

  useEffect(() => {
    listExtensions().then((listed) => {
      setDocs(docsFrom(listed.site, "site").concat(docsFrom(listed.user, "user")));
    }).catch((err) => {
      setFailed(true);
      report("Docs", err);
    });
    listSiteDocs().then((listed) => {
      setSiteDocs(listed.docs);
    }).catch((err) => {
      setSiteFailed(true);
      report("Docs", err);
    });
  }, [report]);

  useEffect(() => {
    if (page.kind === "guide") {
      setMarkdown("");
      return;
    }
    let cancel = false;
    setMarkdown("");
    const pending = page.kind === "site"
      ? readSiteDoc(page.id)
      : readExtensionDoc(page.doc.scope, page.doc.packageName, page.doc.id);
    pending.then((body) => {
      if (!cancel) setMarkdown(body.markdown);
    }).catch((err) => {
      if (!cancel) report("Docs", err);
    });
    return () => {
      cancel = true;
    };
  }, [page, report]);

  const packageSite = docs.filter((doc) => doc.scope === "site");
  const userDocs = docs.filter((doc) => doc.scope === "user");
  const guideItems = GUIDE.filter((item) => !item.admin || session.admin);
  const guide = page.kind === "guide"
    ? guideItems.find((item) => item.id === page.id) ?? guideItems[0]
    : undefined;

  return (
    <div className="docs-page">
      <header>
        <p className="eyebrow">Reference</p>
        <h2>Docs</h2>
      </header>
      <div className="docs-layout">
        <nav className="docs-list" aria-label="Documents">
          <div>
            <p className="section-label">Guide</p>
            {guideItems.map((item) => {
              const active = page.kind === "guide" && page.id === item.id;
              return (
                <button
                  key={item.id}
                  className={active ? "docs-link active" : "docs-link"}
                  type="button"
                  onClick={() => setPage({ kind: "guide", id: item.id })}
                >
                  {item.title}
                </button>
              );
            })}
          </div>
          {(siteDocs.length > 0 || packageSite.length > 0) && (
            <div>
              <p className="section-label">Site</p>
              {siteDocs.map((doc) => {
                const active = page.kind === "site" && page.id === doc.id;
                return (
                  <button
                    key={`site-${doc.id}`}
                    className={active ? "docs-link active" : "docs-link"}
                    type="button"
                    onClick={() => setPage({ kind: "site", id: doc.id })}
                  >
                    {doc.title}
                  </button>
                );
              })}
              {packageSite.map((doc) => {
                const active = selected?.scope === doc.scope && selected.packageName === doc.packageName && selected.id === doc.id;
                return (
                  <button
                    key={`${doc.scope}-${doc.packageName}-${doc.id}`}
                    className={active ? "docs-link active" : "docs-link"}
                    type="button"
                    onClick={() => setPage({ kind: "package", doc })}
                  >
                    {doc.title}
                  </button>
                );
              })}
            </div>
          )}
          <DocGroup label="Yours" docs={userDocs} selected={selected} onSelect={(doc) => setPage({ kind: "package", doc })} />
          {failed && <p className="muted">Package documents could not be loaded.</p>}
          {siteFailed && <p className="muted">Site documents could not be loaded.</p>}
        </nav>
        <article className="docs-article">
          {guide ? (
            <div className="docs-copy">
              <h3>{guide.title}</h3>
              {guide.id === "enabled" ? <WhatsEnabled session={session} /> : guide.markdown && <Markdown text={guideBody(guide.markdown)} />}
            </div>
          ) : (
            <div className="docs-copy">
              {(selected || siteSelected) && <h3>{selected?.title ?? siteSelected?.title}</h3>}
              {markdown && <Markdown text={markdown} />}
            </div>
          )}
        </article>
      </div>
    </div>
  );
}

function guideBody(markdown: string): string {
  return markdown.replace(/^# .+\n+/, "");
}

function WhatsEnabled({ session }: { session: Session }) {
  const names = session.agentCatalog;
  return (
    <>
      <p>These are the options on for your account right now. An administrator can change what the server offers. Some of them can also be turned off for your account alone.</p>
      <ul className="docs-options">
        {session.agents.length === 0 ? (
          <OptionRow label="Agents" on={false} detail="No agents are available on this account." />
        ) : session.agents.map((agent) => {
          const options = session.options[agent];
          return (
            <OptionRow
              key={agent}
              label={agentLabel(agent, names)}
              on
              detail={`${choiceLine("Modes", options?.modes, "mode")} ${choiceLine("Models", options?.models, "model")}`}
            />
          );
        })}
        <OptionRow
          label="Terminal"
          on={session.rawTerminal}
          detail="A shell in your account. On a chat, Terminal switches the transcript for that shell, and Chat switches back."
        />
        <OptionRow
          label="File manager"
          on={session.fileManager}
          detail={`Lists the files in a project. Open it with Files on the start page or a chat.${grantLine(session.fileManagerOffered, session.fileManager)}`}
        />
        <OptionRow
          label="File editor"
          on={session.fileEditor}
          detail="Opens a project file so you can change it and save. With the read-only file viewer on, the same file opens for reading."
        />
        <OptionRow
          label="File download"
          on={Boolean(session.fileDownload)}
          detail={`Saves a file from the file list to your computer.${grantLine(session.fileDownloadOffered, Boolean(session.fileDownload))}`}
        />
        <OptionRow
          label="File upload"
          on={Boolean(session.fileUpload)}
          detail={`Adds a file from your computer into the project.${grantLine(session.fileUploadOffered, Boolean(session.fileUpload))}`}
        />
        <OptionRow
          label="Create projects"
          on={session.projectCreate}
          detail="Adds a project folder in your home, from a Git URL or as an empty repository. Also covers remotes, branches, and pull or push."
        />
        <OptionRow
          label="Project downloads"
          on={session.projectDownloads}
          detail="Saves a project folder as a zip from the project's start page."
        />
        <OptionRow
          label="CLI import"
          on={session.cliImport}
          detail="Brings Cursor conversations that already exist on this account into the sidebar."
        />
        <OptionRow
          label="Read-only files"
          on={Boolean(session.filesReadOnly)}
          detail={session.filesReadOnly
            ? "Files open for reading, and the editor does not save. This is your Customize setting."
            : "The editor can save files when the file editor is on. Turn this on in Customize to keep files read-only."}
        />
      </ul>
    </>
  );
}

function OptionRow({ label, on, detail }: { label: string; on: boolean; detail: string }) {
  return (
    <li className="docs-option">
      <strong>{label}</strong>
      <span className={on ? "docs-state on" : "docs-state"}>{on ? "On" : "Off"}</span>
      <p>{detail}</p>
    </li>
  );
}

function choiceLine(label: string, choices: AgentOptionChoice[] | undefined, kind: "mode" | "model"): string {
  if (!choices || choices.length === 0) return `${label}: none reported.`;
  const names = choices.map((choice) => kind === "model" ? displayModelName(choice.id, choice.name) : (choice.name.trim() || choice.id));
  return `${label}: ${names.join(", ")}.`;
}

function grantLine(offered: boolean | undefined, allowed: boolean): string {
  if (offered == null) return "";
  if (offered && allowed) return " Offered on this server, and allowed for this account.";
  if (offered) return " Offered on this server, and turned off for this account.";
  return " Not offered on this server.";
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
