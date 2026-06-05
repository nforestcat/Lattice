# Lattice

Lattice is an experimental local-first Markdown wiki for working with LLMs.

It started as an Obsidian-style desktop notes app, but the current goal is more specific: help a local Markdown vault become a useful, inspectable context layer for LLM work.

## Current Status

This is an early v1 desktop app built with Tauri 2, React, TypeScript, Vite, and Rust.

Implemented so far:

- Open a local Markdown vault folder
- Browse notes in a folder tree
- Create, rename, and delete notes/folders
- Edit Markdown with CodeMirror
- View rendered Markdown preview beside the editor, including styled inline code and fenced code blocks with language badges and premium syntax highlighting (powered by `highlight.js`)
- Parse wiki links, backlinks, outgoing links, tags, and frontmatter
- View and edit note relationships in a graph
- Generate LLM context bundles from selected related notes (with Short/Standard/Full modes, Purpose instructions, and tailored task presets like Ask, Refactor, Summarize, Plan, Debug)
- Recommend related notes beyond explicit wiki links with relevance scores, matching reasons, and body excerpts (by shared tags or unlinked mentions), with options to sort and filter candidates in the UI by score, title, or connection type
- Persist custom context bundle selections, presets, purposes, modes, and limits across note visits using a type-safe, versioned vault-local configuration file (`.lattice/config.json`)
- Estimate token consumption, track context window budget with model-agnostic size presets (Small 8K, Medium 32K, Large 128K, Huge 200K, or Custom), display the final bundle actual token count with a visual progress bar, and offer automated pruning of recommended candidates (sorted by score) matching the actual generated bundle token limit
- Draft, preview, copy, and log final combined LLM prompts containing custom instructions and context bundles within the integrated **Prompt Workspace** (with prompt drafts persisted per note, prompt copy events recorded in a local-first **Prompt History** timeline, and built-in/custom **Prompt Templates** like Code Review or Summarize available for quick injection)
- Audit context bundles via the **Bundle Audit & Diff** view to inspect exactly why each note was included (connection reason) and trace differences (added/removed notes, token size delta) from the previous generation
- Detect selected Obsidian vault metadata from `.obsidian` settings and import compatible appearance/readability hints such as readable line length, theme, accent color, enabled core plugin names, attachment folder path, enabled CSS snippets list, and custom hotkeys
- Capture loose ideas or LLM answers into daily Inbox notes
- Triage Inbox captures (into new notes, append to existing notes, or mark processed)
- Create snapshots and optionally auto-commit saves in existing Git vaults

## LLM Wiki Direction

Lattice is not trying to clone every Obsidian feature.

The main product direction is:

- Capture useful LLM conversation fragments into a local wiki
- Promote rough captures into durable notes
- Build high-quality context bundles from local notes
- Help discover related notes that are not linked yet
- Keep Markdown files as the source of truth

## Development

Install dependencies:

```bash
npm install
```

Run the web dev server:

```bash
npm run dev
```

Run the Tauri desktop app:

```bash
npm run dev:tauri
```

Run tests:

```bash
npm test
```

Build the frontend:

```bash
npm run build
```

Build the desktop app:

```bash
npm run build:tauri
```

On Windows, if Rust commands are not found after installation, make sure Cargo is on PATH:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```

## Architecture

- `src/core`: Markdown parsing, indexing, context bundle, capture logic
- `src/api`: shared frontend API types plus mock/Tauri adapters
- `src/ui`: React app UI
- `src-tauri`: Rust backend and Tauri commands
- `tests`: Vitest coverage for core behavior and UI smoke tests

Markdown files are the source of truth. Generated indexes, graph data, and context bundles are rebuildable from the vault.

## Next Ideas

- Add reusable prompt templates and exportable prompt runs before direct LLM API integration

## License

MIT
