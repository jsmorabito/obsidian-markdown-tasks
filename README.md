# Markdown Tasks

An Obsidian plugin for managing tasks as Markdown notes, organized into ordered chains.

## Features

- **Tasks as notes**: a note is a task when its frontmatter matches a configurable key and value (default `type: task`). New tasks can be created from a template into a chosen folder.
- **Chains**: ordered sequences of task notes. A note can belong to several chains, and each chain tracks position and status (`ready`, `current`, `done`) in frontmatter.
- **Chain bar**: a status bar strip showing the active chain as filenames or dots, with drag support.
- **Chain view**: a side panel for browsing and reordering a chain.
- **Linear integration** (optional): import issues, projects and initiatives from Linear workspaces as notes, sync status in both directions, and show links to them as pills with a status icon. Connect a workspace by signing in with Linear in your browser (OAuth with PKCE, using your own Linear OAuth app's client ID) or with a personal API key; nothing is sent to Linear unless you configure it.
- **Task app integration** (optional): import issues from your self-hosted Task App as notes, and show links to them as pills with a status icon (the same look as the Note Types plugin's styled links). Talks only to the server URL you set, through its `/mcp` endpoint with the server's `API_TOKEN`; nothing is sent unless you configure it.

## Commands

- **New task**, **New item for chain…**
- **Add to chain…**, **Remove active file from chain…**, **Auto-populate chains…**
- **Set as current task**, **Advance chain**, **Reconcile chain statuses**
- **Open chain view**, **Toggle chain bar**
- **Check if current file is a task file**
- **Open linear panel**, **Linear: sync all linked notes**, **Linear: push status of active note**
- **Linear: import issue, project, or initiative**, **Linear: insert link to issue, project, or initiative**, **Linear: open active note in browser**
- **Task app: import issue**, **Task app: insert link to issue**, **Task app: refresh imported issues**, **Task app: open issue in browser**

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # production build
```

Release artifacts: `main.js`, `manifest.json`, `styles.css`.
