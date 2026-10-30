# Chats

A chat is one conversation with one agent, in one project. The agent is chosen when the chat starts. Mode and model can be changed later.

## Starting

On the project's start page, choose an agent when more than one is available, then a mode and a model. The box placeholder is What do you want to build? Write a prompt and send. The chat opens with that first message.

If Pi is offered and still needs installing for this account, Set up Pi appears above the composer. Choose it, then start the chat once it reports that Pi is ready.

When no agents are available, the composer says so and send stays disabled.

## Composer

The composer is the box at the bottom of a chat, and the large box on the start page.

- **Mode** and **Model** are the menus in the composer. On an open chat, changing them applies to the next prompt.
- **Attach files** adds files from your computer. You can also drop files on the box, or paste them. Each name appears above the prompt. The × on a name removes it.
- **Send** submits the prompt. Enter sends. Shift+Enter starts a new line.
- **Stop** replaces Send while a reply is running and the box is empty.

An unsent prompt stays in the box for that project start page, or for that chat, until you send it.

## While a reply is running

The reply streams into the transcript. You can send a follow-up before it finishes. Those messages wait in a queue above the composer. Edit puts one back in the box. Remove drops it.

When the agent asks to use a tool, a prompt appears above the composer with the choices the agent offered. Pick one to allow or reject that action. Customize sets whether those requests ask every time, allow edits and ask for the rest, or allow everything.

## Transcript

- Your messages sit on one side, with any attached files. Images show a preview. Other files show their names.
- The agent's reply is markdown. Copy, under the reply, copies that text.
- **Thinking** is a disclosure the agent may open while it is working.
- Tool commands appear as blocks. Customize chooses whether those blocks look like a prompt or a window. A diff inside a block shows the lines the tool changed.
- A plan, when the agent sends one, is a checklist under the chat title. Completed steps are checked.
- The grip above the title shows or hides the chat details. On a narrow screen, drag that bar to resize it.
- A file path in a reply can be opened in the file pane when the file manager is on.

Shell, when the agent reports shell output separately, expands that log.

Terminal, on the chat title bar, switches the transcript for a shell. Chat switches back. That button is present when the terminal is on, and it stays disabled while a reply is running.
