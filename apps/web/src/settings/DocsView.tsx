import { useEffect, useState } from "react";
import { agentLabel, displayModelName, type AgentOptionChoice, type ExtensionRecord } from "@engineroom/protocol";
import { listExtensions, readExtensionDoc, type Session } from "../api.ts";
import { Markdown } from "../chat/Markdown.tsx";
import { useReportError } from "../errors.tsx";

interface DocLink {
  scope: "site" | "user";
  packageName: string;
  id: string;
  title: string;
}

type GuideId = "how" | "using" | "enabled" | "parts";

const GUIDE: { id: GuideId; title: string }[] = [
  { id: "how", title: "How it works" },
  { id: "using", title: "Using it" },
  { id: "enabled", title: "What's enabled" },
  { id: "parts", title: "Parts of the screen" },
];

type Page =
  | { kind: "guide"; id: GuideId }
  | { kind: "package"; doc: DocLink };

export function DocsView({ session }: { session: Session }) {
  const [docs, setDocs] = useState<DocLink[]>([]);
  const [page, setPage] = useState<Page>({ kind: "guide", id: "how" });
  const [markdown, setMarkdown] = useState("");
  const [failed, setFailed] = useState(false);
  const report = useReportError();
  const selected = page.kind === "package" ? page.doc : null;

  useEffect(() => {
    listExtensions().then((listed) => {
      setDocs(docsFrom(listed.site, "site").concat(docsFrom(listed.user, "user")));
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
    readExtensionDoc(selected.scope, selected.packageName, selected.id).then((body) => {
      if (!cancel) setMarkdown(body.markdown);
    }).catch((err) => {
      if (!cancel) report("Docs", err);
    });
    return () => {
      cancel = true;
    };
  }, [selected, report]);

  const siteDocs = docs.filter((doc) => doc.scope === "site");
  const userDocs = docs.filter((doc) => doc.scope === "user");
  const guide = GUIDE.find((item) => page.kind === "guide" && item.id === page.id);

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
            {GUIDE.map((item) => {
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
          <DocGroup label="Site" docs={siteDocs} selected={selected} onSelect={(doc) => setPage({ kind: "package", doc })} />
          <DocGroup label="Yours" docs={userDocs} selected={selected} onSelect={(doc) => setPage({ kind: "package", doc })} />
          {failed && <p className="muted">Package documents could not be loaded.</p>}
        </nav>
        <article className="docs-article">
          {guide ? (
            <div className="docs-copy">
              <h3>{guide.title}</h3>
              {guide.id === "how" && <HowItWorks session={session} />}
              {guide.id === "using" && <UsingIt session={session} />}
              {guide.id === "enabled" && <WhatsEnabled session={session} />}
              {guide.id === "parts" && <Parts session={session} />}
            </div>
          ) : (
            <>
              {selected && <h3>{selected.title}</h3>}
              {markdown && <Markdown text={markdown} />}
            </>
          )}
        </article>
      </div>
    </div>
  );
}

function HowItWorks({ session }: { session: Session }) {
  const name = session.appName.trim() || "Engineroom";
  return (
    <>
      <p>You sign in to {name} with your Linux username and password. Chats, project folders, and agent commands run as that account, in {session.home}.</p>
      <p>The administrator decides which agents and tools this server offers, and which of those your account may use. A reply streams into the chat as the agent works. The modes and models in the composer are the ones that agent reports and that this server offers to you.</p>
      <p>Customize holds your own defaults: theme, the agent and model a new chat starts with, how tool requests are approved, and whether the file viewer is read-only.</p>
    </>
  );
}

function UsingIt({ session }: { session: Session }) {
  return (
    <>
      <p>Open a project from the sidebar. Its chats are listed under the project name, and Search chats filters that list. The project's start page is where a new chat begins.</p>
      <p>Choose an agent when more than one is available, then a mode and a model. Write a prompt, attach files when you want them included, and send. You can stop a reply while it is still running. When the agent asks to use a tool, answer that prompt. Customize sets whether those requests ask every time, allow edits and ask for the rest, or allow everything.</p>
      <p>From a project's start page you can archive it. Archived projects stay in the sidebar under Archived. You can also delete a project from that page by typing its folder name.</p>
      {session.projectCreate && (
        <p>New project, in the sidebar, adds a folder in your home. Leave the Git URL blank to start an empty repository, or paste a URL to clone one. With that access you can also set a remote, create and switch branches, and pull or push from the start page.</p>
      )}
      {session.projectDownloads && (
        <p>Download project, on the start page, saves the project folder as a zip.</p>
      )}
      {session.cliImport && (
        <p>Import CLI sessions, in the sidebar, brings in Cursor or Claude conversations that already exist on this account.</p>
      )}
    </>
  );
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
          detail="Brings Cursor and Claude conversations that already exist on this account into the sidebar."
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

function Parts({ session }: { session: Session }) {
  return (
    <ul className="docs-parts">
      <li><strong>Project list.</strong> The sidebar lists projects and the chats inside them. Search chats looks through that list. The panel button collapses the sidebar.</li>
          <li><strong>Chat.</strong> The transcript of one conversation, including the agent's reply, tool commands, and diffs.</li>
      <li><strong>Composer.</strong> The box where you write a prompt, pick the agent, mode, and model, attach files, and send or stop.</li>
      <li><strong>Files.</strong> {session.fileManager ? "The file list for the open project. Files on the start page or a chat opens it." : "The file list is turned off for this account."}</li>
      <li><strong>Editor.</strong> {session.fileEditor ? "Opens a file from that list. You can save changes when the read-only file viewer is off." : "The editor is turned off for this account."}</li>
      <li><strong>Terminal.</strong> {session.rawTerminal ? "A shell running as your account. Terminal on a chat replaces the transcript until you choose Chat." : "The terminal is turned off for this account."}</li>
      <li><strong>Customize.</strong> Your theme, command-block style, how many chats stay visible, line wrap, default agent and model, tool approval, and the read-only file viewer. Packages you install for yourself are here too.</li>
      <li><strong>Docs.</strong> This guide, plus notes from packages that are enabled.</li>
      {session.admin && (
        <li><strong>Admin.</strong> The server name, which agents and tools are offered, repository access, and who can sign in.</li>
      )}
    </ul>
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
