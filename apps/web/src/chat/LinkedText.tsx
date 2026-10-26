import { Children, Fragment, type ReactNode } from "react";
import { clickableFileToken, splitFileRefs } from "./filePaths.ts";

export function LinkedText({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile?: (path: string) => void;
}) {
  if (!onOpenFile) return <>{text}</>;
  const parts = splitFileRefs(text);
  if (parts.length === 1 && !parts[0]?.path) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        part.path ? (
          <button
            key={index}
            type="button"
            className="file-path-link"
            title={`Open ${part.path}`}
            aria-label={`Open ${part.path}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenFile(part.path!);
            }}
          >
            {part.text}
          </button>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

export function linkifyChildren(children: ReactNode, onOpenFile?: (path: string) => void): ReactNode {
  if (!onOpenFile) return children;
  return Children.map(children, (child) => {
    if (typeof child === "string") return <LinkedText text={child} onOpenFile={onOpenFile} />;
    return child;
  });
}

export function FileTokenButton({
  token,
  children,
  onOpenFile,
  allowBare = false,
}: {
  token: string;
  children: ReactNode;
  onOpenFile?: (path: string) => void;
  allowBare?: boolean;
}) {
  const path = onOpenFile ? clickableFileToken(token, { allowBare }) : null;
  if (!path || !onOpenFile) return <>{children}</>;
  return (
    <button
      type="button"
      className="file-path-link"
      title={`Open ${path}`}
      aria-label={`Open ${path}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenFile(path);
      }}
    >
      {children}
    </button>
  );
}
