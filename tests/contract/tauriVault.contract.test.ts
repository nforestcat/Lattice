import { vi } from "vitest";
import { describeVaultContract, describeGitContract, describeAiContract, describeReviewContract } from "./vaultApiContract";

const archives = new Map<string, string>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const demoVault = {
      notes: [{ path: "Welcome.md", title: "Welcome", modifiedAt: "2026-01-01" }],
      folders: [],
    };
    const mutation = (path: string) => ({ vault: demoVault, selectedPath: path });

    const handlers: Record<string, () => unknown> = {
      open_vault: () => demoVault,
      read_note: () => ({ path: args?.path, content: (archives.get(`note:${args?.path}`) ?? "# Welcome\n"), revision: "r1" }),
      save_note: () => {
        archives.set(`note:${args?.path}`, args?.content as string);
        return { revision: "r2", conflictDetected: false };
      },
      create_note: () => mutation(`${args?.parentPath ?? ""}/${args?.title}.md`.replace(/^\//, "")),
      create_folder: () => mutation(`${args?.parentPath ?? ""}/${args?.name}`.replace(/^\//, "")),
      rename_entry: () => mutation(args?.newName as string),
      delete_entry: () => mutation(""),
      capture_to_inbox: () => mutation("Inbox.md"),
      get_inbox_captures: () => [],
      mark_inbox_capture_processed: () => mutation("Inbox.md"),
      promote_inbox_capture: () => mutation("Promoted.md"),
      append_inbox_capture: () => mutation("Inbox.md"),
      get_context_bundle: () => ({ entries: [], links: [] }),
      get_context_bundle_candidates: () => [],
      search_notes: () => [],
      get_note_context: () => ({ backlinks: [], forwardLinks: [] }),
      get_graph: () => ({ nodes: [], edges: [] }),
      create_graph_link: () => ({ success: true }),
      delete_managed_graph_link: () => ({ success: true }),
      list_snapshots: () => [],
      restore_snapshot: () => ({ revision: "r1", conflictDetected: false }),
      get_vault_config: () => ({ autoGit: false }),
      save_vault_config: () => undefined,
      load_embeddings_cache: () => "{}",
      save_embeddings_cache: () => undefined,
      load_embeddings_status: () => "{}",
      save_embeddings_status: () => undefined,
      get_unresolved_links: () => [],
      get_backlink_suggestions: () => [],
      apply_backlink_suggestion: () => undefined,
      apply_note_metadata: () => undefined,
      get_wiki_health_report: () => [],
      // Git
      get_git_status: () => ({ branch: "main", clean: true }),
      set_auto_git: () => ({ autoGit: true }),
      get_git_changes: () => [],
      get_git_diff: () => "",
      git_stage_all: () => undefined,
      git_stage_file: () => undefined,
      git_unstage_file: () => undefined,
      git_commit: () => "abc123",
      git_pull: () => "Already up to date",
      git_push: () => "ok",
      suggest_commit_message: () => "chore: update",
      git_pull_preflight: () => ({ behind: 0, ahead: 0 }),
      git_stash_push: () => "stash@{0}",
      git_stash_pop: () => ({ success: true }),
      git_stash_drop: () => "Dropped stash",
      git_merge_head_exists: () => false,
      // AI
      archive_prompt_run: () => { archives.set(args?.runId as string, args?.content as string); return args?.runId; },
      get_archived_prompt: () => archives.get(args?.runId as string) ?? "",
      delete_archived_prompt: () => { archives.delete(args?.runId as string); },
      prune_archived_prompts: () => undefined,
      get_archive_status: () => ({ fileCount: 0, totalBytes: 0 }),
      save_api_key: () => undefined,
      get_api_key: () => "",
      fetch_provider_models: () => [],
      parse_proposed_edits: () => [],
      // Review
      append_ai_audit: () => undefined,
      persist_review_decisions: () => undefined,
    };

    const handler = handlers[cmd];
    if (!handler) return Promise.reject(new Error(`Unknown command: ${cmd}`));
    return Promise.resolve(handler());
  }),
}));

import { createTauriVaultApi } from "../../src/api/tauriVault";

describeVaultContract("tauri", createTauriVaultApi);
describeGitContract("tauri", createTauriVaultApi);
describeAiContract("tauri", createTauriVaultApi);
describeReviewContract("tauri", createTauriVaultApi);
