# Markdown Tasks

An Obsidian plugin for managing tasks as Markdown notes, organized into ordered chains.

## Features

- **Tasks as notes**: a note is a task when its frontmatter matches a configurable key and value (default `type: task`). New tasks can be created from a template into a chosen folder.
- **Chains**: ordered sequences of task notes. A note can belong to several chains, and each chain tracks position and status (`ready`, `current`, `done`) in frontmatter.
- **Chain bar**: a status bar strip showing the active chain as filenames or dots, with drag support.
- **Chain view**: a side panel for browsing and reordering a chain.
- **Linear integration** (optional): import issues from Linear workspaces as notes and sync status in both directions. Requires a Linear API key, set in settings; nothing is sent to Linear unless you configure it.

## Commands

- **New task**, **New item for chain…**
- **Add to chain…**, **Remove active file from chain…**, **Auto-populate chains…**
- **Set as current task**, **Advance chain**, **Reconcile chain statuses**
- **Open chain view**, **Toggle chain bar**
- **Check if current file is a task file**
- **Open linear panel**, **Linear: sync all linked notes**, **Linear: push status of active note**

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # production build
```

Release artifacts: `main.js`, `manifest.json`, `styles.css`.
