# Admin

Admin is in the account menu for the administrator. The tabs are Overview, Server, Agents, Packages, Docs, Repositories, and Users. Arrow keys move between the tabs while the tab list is focused.

Offer a tool or an agent here, then allow it on a person's page. They can use it while the offer is on and, for an agent, while the command is installed on their account.

## Overview

Application name is the name in the sidebar. Save stores it.

Server shows this machine: hostname, system, Node version, uptime, free memory, and free disk. Refresh reloads those figures.

The cards jump to Agents, Packages, Docs, Repositories, and Users, and summarize what is offered.

## Server

Network name is the hostname other computers on this network can open, shown as an address above the field. Save stores it and starts Avahi when that service is stopped. Discard restores the saved name. When the site is served over HTTPS, sign in on that HTTPS address. The session cookie is only sent over HTTPS.

Wi-Fi lists the wireless adapter. Scan fills the network list. Choose a network, or type a name for a hidden one, enter the password, and Connect. Leave the password blank for an open network. Disconnect leaves the current network. When the machine has more than one adapter, Adapter picks which one to use. Saving a network needs NetworkManager or netplan.

## Agents

Available agents is the offer list. Turn an agent on here before you can allow it for a person. Global tooling, on the same card, is the server-wide switch for each of these:

- Raw terminal
- Import CLI sessions
- Repository file manager
- File editor
- File download
- File upload

Save agents stores the offer. Discard drops unsaved changes. Nothing is offered until you save. Load modes and models asks the selected agent which modes and models it has, so you can choose which of those to offer.

Each built-in agent has a tab.

- **Cursor defaults** sets Fast mode. The default model is Grok 4.7. Apply to all users writes that choice, and replaces the Shell command list, for everyone who has Cursor and is allowed that model. Apply to this user does the same for the account you pick.
- **Pi setup** stores a provider and a model. Apply writes those into the Pi settings of people who are allowed that model. Setup writes the same values when it installs Pi.

The + tab adds an agent. Give it a display name and the command to launch, such as `codex`, or an absolute path. Add agent registers it. Built-in agents already have their own tabs. Remove, on a custom agent's tab, deletes that entry.

After modes and models are loaded, check the ones this server should offer. Clearing a model removes it from the offer.

## Packages

Packages on this tab installs for everyone. The form is the same as Customize: a git URL or a directory, then Install, Enable, Disable, Update, and Remove. Documents from an enabled site package appear under Site in Docs. Themes appear for every account. Agents join this offer list and can be granted like any other custom agent.

## Docs

Docs on this tab adds a markdown file for everyone signed in. The file stays on this server. It is not part of the Engineroom checkout.

Title is the name under Site in Docs. Choose a markdown file, then Add document. The page is there as soon as it is saved.

Update saves a new title, the text in the box, or both. Choose a file when that file should replace the text. Remove deletes the document. A title change keeps the same document. The title needs a letter, such as On call.

## Repositories

Repository folder is the home-relative path that is scanned when someone signs in. The default is `Sites`. People can start a chat in any git repository inside that folder, including ones they add themselves.

Access:

- **Allow users to create projects** lets a person add a folder by cloning a Git URL or starting an empty repository, and lets them set a remote, create and switch branches, and pull or push. A person's own access can still turn this off.
- **Allow project downloads** lets a person download a project as a zip from the start page.

Save folder stores the path, the access switches, and the file-manager visibility. Discard restores the saved values.

File manager visibility chooses what the file list includes. Hidden files, gitignored files, and `.git` stay hidden until you turn them on. Show .git directory shows the Git database, hooks, and logs.

Repository catalog is the list of remotes a person can be granted. Add repository records a name and a Git URL. Remove drops that entry. Granting one, on the person's page, clones it into their repository folder. A checkout that is already there stays available for chats.

## Users

The table lists Linux accounts. Filter by username, UID, or home directory, and filter by role. Copy path copies a home directory. Configure opens that person.

Add a user creates a Linux account when the name is new, or grants access and sets this password when the account already exists. Clear empties the form.

On a person's page, Refresh reloads their record. Save changes stores agents, modes, models, tools, defaults, and repository grants together.

Granted system tools includes each offered agent, plus Terminal, File manager, File editor, Download, Upload, and Projects. A tool that is off for everyone stays off here until the global switch is turned on. For each granted agent, check the modes and models that person may use. Load modes and models on the Agents tab first. Saving keeps only the modes and models checked here.

Default agent, Default model, and Tool approval are that person's starting choices.

Repositories lists the catalog. Check the ones to clone into their folder.

Appearance and terminal theme is their theme, command-block style, chats shown per project, wrap, and read-only file viewer.

Cursor shell command whitelist, when they have Cursor, is the shell commands Cursor may run for them. Saving changes this person only. Apply to all users, or Apply to this user, on the Agents tab replaces this list when it includes them.

Environment is values in their `~/.env` file. Add variable appends a row. Remove drops one. HOME, PATH, and loader variables are left alone when an agent starts. Save environment writes the file.

Git identity is their global git name and email. It does not rename the Linux account.

Recent user conversations lists what this person asked, with the agent's replies. Open a row to read that thread.

For someone other than yourself, Security and password sets a new password. Danger zone removes the Linux account and leaves their home directory in place. Remove account asks you to confirm.
