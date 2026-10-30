# Files

Files, on a project's start page or on a chat, opens the file list for that folder. Collapse file manager closes it. On a narrow screen, Files in the top bar does the same, and a second Files / Editor control swaps the list and the open file.

The header shows the project name, the branch, and whether you can edit. Editor means saves are allowed. Read-only means the administrator or your Customize setting keeps the file for viewing. Read-only view means you switched this file to Locked for the moment.

Hidden files, gitignored files, and the `.git` directory stay out of the list unless an administrator turns those on.

## All Files

All Files is the tree. Filter files narrows it by name. Refresh files reloads the tree.

When the file editor is on:

- **New file** and **New folder** ask for a path, such as `src/example.ts`.
- Select a file or folder, then the rename or delete button beside the filter. Confirm a delete before it runs.

**Upload** adds files from your computer into the selected folder, or into the project root when no folder is selected. It is available when upload is on and the read-only file viewer is off. **Download** saves the selected file to your computer when download is on.

Expand across chat window widens the file pane over the chat. Restore split view puts the chat back beside it.

## Editor

Choose a file to open it. Save writes it. Ctrl+S is the same action. Discard throws away edits that are not saved yet. A dot beside the path means the file has unsaved edits.

Editable and Locked switch this file between editing and a read-only view. File and Diff appear when the file has a previous version to compare. On a markdown file, Preview renders it and Source returns to the text.

A truncated file opens for reading. Closing a file with unsaved edits asks you to confirm.

## Changed

Changed lists git changes. The badge is the count.

- **Changes** are unstaged. Stage all changes marks them for the next commit. Discard all changes reverts them. Each row has the same actions for that file.
- **Staged Changes** are ready to commit. Unstage all changes moves them back.

Choose a row to open its diff. Open file on that row opens the file itself.

Type a message and choose Commit. The button waits until the message is filled in and there is something to commit. If nothing is staged yet, Commit asks to stage the changes and then commit them. Unsaved edits in the editor stay out of the commit. If the open file still has unsaved edits, Commit asks you to confirm before it records the saved files.

A clean tree says Working tree is clean.

## Search

Search looks through file contents in this project. The options beside the box are Match case, Use regular expression, and Match whole word. Results group by file. Choose a line to open that file at the match. The badge counts matches, and a plus means the list was cut short.
