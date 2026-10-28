# Extension packages

A package adds themes, markdown docs, or agent commands without changing the Engineroom checkout. The hub never runs package code. It only reads `engineroom.json`, CSS, and markdown.

## Locations

| Scope | Directory | Who installs it |
| --- | --- | --- |
| Site | `/var/lib/engineroom/extensions/<name>/` | An administrator, for everyone |
| User | `~/.engineroom/extensions/<name>/` | That person, for their account only |

The index next to each directory is `extensions.json`. It records the source, commit, and whether the package is enabled. Disabling keeps the files. Removing deletes that package directory only.

Site packages live beside `agents.json`. If `ENGINEROOM_AGENTS_FILE` points somewhere else, the site extension directory is the parent of that file.

## Manifest

Each package directory contains `engineroom.json`:

```json
{
  "name": "harbor-notes",
  "version": "1.0.0",
  "description": "Harbor theme, on-call notes, and the harbor agent",
  "themes": [
    {
      "id": "harbor",
      "name": "Harbor",
      "tagline": "Cool slate",
      "tier": "simple",
      "file": "harbor.css",
      "swatches": {
        "bg": "#0e1418",
        "sidebar": "#121a20",
        "panel": "#182228",
        "accent": "#7eb8c9",
        "ink": "#e7eef2",
        "border": "#2a3a44"
      }
    }
  ],
  "docs": [{ "id": "oncall", "title": "On call", "file": "docs/oncall.md" }],
  "agents": [{ "id": "harbor", "label": "Harbor", "binary": "harbor" }]
}
```

`name` and every id are slugs: a lowercase letter, then up to 31 letters, digits, or hyphens. Theme files end in `.css`. Doc files end in `.md`. Paths stay inside the package directory. Theme ids cannot reuse `dark`, `light`, `haxor`, `midnight`, `engine`, or `pi`. Agent ids cannot reuse `cursor`, `claude`, or `pi`.

A package starts disabled. Enabling it fails when one of its theme, doc, or agent ids is already used by a built-in or by another enabled package. An agent entry is only a command name or an absolute path. The package does not install that command.

Theme CSS is served to a signed-in browser as `text/css` and applied while that theme is selected. Docs render as markdown without raw HTML. Site agents join the administrator's agent list and can be granted to people the same way a custom agent is. User agents are available only on that account.

## Install

From Customize (your account) or Admin → Packages, paste either:

- a git URL, such as `https://github.com/user/harbor-notes.git` or `git:github.com/user/harbor-notes`
- an absolute directory that already contains `engineroom.json`

Git clones use `core.hooksPath=/dev/null`, `--depth 1`, and no submodules. Engineroom does not run `npm install` or package scripts. Update is a separate action. It fetches the git remote again, or copies the local directory again.

## Related

- Settings files: [configuration.md](configuration.md)
- Hub and runner: [architecture.md](architecture.md)
