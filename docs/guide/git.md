# Git

The branch you are on shows under the composer and in the file list when the folder is a git repository. Creating a repository, setting a remote, adding a branch, and pull or push are available when your account is allowed to create projects.

## On the composer

When the folder is already a repository, the branch menu sits under the composer. Choose another branch to switch. The menu stays disabled while a reply is running, and when there is only one branch. The button beside the menu copies the branch name.

When the folder is not a repository and your account can create projects, Create repo appears above the composer. It initializes git in that folder.

## On the start page

When creating projects is allowed, the Repository section is under the composer.

- **Remote URL** and **Save remote** set the remote. Save remote is available after the URL changes.
- **Branch** switches to a branch that already exists. If the checkout is detached, the note says to check out a branch first.
- **New branch** and **Create branch** add a branch from the current checkout and switch to it.
- **Pull** and **Push** use the saved remote. Both stay disabled until a remote is set and a branch is checked out.

A short status line under the buttons confirms the last of these actions.

## Commits

Open Files, then Changed. That tab lists staged and unstaged files. The commit box is covered in the Files chapter. Your git name and email, in the account menu, are what those commits record.
