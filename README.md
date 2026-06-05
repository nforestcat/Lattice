# Lattice

Lattice is a local-first wiki for LLM-maintained knowledge.

It started as an Obsidian-style desktop notes app, but the current goal is more specific: help a local Markdown vault become a useful, inspectable context layer for LLM work.

## Current Status

This is an early v1 desktop app built with Tauri 2, React, TypeScript, Vite, and Rust.

Implemented so far:

- Open a local Markdown vault folder
- Browse notes in a folder tree
- Create, rename, and delete notes/folders with desktop-safe confirmation dialogs
- Edit Markdown with CodeMirror
- View rendered Markdown preview beside the editor, including styled inline code and fenced code blocks with language badges and premium syntax highlighting (powered by `highlight.js`)
- Parse wiki links, backlinks, outgoing links, tags, and frontmatter
- View and edit note relationships in a graph
- Generate LLM context bundles from selected related notes (with Short/Standard/Full modes, Purpose instructions, and tailored task presets like Ask, Refactor, Summarize, Plan, Debug)
- Recommend related notes beyond explicit wiki links with relevance scores, matching reasons, and body excerpts (by shared tags or unlinked mentions), with options to sort and filter candidates in the UI by score, title, or connection type
- Persist custom context bundle selections, presets, purposes, modes, and limits across note visits using a type-safe, versioned vault-local configuration file (`.lattice/config.json`) with an automated config migration layer in both TypeScript and Rust to normalize and upgrade legacy files while preserving valid fields from partially malformed configs
- Estimate token consumption, track context window budget with model-agnostic size presets (Small 8K, Medium 32K, Large 128K, Huge 200K, or Custom), display the final bundle actual token count with a visual progress bar, and offer automated pruning of recommended candidates (sorted by score) matching the actual generated bundle token limit
- Draft, preview, copy, and log final combined LLM prompts containing custom instructions and context bundles within the integrated **Prompt Workspace** (with prompt drafts persisted per note, prompt copy events recorded in a local-first **Prompt History** timeline featuring text search, active note toggles, preset dropdown filters, collapsible card previews displaying SHA-256 hash/included notes details, and an interactive **History Diff** view comparing stored vs current prompt configurations, with prompt copies retrieved from a dedicated **Full Prompt Archive** folder `.lattice/runs/<run_id>.md` that is excluded from vault note scanning, archive status/delete/prune controls, and built-in/custom **Prompt Templates** with placeholders like `{active_note}`, `{selected_notes}`, `{date}`, and `{vault_name}` resolving dynamically on selection)
- Audit context bundles via the **Bundle Audit & Diff** view to inspect exactly why each note was included (connection reason), view heuristic quality badges (Useful, Redundant, Too Large, Stale), and trace differences (added/removed notes, token size delta) from the previous generation
- Distill raw LLM conversations, inbox captures, or meeting notes into reviewable proposed wiki edits (`create`, `update`, `merge`, `delete`) that can be edited inline and applied with confirmation
- Fast and optimized production bundling using Vite code-splitting manual chunks, isolating heavy dependencies (React Flow, CodeMirror, highlight.js, marked) to minimize main JS entry bundle size below 62 KB
- Detect selected Obsidian vault metadata from `.obsidian` settings and import compatible appearance/readability hints such as readable line length, theme, accent color, enabled core plugin names, attachment folder path, enabled CSS snippets list, and custom hotkeys
- Capture loose ideas or LLM answers into daily Inbox notes
- Triage Inbox captures (into new notes, append to existing notes, or mark processed)
- Create snapshots and optionally auto-commit saves in existing Git vaults
- Chat with an integrated LLM Copilot in the Distill Workspace (supporting Ollama, OpenAI, Gemini, and Anthropic), with active context bundle auto-injection and streaming responses containing structured proposed edits that instantly populate the pending edit checklist
- Compute semantic note recommendations using vector embeddings (Ollama or OpenAI/Custom OpenAI-compatible) and store them in a persistent local cache file (`.lattice/embeddings.json`) to minimize API requests and save overhead on subsequent note selections
- Automatically scan the active editor note for unlinked mentions of other note titles (supporting CJK languages via Unicode property boundary matching) and suggest turning them into `[[Wiki Links]]` with a one-click apply button
- Toggle search mode in the sidebar between traditional Keyword search and AI-powered **Semantic Search** to query the entire vault using natural language and rank results by vector embedding similarity scores (with custom match percentage badges)
- Export and import prompt history runs (including both metadata and full prompt markdown contents) as a single portable JSON archive file
- Configure age-based prompt run retention policies (7, 30, or 90 days) inside the Settings panel to automatically prune expired history runs in the background on startup or trigger them manually on demand

## LLM Wiki Direction

Lattice is not trying to clone every Obsidian feature.

The main product direction is:

- Capture useful LLM conversation fragments into a local wiki
- Promote rough captures into durable notes
- Distill raw context into reviewable wiki edits before applying changes
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

Markdown files are the source of truth. Generated indexes, graph data, and context bundles are rebuildable from the vault. Lattice-owned `.lattice` internals are kept out of the visible note index.

## Next Ideas

- Add export/import controls for archived prompt runs before direct LLM API integration
- Add deeper archive retention settings for automatically pruning old prompt runs

## License

MIT
