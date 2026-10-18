import { IconPanelRight } from "../icons.tsx";

export function FilesPaneToggle({
  filesOpen,
  onToggle,
}: {
  filesOpen?: boolean;
  onToggle?: () => void;
}) {
  if (!onToggle || filesOpen) return null;
  return (
    <button
      className="ghost icon-toggle"
      type="button"
      aria-pressed={false}
      aria-label="Show repository files"
      title="Show repository files"
      onClick={onToggle}
    >
      <IconPanelRight />
      <span>Files</span>
    </button>
  );
}
