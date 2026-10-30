export function CursorCommandFields({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label>
        Allowed commands
        <textarea
          aria-label="Allowed commands"
          rows={8}
          value={value}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <p className="muted">One command per line, such as ls or npm install. These are stored as Shell entries. Write paths already in the Cursor config stay.</p>
    </>
  );
}

export function commandLines(value: string): string[] {
  const commands: string[] = [];
  for (const line of value.split("\n")) {
    const name = line.trim();
    if (!name || commands.includes(name)) continue;
    commands.push(name);
  }
  return commands;
}
