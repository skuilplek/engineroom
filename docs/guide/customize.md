# Customize

Customize is in the account menu. Change the settings, then Save. A saved note confirms it. Cursor commands and packages save on their own buttons.

## Appearance

Choose a theme and Save to keep it. The card you select applies immediately, so you can look at it before saving. Built-in themes are listed with any themes from packages that are enabled. Simple and elaborate describe the theme, and Default marks the starting one.

Command blocks chooses how tool commands appear in a chat. Prompt is the default. Window draws a title bar around the command.

Chats shown per project is how many chats stay visible under each project before the rest collapse. The range is 0 to 100. Older chats stay collapsed. Use 0 to show every chat.

Wrap long lines wraps file text, diffs, and code blocks instead of scrolling sideways. The switch applies as soon as you toggle it, and Save keeps it.

## Defaults for new chats

Default agent and Default model are what a new chat starts with. The model list follows the agent you pick. On an open chat you can still change the mode and model for the next prompt.

Tool approval:

- **Ask each time** waits for you at every tool request.
- **Allow edits, ask for the rest** lets the agent edit and asks for other actions.
- **Allow everything** proceeds without those prompts.

Read-only file viewer opens files for reading and keeps the editor from saving. When the administrator has turned the file editor off, this checkbox stays on and the note says file editing is turned off.

If Pi still needs installing, Set up Pi is at the top of this section.

## Cursor commands

When Cursor is available, Cursor commands lists shell commands Cursor may run for you, one command per line, such as `ls` or `npm install`. Save commands stores the list. An administrator can replace this list from the Agents tab.

## Packages

Packages installs a theme, a document, or an agent command for your account only. Paste a git URL, such as `https://github.com/user/harbor-notes.git`, or an absolute directory on this machine that already contains `engineroom.json`. Install fetches it. A new package starts disabled.

Enable turns it on. A theme then appears under Appearance. A document appears in Docs under Yours. An agent becomes one you can use on this account, once the command itself is installed. Disable keeps the files and turns those contributions off. Update fetches the git remote again, or copies the local directory again. Remove deletes that package.

Site packages, installed by an administrator for everyone, show their documents under Site in Docs, along with documents added from the Admin Docs tab. Enabling fails when one of the package's theme, document, or agent ids is already in use. The card shows that error.
