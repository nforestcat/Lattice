# Lattice

Lattice is a local-first desktop wiki for people who use LLMs as part of their thinking and writing workflow.

It turns a folder of Markdown notes into an inspectable context layer: notes stay on disk, links stay readable, and every AI-assisted change is meant to be reviewed before it becomes part of the vault.

## Why It Exists

Most LLM workflows produce useful fragments that are easy to lose: answers, plans, debugging notes, meeting summaries, research trails, and half-formed ideas. Lattice helps move those fragments into a durable Markdown wiki, then helps assemble the right notes back into focused prompts when you need to work with an LLM again.

Lattice is not trying to clone every Obsidian feature. The product direction is narrower:

- Keep Markdown files as the source of truth.
- Capture loose LLM output into an inbox.
- Distill raw context into reviewable wiki edits.
- Build high-quality context bundles from related notes.
- Surface missing, stale, orphaned, duplicated, or weakly linked notes.
- Make Git-backed vault changes visible before they are committed or synced.

## Current Status

This is an early v1 app built with Tauri 2, React, TypeScript, Vite, and Rust.

The app currently supports:

- Opening a local Markdown vault and browsing it as a folder tree.
- Creating, renaming, deleting, editing, and previewing Markdown notes.
- Parsing wiki links, backlinks, outgoing links, tags, and frontmatter.
- Viewing note relationships in structural and semantic graph views.
- Generating LLM context bundles with presets, purpose instructions, token budgets, pruning, and bundle audit details.
- Drafting final prompts in a Prompt Workspace, with per-note drafts, templates, copy history, archived full prompts, retention controls, export/import, and diff views.
- Distilling raw captures, conversations, meeting notes, URLs, and PDFs into reviewable proposed wiki edits.
- Using an integrated LLM Copilot for chat, distillation, dead-link stub drafting, and metadata suggestions.
- Recommending related notes through wiki links, shared tags, unlinked mentions, backlinks, semantic similarity, and CJK-aware title matching.
- Running semantic search and semantic graph filtering through cached embeddings.
- Auditing vault health for orphan notes, stale notes, broad notes, duplicate content, missing summaries, weak backlinks, unresolved links, and backlink opportunities.
- Reviewing Git changes inside the app, including staged and unstaged diffs, stage/unstage actions, commit validation, pull/push controls, snapshots, auto-commit support, and merge-conflict guards.
- Detecting compatible Obsidian vault metadata and applying appearance/readability hints where possible.
- Storing LLM API keys through the operating system keyring when available, with backend-routed provider calls to avoid browser-side API headers.

## Getting Started

Install JavaScript dependencies:

```bash
npm install
```

Run the browser development app:

```bash
npm run dev
```

Run the desktop app:

```bash
npm run dev:tauri
```

Run the TypeScript and frontend build:

```bash
npm run build
```

Build the desktop app:

```bash
npm run build:tauri
```

## Tests

Run the Vitest suite:

```bash
npm test
```

Run the Rust backend tests:

```bash
cd src-tauri
cargo test
```

On Windows, if Rust commands are not available after installing Rust, make sure Cargo is on `PATH`:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```

## Project Layout

- `src/core`: Markdown parsing, vault indexing, context bundles, capture parsing, ingest helpers, and provenance logic.
- `src/api`: Shared frontend API types plus mock and Tauri adapters.
- `src/ui`: React UI, hooks, workspaces, panels, graph views, editor flows, and prompt/history surfaces.
- `src-tauri`: Rust backend commands for vault files, config, Git, ingest, LLM calls, embeddings, key storage, and desktop integration.
- `tests`: Vitest coverage for core behavior and UI smoke tests.

## Local Data Model

The vault's Markdown files are the durable source of truth. Lattice-owned runtime files live under `.lattice/` inside the selected vault and are excluded from normal note scanning.

Common generated files include:

- `.lattice/config.json`: versioned vault-local preferences and context bundle settings.
- `.lattice/embeddings.json`: cached semantic embeddings.
- `.lattice/runs/<run_id>.md`: archived full prompt copies.

Indexes, graphs, recommendations, context bundles, and health reports are rebuildable from the vault plus these local cache/config files.

## Development Notes

- The web app can run against mock/demo vault behavior.
- The desktop app uses Tauri commands for filesystem, Git, keyring, ingest, LLM, and embedding operations.
- Heavy frontend dependencies are split into Vite manual chunks to keep the main entry bundle small.
- Git conflict safety is enforced in both the Rust backend and the React UI before risky operations such as commit, pull, push, or auto-commit.

## Roadmap

- Improve local/offline embedding setup and model management.
- Deepen review workflows for proposed wiki edits.
- Expand multi-device sync and conflict-resolution support for Git-backed vaults.
- Keep tightening the boundary between generated cache data and user-owned Markdown.

## License

MIT
