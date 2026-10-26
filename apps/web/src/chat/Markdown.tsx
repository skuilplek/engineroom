import { createElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { clickableFileToken } from "./filePaths.ts";
import { FileTokenButton, linkifyChildren } from "./LinkedText.tsx";

export function Markdown({
  text,
  streaming,
  onOpenFile,
}: {
  text: string;
  streaming?: boolean;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <div className={streaming ? "markdown streaming" : "markdown"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={onOpenFile ? fileLinkComponents(onOpenFile) : undefined}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function fileLinkComponents(onOpenFile: (path: string) => void): Components {
  const linked = (tag: string) =>
    function LinkedBlock({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown }) {
      return createElement(tag, props, linkifyChildren(children, onOpenFile));
    };
  return {
    p: linked("p"),
    li: linked("li"),
    td: linked("td"),
    th: linked("th"),
    h1: linked("h1"),
    h2: linked("h2"),
    h3: linked("h3"),
    h4: linked("h4"),
    h5: linked("h5"),
    h6: linked("h6"),
    blockquote: linked("blockquote"),
    strong: linked("strong"),
    em: linked("em"),
    a: ({ href, children, node: _node }) => {
      const path = href ? clickableFileToken(href, { allowBare: true }) : null;
      if (!path) {
        return <a href={href}>{children}</a>;
      }
      return (
        <FileTokenButton token={href ?? ""} onOpenFile={onOpenFile} allowBare>
          {children}
        </FileTokenButton>
      );
    },
    code: ({ className, children, node: _node }) => {
      const value = codeText(children).replace(/\n$/, "");
      if (!className && value && !value.includes("\n")) {
        return (
          <FileTokenButton token={value} onOpenFile={onOpenFile} allowBare>
            <code>{children}</code>
          </FileTokenButton>
        );
      }
      return <code className={className}>{linkifyChildren(children, onOpenFile)}</code>;
    },
  };
}

function codeText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map((child) => codeText(child as ReactNode)).join("");
  return "";
}
