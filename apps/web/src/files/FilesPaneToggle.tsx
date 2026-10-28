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
      aria-label="Files"
      title="Files"
      onClick={onToggle}
    >
      <IconPanelRight />
    </button>
  );
}
