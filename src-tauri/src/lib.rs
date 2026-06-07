use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use walkdir::WalkDir;

#[derive(Default)]
struct AppState {
    inner: Mutex<VaultState>,
}

#[derive(Default)]
struct VaultState {
    root_path: Option<PathBuf>,
    notes: Vec<ParsedNote>,
    snapshots: Vec<SnapshotRecord>,
    snapshot_content: HashMap<String, String>,
    auto_git_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteMeta {
    path: String,
    title: String,
    tags: Vec<String>,
    frontmatter: HashMap<String, String>,
    modified_at: Option<String>,
    content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteLink {
    source_path: String,
    target_ref: String,
    resolved_path: Option<String>,
    line: usize,
    is_managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedNote {
    #[serde(flatten)]
    meta: NoteMeta,
    content: String,
    links: Vec<NoteLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileTreeNode {
    name: String,
    path: String,
    kind: String,
    children: Vec<FileTreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultSnapshot {
    root_path: String,
    notes: Vec<NoteMeta>,
    tree: Vec<FileTreeNode>,
    obsidian_settings: Option<ObsidianSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ObsidianSettings {
    detected: bool,
    readable_line_length: Option<bool>,
    theme: Option<String>,
    accent_color: Option<String>,
    enabled_core_plugins: Vec<String>,
    attachment_folder_path: Option<String>,
    css_snippets: Vec<String>,
    hotkeys: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteDocument {
    path: String,
    content: String,
    revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    saved: bool,
    revision: String,
    conflict: bool,
    snapshot_id: Option<String>,
    git_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFilters {
    query: String,
    tags: Option<Vec<String>>,
    frontmatter: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteContext {
    note: ParsedNote,
    backlinks: Vec<NoteLink>,
    outgoing_links: Vec<NoteLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphNode {
    id: String,
    label: String,
    tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphEdge {
    id: String,
    source: String,
    target: String,
    is_managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphData {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    focused_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkMutationResult {
    note: NoteDocument,
    graph: GraphData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryMutationResult {
    vault: VaultSnapshot,
    selected_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureInput {
    content: String,
    related_path: Option<String>,
    captured_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxCaptureBlock {
    id: String,
    title: String,
    related_title: Option<String>,
    body: String,
    markdown: String,
}

#[derive(Debug, Clone)]
struct InboxCaptureSpan {
    capture: InboxCaptureBlock,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromoteInboxCaptureInput {
    inbox_path: String,
    capture_id: String,
    title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendInboxCaptureInput {
    inbox_path: String,
    capture_id: String,
    target_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextBundle {
    title: String,
    focus_path: String,
    note_paths: Vec<String>,
    markdown: String,
    estimated_tokens: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ContextBundleOptions {
    selected_paths: Option<Vec<String>>,
    purpose: Option<String>,
    mode: Option<String>,
    preset: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextBundleCandidate {
    path: String,
    title: String,
    reason: String,
    reason_detail: String,
    score: f64,
    excerpt: String,
    token_estimate: usize,
    selected: bool,
    character_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRecord {
    id: String,
    path: String,
    created_at: String,
    reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStatus {
    is_repo: bool,
    auto_git_enabled: bool,
    branch: Option<String>,
    has_changes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitSettings {
    auto_git_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptRun {
    id: String,
    question: String,
    selected_notes: Vec<String>,
    preset: String,
    #[serde(default)]
    purpose: Option<String>,
    mode: String,
    token_count: usize,
    created_at: String,
    active_path: String,
    prompt_hash: Option<String>,
    preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptTemplate {
    id: String,
    name: String,
    template: String,
    is_system: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LlmConfig {
    provider: String,
    api_key: String,
    model: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    embedding_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct VaultConfig {
    #[serde(default)]
    version: Option<usize>,
    #[serde(default)]
    context_limit: Option<usize>,
    #[serde(default)]
    bundle_preset: Option<String>,
    #[serde(default)]
    bundle_purpose: Option<String>,
    #[serde(default)]
    bundle_mode: Option<String>,
    #[serde(default)]
    selected_paths: Option<HashMap<String, Vec<String>>>,
    #[serde(default)]
    prompt_instructions: Option<HashMap<String, String>>,
    #[serde(default)]
    prompt_runs: Option<Vec<PromptRun>>,
    #[serde(default)]
    prompt_templates: Option<Vec<PromptTemplate>>,
    #[serde(default)]
    llm_config: Option<LlmConfig>,
}

#[tauri::command]
fn open_vault(path: String, state: tauri::State<AppState>) -> Result<VaultSnapshot, String> {
    let root = PathBuf::from(path);
    let notes = scan_vault(&root)?;
    let tree = build_tree(&notes);
    let metas = notes.iter().map(|note| note.meta.clone()).collect();
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    guard.root_path = Some(root.clone());
    guard.notes = resolve_links(notes);
    Ok(VaultSnapshot {
        root_path: root.to_string_lossy().to_string(),
        notes: metas,
        tree,
        obsidian_settings: read_obsidian_settings(&root),
    })
}

#[tauri::command]
fn read_note(path: String, state: tauri::State<AppState>) -> Result<NoteDocument, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let content = fs::read_to_string(root.join(&path)).map_err(|error| error.to_string())?;
    Ok(NoteDocument {
        path,
        revision: revision_of(&content),
        content,
    })
}

#[tauri::command]
fn save_note(path: String, content: String, base_revision: String, state: tauri::State<AppState>) -> Result<SaveResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let full_path = root.join(&path);
    let current = fs::read_to_string(&full_path).map_err(|error| error.to_string())?;
    let current_revision = revision_of(&current);
    if !base_revision.is_empty() && base_revision != current_revision {
        let snapshot_id = snapshot(&mut guard, &path, &current, "conflict");
        return Ok(SaveResult {
            saved: false,
            revision: current_revision,
            conflict: true,
            snapshot_id: Some(snapshot_id),
            git_commit: None,
        });
    }

    let snapshot_id = snapshot(&mut guard, &path, &current, "save");
    fs::write(&full_path, &content).map_err(|error| error.to_string())?;
    guard.notes = resolve_links(scan_vault(&root)?);
    let git_commit = if guard.auto_git_enabled { auto_commit(&root, &path).ok() } else { None };
    Ok(SaveResult {
        saved: true,
        revision: revision_of(&content),
        conflict: false,
        snapshot_id: Some(snapshot_id),
        git_commit,
    })
}

#[tauri::command]
fn create_note(parent_path: Option<String>, title: String, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let clean_title = clean_entry_name(&title)?;
    let parent = parent_path.unwrap_or_default();
    let path = unique_note_path(&parent, &clean_title, &guard.notes);
    let full_path = resolve_vault_path(&root, &path)?;
    if let Some(parent_dir) = full_path.parent() {
        fs::create_dir_all(parent_dir).map_err(|error| error.to_string())?;
    }
    fs::write(&full_path, format!("# {}\n", clean_title)).map_err(|error| error.to_string())?;
    guard.notes = resolve_links(scan_vault(&root)?);
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(path),
    })
}

#[tauri::command]
fn create_folder(parent_path: Option<String>, name: String, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let clean_name = clean_entry_name(&name)?;
    let folder_path = join_vault_path(parent_path.as_deref().unwrap_or(""), &clean_name);
    let full_path = resolve_vault_path(&root, &folder_path)?;
    if full_path.exists() {
        return Err(format!("Entry already exists: {}", folder_path));
    }
    fs::create_dir_all(&full_path).map_err(|error| error.to_string())?;
    guard.notes = resolve_links(scan_vault(&root)?);
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(folder_path),
    })
}

#[tauri::command]
fn rename_entry(path: String, new_name: String, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let clean_name = clean_entry_name(&new_name)?;
    let from = resolve_vault_path(&root, &path)?;
    if !from.exists() {
        return Err(format!("Entry not found: {}", path));
    }
    let is_note = path.to_lowercase().ends_with(".md");
    let parent = parent_path(&path);
    let target_name = if is_note { format!("{}.md", clean_name) } else { clean_name };
    let to_path = join_vault_path(parent.as_deref().unwrap_or(""), &target_name);
    let to = resolve_vault_path(&root, &to_path)?;
    if to.exists() {
        return Err(format!("Entry already exists: {}", to_path));
    }
    fs::rename(&from, &to).map_err(|error| error.to_string())?;
    guard.notes = resolve_links(scan_vault(&root)?);
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(to_path),
    })
}

#[tauri::command]
fn delete_entry(path: String, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let target = resolve_vault_path(&root, &path)?;
    if target.is_dir() {
        let mut entries = fs::read_dir(&target).map_err(|error| error.to_string())?;
        if entries.next().is_some() {
            return Err("Folder is not empty".to_string());
        }
        fs::remove_dir(&target).map_err(|error| error.to_string())?;
    } else if target.is_file() {
        let content = fs::read_to_string(&target).unwrap_or_default();
        snapshot(&mut guard, &path, &content, "delete");
        fs::remove_file(&target).map_err(|error| error.to_string())?;
    } else {
        return Err(format!("Entry not found: {}", path));
    }
    guard.notes = resolve_links(scan_vault(&root)?);
    let selected_path = guard.notes.first().map(|note| note.meta.path.clone());
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path,
    })
}

#[tauri::command]
fn capture_to_inbox(input: CaptureInput, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let captured_at = input.captured_at.unwrap_or_else(|| Utc::now().to_rfc3339());
    let path = inbox_path_for_capture(&captured_at)?;
    let related_title = input
        .related_path
        .as_ref()
        .and_then(|path| guard.notes.iter().find(|note| note.meta.path == *path))
        .map(|note| note.meta.title.as_str());
    let capture = format_inbox_capture(&input.content, related_title, &captured_at)?;
    let full_path = resolve_vault_path(&root, &path)?;
    if let Some(parent_dir) = full_path.parent() {
        fs::create_dir_all(parent_dir).map_err(|error| error.to_string())?;
    }
    if full_path.exists() {
        let current = fs::read_to_string(&full_path).unwrap_or_default();
        fs::write(&full_path, format!("{}\n\n{}", current.trim_end(), capture)).map_err(|error| error.to_string())?;
    } else {
        let title = path.trim_start_matches("Inbox/").trim_end_matches(".md");
        fs::write(&full_path, format!("# {}\n\n{}", title, capture)).map_err(|error| error.to_string())?;
    }
    guard.notes = resolve_links(scan_vault(&root)?);
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(path),
    })
}

#[tauri::command]
fn get_inbox_captures(inbox_path: String, state: tauri::State<AppState>) -> Result<Vec<InboxCaptureBlock>, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let full_path = resolve_vault_path(&root, &inbox_path)?;
    let content = fs::read_to_string(&full_path).map_err(|error| error.to_string())?;
    Ok(parse_inbox_captures(&content))
}

#[tauri::command]
fn mark_inbox_capture_processed(inbox_path: String, capture_id: String, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let full_path = resolve_vault_path(&root, &inbox_path)?;
    let content = fs::read_to_string(&full_path).map_err(|error| error.to_string())?;
    fs::write(&full_path, move_inbox_capture_to_processed(&content, &capture_id)?).map_err(|error| error.to_string())?;
    guard.notes = resolve_links(scan_vault(&root)?);
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(inbox_path),
    })
}

#[tauri::command]
fn promote_inbox_capture(input: PromoteInboxCaptureInput, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let inbox_full_path = resolve_vault_path(&root, &input.inbox_path)?;
    let inbox_content = fs::read_to_string(&inbox_full_path).map_err(|error| error.to_string())?;
    let capture = parse_inbox_captures(&inbox_content)
        .into_iter()
        .find(|capture| capture.id == input.capture_id)
        .ok_or_else(|| format!("Capture not found: {}", input.capture_id))?;
    let clean_title = clean_entry_name(&input.title)?;
    let note_path = unique_note_path("", &clean_title, &guard.notes);
    let note_full_path = resolve_vault_path(&root, &note_path)?;
    fs::write(&note_full_path, format!("# {}\n\n{}\n", clean_title, capture.body.trim())).map_err(|error| error.to_string())?;
    fs::write(&inbox_full_path, move_inbox_capture_to_processed(&inbox_content, &input.capture_id)?).map_err(|error| error.to_string())?;
    guard.notes = resolve_links(scan_vault(&root)?);
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(note_path),
    })
}

#[tauri::command]
fn append_inbox_capture(input: AppendInboxCaptureInput, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    
    let inbox_full_path = resolve_vault_path(&root, &input.inbox_path)?;
    let inbox_content = fs::read_to_string(&inbox_full_path).map_err(|error| error.to_string())?;
    let capture = parse_inbox_captures(&inbox_content)
        .into_iter()
        .find(|capture| capture.id == input.capture_id)
        .ok_or_else(|| format!("Capture not found: {}", input.capture_id))?;
    
    let target_full_path = resolve_vault_path(&root, &input.target_path)?;
    if !target_full_path.exists() {
        return Err(format!("Target note not found: {}", input.target_path));
    }
    
    let target_content = fs::read_to_string(&target_full_path).map_err(|error| error.to_string())?;
    let separator = if target_content.ends_with("\n\n") {
        ""
    } else if target_content.ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    };
    let append_text = format!("{}### Appended Capture ({})\n\n{}\n", separator, capture.title, capture.body.trim());
    
    fs::write(&target_full_path, format!("{}{}", target_content, append_text)).map_err(|error| error.to_string())?;
    fs::write(&inbox_full_path, move_inbox_capture_to_processed(&inbox_content, &input.capture_id)?).map_err(|error| error.to_string())?;
    
    guard.notes = resolve_links(scan_vault(&root)?);
    if guard.auto_git_enabled {
        let _ = auto_commit(&root, &input.target_path);
        let _ = auto_commit(&root, &input.inbox_path);
    }
    
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(input.target_path),
    })
}

#[tauri::command]
fn get_context_bundle(path: String, options: ContextBundleOptions, state: tauri::State<AppState>) -> Result<ContextBundle, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    create_context_bundle(&guard.notes, &path, options)
}

#[tauri::command]
fn get_context_bundle_candidates(path: String, state: tauri::State<AppState>) -> Result<Vec<ContextBundleCandidate>, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    context_bundle_candidates(&guard.notes, &path)
}

#[tauri::command]
fn search_notes(filters: SearchFilters, state: tauri::State<AppState>) -> Result<Vec<NoteMeta>, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let query = filters.query.to_lowercase();
    let tags = filters.tags.unwrap_or_default();
    let frontmatter = filters.frontmatter.unwrap_or_default();
    Ok(guard
        .notes
        .iter()
        .filter(|note| {
            let text = format!("{}\n{}\n{}", note.meta.path, note.meta.title, note.content).to_lowercase();
            let text_ok = query.is_empty() || text.contains(&query);
            let tags_ok = tags.iter().all(|tag| note.meta.tags.contains(tag));
            let fm_ok = frontmatter.iter().all(|(key, value)| note.meta.frontmatter.get(key) == Some(value));
            text_ok && tags_ok && fm_ok
        })
        .map(|note| note.meta.clone())
        .collect())
}

#[tauri::command]
fn get_note_context(path: String, state: tauri::State<AppState>) -> Result<NoteContext, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    note_context(&guard.notes, &path)
}

#[tauri::command]
fn get_graph(_filters: HashMap<String, serde_json::Value>, state: tauri::State<AppState>) -> Result<GraphData, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    Ok(build_graph(&guard.notes))
}

#[tauri::command]
fn create_graph_link(source_path: String, target_path: String, state: tauri::State<AppState>) -> Result<LinkMutationResult, String> {
    mutate_graph_link(source_path, target_path, true, state)
}

#[tauri::command]
fn delete_managed_graph_link(source_path: String, target_path: String, state: tauri::State<AppState>) -> Result<LinkMutationResult, String> {
    mutate_graph_link(source_path, target_path, false, state)
}

#[tauri::command]
fn list_snapshots(path: String, state: tauri::State<AppState>) -> Result<Vec<SnapshotRecord>, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    Ok(guard.snapshots.iter().filter(|snapshot| snapshot.path == path).cloned().collect())
}

#[tauri::command]
fn restore_snapshot(snapshot_id: String, state: tauri::State<AppState>) -> Result<SaveResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let snapshot = guard.snapshots.iter().find(|candidate| candidate.id == snapshot_id).cloned().ok_or("Snapshot not found")?;
    let content = guard.snapshot_content.get(&snapshot_id).cloned().ok_or("Snapshot content not found")?;
    let target_path = resolve_vault_path(&root, &snapshot.path)?;
    fs::write(target_path, &content).map_err(|error| error.to_string())?;
    guard.notes = resolve_links(scan_vault(&root)?);
    Ok(SaveResult {
        saved: true,
        revision: revision_of(&content),
        conflict: false,
        snapshot_id: Some(snapshot_id),
        git_commit: None,
    })
}

#[tauri::command]
fn get_git_status(state: tauri::State<AppState>) -> Result<GitStatus, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Ok(GitStatus { is_repo: false, auto_git_enabled: false, branch: None, has_changes: false });
    };
    Ok(GitStatus {
        is_repo: root.join(".git").exists(),
        auto_git_enabled: guard.auto_git_enabled,
        branch: git_output(root, &["branch", "--show-current"]).ok(),
        has_changes: git_output(root, &["status", "--porcelain"]).map(|value| !value.trim().is_empty()).unwrap_or(false),
    })
}

#[tauri::command]
fn set_auto_git(enabled: bool, state: tauri::State<AppState>) -> Result<GitSettings, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    guard.auto_git_enabled = enabled;
    Ok(GitSettings { auto_git_enabled: enabled })
}

fn migrate_config(mut config: VaultConfig) -> VaultConfig {
    if config.version.is_none() || config.version.unwrap() < 1 {
        config.version = Some(1);
    }
    if config.context_limit.is_none() {
        config.context_limit = Some(8000);
    }
    if config.bundle_preset.is_none() {
        config.bundle_preset = Some("ask".to_string());
    }
    if config.bundle_mode.is_none() {
        config.bundle_mode = Some("standard".to_string());
    }
    if config.selected_paths.is_none() {
        config.selected_paths = Some(HashMap::new());
    }
    if config.prompt_instructions.is_none() {
        config.prompt_instructions = Some(HashMap::new());
    }
    if config.prompt_runs.is_none() {
        config.prompt_runs = Some(Vec::new());
    }
    if config.prompt_templates.is_none() {
        config.prompt_templates = Some(Vec::new());
    }
    config
}

fn vault_config_from_json(content: &str) -> VaultConfig {
    let value: serde_json::Value = match serde_json::from_str(content) {
        Ok(value) => value,
        Err(_) => return VaultConfig::default(),
    };
    let Some(object) = value.as_object() else {
        return VaultConfig::default();
    };

    VaultConfig {
        version: object.get("version").and_then(serde_json::Value::as_u64).map(|value| value as usize),
        context_limit: object.get("contextLimit").and_then(serde_json::Value::as_u64).map(|value| value as usize),
        bundle_preset: object.get("bundlePreset").and_then(serde_json::Value::as_str).map(str::to_string),
        bundle_purpose: object.get("bundlePurpose").and_then(serde_json::Value::as_str).map(str::to_string),
        bundle_mode: object.get("bundleMode").and_then(serde_json::Value::as_str).map(str::to_string),
        selected_paths: object.get("selectedPaths").and_then(string_array_map_from_value),
        prompt_instructions: object.get("promptInstructions").and_then(string_map_from_value),
        prompt_runs: object.get("promptRuns").and_then(|value| {
            value.as_array().map(|runs| {
                runs.iter()
                    .filter_map(|run| serde_json::from_value::<PromptRun>(run.clone()).ok())
                    .collect::<Vec<_>>()
            })
        }),
        prompt_templates: object.get("promptTemplates").and_then(|value| {
            value.as_array().map(|templates| {
                templates.iter()
                    .filter_map(|template| serde_json::from_value::<PromptTemplate>(template.clone()).ok())
                    .collect::<Vec<_>>()
            })
        }),
        llm_config: object.get("llmConfig").and_then(|value| serde_json::from_value::<LlmConfig>(value.clone()).ok()),
    }
}

fn string_map_from_value(value: &serde_json::Value) -> Option<HashMap<String, String>> {
    value.as_object().map(|object| {
        object
            .iter()
            .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
            .collect()
    })
}

fn string_array_map_from_value(value: &serde_json::Value) -> Option<HashMap<String, Vec<String>>> {
    value.as_object().map(|object| {
        object
            .iter()
            .filter_map(|(key, value)| {
                value.as_array().map(|items| {
                    let paths = items.iter().filter_map(serde_json::Value::as_str).map(str::to_string).collect();
                    (key.clone(), paths)
                })
            })
            .collect()
    })
}

#[tauri::command]
fn get_vault_config(state: tauri::State<AppState>) -> Result<VaultConfig, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let config_path = root.join(".lattice").join("config.json");
    let config = if config_path.exists() {
        let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        vault_config_from_json(&content)
    } else {
        VaultConfig::default()
    };
    Ok(migrate_config(config))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveStatus {
    file_count: usize,
    total_bytes: u64,
}

#[tauri::command]
fn get_archive_status(state: tauri::State<AppState>) -> Result<ArchiveStatus, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let runs_dir = root.join(".lattice").join("runs");
    let mut file_count = 0;
    let mut total_bytes = 0;
    if runs_dir.exists() && runs_dir.is_dir() {
        for entry in fs::read_dir(runs_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext == "md" {
                        file_count += 1;
                        if let Ok(meta) = path.metadata() {
                            total_bytes += meta.len();
                        }
                    }
                }
            }
        }
    }
    Ok(ArchiveStatus { file_count, total_bytes })
}

#[tauri::command]
fn delete_archived_prompt(run_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let run_path = prompt_run_archive_path(root, &run_id)?;
    if run_path.exists() {
        fs::remove_file(&run_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn prune_archived_prompts(active_run_ids: Vec<String>, state: tauri::State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let runs_dir = root.join(".lattice").join("runs");
    if runs_dir.exists() && runs_dir.is_dir() {
        let active_set: HashSet<String> = active_run_ids.into_iter().map(|id| format!("{}.md", id)).collect();
        for entry in fs::read_dir(&runs_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_file() {
                if let Some(filename) = path.file_name().and_then(|f| f.to_str()) {
                    if filename.ends_with(".md") && !active_set.contains(filename) {
                        fs::remove_file(&path).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn archive_prompt_run(run_id: String, content: String, state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let run_path = prompt_run_archive_path(root, &run_id)?;
    let runs_dir = run_path.parent().ok_or("Invalid archive path")?;
    if !runs_dir.exists() {
        fs::create_dir_all(&runs_dir).map_err(|e| e.to_string())?;
    }
    fs::write(&run_path, &content).map_err(|e| e.to_string())?;

    // Compute SHA-256 hash of prompt content
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let hash_result = hasher.finalize();
    let hex_hash = format!("{:x}", hash_result);

    Ok(hex_hash)
}

#[tauri::command]
fn get_archived_prompt(run_id: String, state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let run_path = prompt_run_archive_path(root, &run_id)?;
    if run_path.exists() {
        fs::read_to_string(&run_path).map_err(|e| e.to_string())
    } else {
        Err("Archived prompt not found".to_string())
    }
}

fn prompt_run_archive_path(root: &Path, run_id: &str) -> Result<PathBuf, String> {
    let is_safe = !run_id.is_empty()
        && run_id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
    if !is_safe {
        return Err("Invalid prompt run id".to_string());
    }
    Ok(root.join(".lattice").join("runs").join(format!("{}.md", run_id)))
}

#[tauri::command]
fn save_vault_config(config: VaultConfig, state: tauri::State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let lattice_dir = root.join(".lattice");
    if !lattice_dir.exists() {
        fs::create_dir_all(&lattice_dir).map_err(|e| e.to_string())?;
    }
    let config_path = lattice_dir.join("config.json");
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&config_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

fn embeddings_cache_path(root: &Path) -> PathBuf {
    root.join(".lattice").join("embeddings.json")
}

#[tauri::command]
fn load_embeddings_cache(state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let path = embeddings_cache_path(root);
    if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

#[tauri::command]
fn save_embeddings_cache(content: String, state: tauri::State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let lattice_dir = root.join(".lattice");
    if !lattice_dir.exists() {
        fs::create_dir_all(&lattice_dir).map_err(|e| e.to_string())?;
    }
    let path = embeddings_cache_path(root);
    fs::write(path, content).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingEntry {
    content_hash: String,
    vector: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BacklinkSuggestion {
    id: String,
    source_path: String,
    source_title: String,
    target_path: String,
    target_title: String,
    suggestion_type: String, // "unlinked_mention" | "semantic"
    excerpt: String,
    score: f32,
}

fn make_title_regex(title: &str) -> Result<Regex, String> {
    let escaped = regex::escape(title);
    let mut pattern = String::new();
    
    if let Some(first_char) = title.chars().next() {
        if first_char.is_alphanumeric() || first_char == '_' {
            pattern.push_str(r"\b");
        }
    }
    
    pattern.push_str(&escaped);
    
    if let Some(last_char) = title.chars().last() {
        if last_char.is_alphanumeric() || last_char == '_' {
            pattern.push_str(r"\b");
        }
    }
    
    Regex::new(&format!("(?i){}", pattern)).map_err(|e| e.to_string())
}

fn clean_wiki_links(text: &str) -> String {
    let link_re = Regex::new(r"\[\[.*?\]\]").unwrap();
    link_re.replace_all(text, |caps: &regex::Captures| {
        let len = caps[0].len();
        " ".repeat(len)
    }).into_owned()
}

fn get_excerpt_around_match(content: &str, match_start: usize) -> String {
    let mut line_starts = Vec::new();
    let mut current_offset = 0;
    for line in content.lines() {
        line_starts.push(current_offset);
        current_offset += line.len() + 1; // +1 for newline character
    }
    
    let mut match_line_idx = 0;
    for (i, &start) in line_starts.iter().enumerate() {
        if match_start >= start {
            match_line_idx = i;
        } else {
            break;
        }
    }
    
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return String::new();
    }
    let start_line = match_line_idx.saturating_sub(1);
    let end_line = std::cmp::min(match_line_idx + 1, lines.len().saturating_sub(1));
    
    lines[start_line..=end_line].join("\n")
}

fn cosine_similarity(vec_a: &[f32], vec_b: &[f32]) -> f32 {
    if vec_a.len() != vec_b.len() || vec_a.is_empty() {
        return 0.0;
    }
    let mut dot_product = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for i in 0..vec_a.len() {
        dot_product += vec_a[i] * vec_b[i];
        norm_a += vec_a[i] * vec_a[i];
        norm_b += vec_b[i] * vec_b[i];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot_product / (norm_a.sqrt() * norm_b.sqrt())
}

#[tauri::command]
fn get_backlink_suggestions(active_path: String, state: tauri::State<AppState>) -> Result<Vec<BacklinkSuggestion>, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    
    let active_note = guard.notes.iter().find(|note| note.meta.path == active_path)
        .ok_or_else(|| format!("Active note not found: {}", active_path))?;
    let active_title = &active_note.meta.title;

    let mut suggestions = Vec::new();

    let cache_path = embeddings_cache_path(root);
    let embeddings: HashMap<String, EmbeddingEntry> = if cache_path.exists() {
        let content = fs::read_to_string(&cache_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        HashMap::new()
    };

    let active_vec = embeddings.get(&active_path).map(|entry| &entry.vector);
    let mention_regex = make_title_regex(active_title)?;

    for note in &guard.notes {
        if note.meta.path == active_path {
            continue;
        }

        let already_links = note.links.iter().any(|link| {
            link.resolved_path.as_deref() == Some(&active_path)
        });
        if already_links {
            continue;
        }

        // 1. Unlinked Mention Matcher
        let cleaned_content = clean_wiki_links(&note.content);
        if let Some(mat) = mention_regex.find(&cleaned_content) {
            let excerpt = get_excerpt_around_match(&note.content, mat.start());
            suggestions.push(BacklinkSuggestion {
                id: format!("mention:{}:{}", note.meta.path, active_path),
                source_path: note.meta.path.clone(),
                source_title: note.meta.title.clone(),
                target_path: active_path.clone(),
                target_title: active_title.clone(),
                suggestion_type: "unlinked_mention".to_string(),
                excerpt,
                score: 1.0,
            });
        }

        // 2. Semantic Similarity Matcher
        if let Some(active_v) = active_vec {
            if let Some(node_entry) = embeddings.get(&note.meta.path) {
                let similarity = cosine_similarity(active_v, &node_entry.vector);
                if similarity >= 0.6 {
                    let excerpt = note.content.lines().take(3).collect::<Vec<_>>().join("\n");
                    suggestions.push(BacklinkSuggestion {
                        id: format!("semantic:{}:{}", note.meta.path, active_path),
                        source_path: note.meta.path.clone(),
                        source_title: note.meta.title.clone(),
                        target_path: active_path.clone(),
                        target_title: active_title.clone(),
                        suggestion_type: "semantic".to_string(),
                        excerpt,
                        score: similarity,
                    });
                }
            }
        }
    }

    Ok(suggestions)
}

#[tauri::command]
fn apply_backlink_suggestion(suggestion: BacklinkSuggestion, state: tauri::State<AppState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    
    let source_full_path = root.join(&suggestion.source_path);
    let content = fs::read_to_string(&source_full_path).map_err(|e| e.to_string())?;
    
    let new_content = if suggestion.suggestion_type == "unlinked_mention" {
        let mention_regex = make_title_regex(&suggestion.target_title)?;
        let cleaned_content = clean_wiki_links(&content);
        if let Some(mat) = mention_regex.find(&cleaned_content) {
            let start = mat.start();
            let end = mat.end();
            let mut updated = content.clone();
            updated.replace_range(start..end, &format!("[[{}]]", suggestion.target_title));
            updated
        } else {
            return Err("Mention not found in content".to_string());
        }
    } else {
        if content.contains("## Links") {
            content.replace("## Links", &format!("## Links\n\n- [[{}]]", suggestion.target_title))
        } else {
            let separator = if content.ends_with("\n\n") {
                ""
            } else if content.ends_with('\n') {
                "\n"
            } else {
                "\n\n"
            };
            format!("{}{}{}", content.trim_end(), separator, format!("## Links\n\n- [[{}]]\n", suggestion.target_title))
        }
    };
    
    fs::write(&source_full_path, &new_content).map_err(|e| e.to_string())?;
    guard.notes = resolve_links(scan_vault(&root)?);
    
    if guard.auto_git_enabled {
        let _ = auto_commit(&root, &suggestion.source_path);
    }
    
    Ok(())
}

#[tauri::command]
fn apply_note_metadata(
    path: String,
    frontmatter: HashMap<String, String>,
    tags: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    
    let full_path = root.join(&path);
    let raw = fs::read_to_string(&full_path).map_err(|e| e.to_string())?;
    
    let (mut current_fm, body) = parse_frontmatter(&raw);
    
    for (k, v) in frontmatter {
        current_fm.insert(k, v);
    }
    
    let mut updated_body = body.clone();
    let mut tags_to_append = Vec::new();
    for tag in tags {
        let tag_pattern = format!("#{}", tag);
        if !updated_body.to_lowercase().contains(&tag_pattern.to_lowercase()) {
            tags_to_append.push(tag_pattern);
        }
    }
    if !tags_to_append.is_empty() {
        let tags_str = tags_to_append.join(" ");
        if updated_body.ends_with("\n\n") {
            updated_body.push_str(&tags_str);
            updated_body.push('\n');
        } else if updated_body.ends_with('\n') {
            updated_body.push_str(&format!("\n{}\n", tags_str));
        } else {
            updated_body.push_str(&format!("\n\n{}\n", tags_str));
        }
    }
    
    let mut new_content = String::new();
    if !current_fm.is_empty() {
        new_content.push_str("---\n");
        let mut keys: Vec<&String> = current_fm.keys().collect();
        keys.sort();
        for key in keys {
            let value = &current_fm[key];
            new_content.push_str(&format!("{}: \"{}\"\n", key, value));
        }
        new_content.push_str("---\n");
    }
    new_content.push_str(&updated_body);
    
    fs::write(&full_path, &new_content).map_err(|e| e.to_string())?;
    guard.notes = resolve_links(scan_vault(&root)?);
    
    if guard.auto_git_enabled {
        let _ = auto_commit(&root, &path);
    }
    
    Ok(())
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnresolvedLinkSource {
    path: String,
    title: String,
    excerpt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnresolvedLinkGroup {
    target: String,
    sources: Vec<UnresolvedLinkSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposedEdit {
    id: String,
    #[serde(rename = "type")]
    edit_type: String,
    path: String,
    new_path: Option<String>,
    content: Option<String>,
    target_content: Option<String>,
    replacement_content: Option<String>,
    reason: Option<String>,
    applied: bool,
}

#[tauri::command]
fn get_unresolved_links(state: tauri::State<AppState>) -> Result<Vec<UnresolvedLinkGroup>, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let notes = &guard.notes;

    let mut unresolved_map: HashMap<String, Vec<UnresolvedLinkSource>> = HashMap::new();

    for note in notes {
        let lines: Vec<&str> = note.content.lines().collect();
        for link in &note.links {
            if link.resolved_path.is_none() {
                let target = link.target_ref.clone();
                let line_idx = if link.line > 0 { link.line - 1 } else { 0 };
                let excerpt = if line_idx < lines.len() {
                    let start = line_idx.saturating_sub(2);
                    let end = std::cmp::min(lines.len(), line_idx + 3);
                    lines[start..end].join("\n")
                } else {
                    note.content.chars().take(300).collect::<String>()
                };

                let sources = unresolved_map.entry(target).or_default();
                if !sources.iter().any(|s| s.path == note.meta.path) {
                    sources.push(UnresolvedLinkSource {
                        path: note.meta.path.clone(),
                        title: note.meta.title.clone(),
                        excerpt,
                    });
                }
            }
        }
    }

    let mut result: Vec<UnresolvedLinkGroup> = unresolved_map
        .into_iter()
        .map(|(target, sources)| UnresolvedLinkGroup { target, sources })
        .collect();

    result.sort_by(|a, b| a.target.to_lowercase().cmp(&b.target.to_lowercase()));
    Ok(result)
}

fn get_attribute_value(attrs_str: &str, name: &str) -> Option<String> {
    let pattern = format!(r#"(?i){}\s*=\s*["']([^"']*)["']"#, regex::escape(name));
    let re = Regex::new(&pattern).ok()?;
    re.captures(attrs_str)
        .map(|cap| cap.get(1).unwrap().as_str().to_string())
}

fn get_tag_content(inner_content: &str, tag_name: &str) -> Option<String> {
    let open_pattern = format!(r#"(?i)<{}\s*>"#, tag_name);
    let open_re = Regex::new(&open_pattern).ok()?;
    let open_cap = open_re.captures(inner_content)?;
    let open_match = open_cap.get(0).unwrap();
    let content_start = open_match.end();

    let close_pattern = format!(r#"(?i)</{}>"#, tag_name);
    let close_re = Regex::new(&close_pattern).ok()?;
    let remainder = &inner_content[content_start..];
    let close_cap = close_re.captures(remainder)?;
    let close_match = close_cap.get(0).unwrap();
    let content_end = content_start + close_match.start();

    let mut val = inner_content[content_start..content_end].to_string();

    if val.starts_with("<![CDATA[") {
        val = val["<![CDATA[".len()..].to_string();
        if val.ends_with("]]>") {
            val = val[..val.len() - "]]>".len()].to_string();
        }
    }
    Some(val)
}

#[tauri::command]
fn parse_proposed_edits(raw_text: String) -> Result<Vec<ProposedEdit>, String> {
    let mut edits = Vec::new();
    let mut start_idx = 0;

    let tag_re = Regex::new(r"(?i)<propose_edit\s+([^>]+)>").unwrap();
    let close_tag = "</propose_edit>";

    while let Some(cap) = tag_re.captures(&raw_text[start_idx..]) {
        let matched = cap.get(0).unwrap();
        let tag_end = start_idx + matched.end();

        let slice_after_tag = &raw_text[tag_end..];
        let Some(close_idx) = slice_after_tag.find(close_tag) else {
            break;
        };

        let closing_tag_start = tag_end + close_idx;
        let inner_content = &raw_text[tag_end..closing_tag_start];
        start_idx = closing_tag_start + close_tag.len();

        let attrs_str = cap.get(1).unwrap().as_str();
        let edit_type_val = get_attribute_value(attrs_str, "type");
        let path = get_attribute_value(attrs_str, "path").unwrap_or_default();
        let new_path = get_attribute_value(attrs_str, "new_path")
            .or_else(|| get_attribute_value(attrs_str, "newPath"));

        if edit_type_val.is_none() || path.is_empty() {
            continue;
        }

        let edit_type = edit_type_val.unwrap().to_lowercase();
        if edit_type != "create" && edit_type != "update" && edit_type != "merge" && edit_type != "delete" {
            continue;
        }

        let reason = get_tag_content(inner_content, "reason");
        let content = get_tag_content(inner_content, "content");
        let target_content = get_tag_content(inner_content, "target_content")
            .or_else(|| get_tag_content(inner_content, "targetContent"));
        let replacement_content = get_tag_content(inner_content, "replacement_content")
            .or_else(|| get_tag_content(inner_content, "replacementContent"));

        let mut hasher = Sha256::new();
        hasher.update(format!("{}{}{}", path, edit_type, start_idx).as_bytes());
        let hash_bytes = hasher.finalize();
        let id = format!("{:x}", hash_bytes)[..12].to_string();

        edits.push(ProposedEdit {
            id,
            edit_type,
            path,
            new_path,
            content,
            target_content,
            replacement_content,
            reason,
            applied: false,
        });
    }

    Ok(edits)
}

fn mutate_graph_link(source_path: String, target_path: String, add: bool, state: tauri::State<AppState>) -> Result<LinkMutationResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let target_title = guard.notes.iter().find(|note| note.meta.path == target_path).map(|note| note.meta.title.clone()).ok_or("Target note not found")?;
    let full_path = root.join(&source_path);
    let content = fs::read_to_string(&full_path).map_err(|error| error.to_string())?;
    let next = if add { add_managed_link(&content, &target_title) } else { remove_managed_link(&content, &target_title) };
    fs::write(&full_path, &next).map_err(|error| error.to_string())?;
    guard.notes = resolve_links(scan_vault(&root)?);
    Ok(LinkMutationResult {
        note: NoteDocument { path: source_path, revision: revision_of(&next), content: next },
        graph: build_graph(&guard.notes),
    })
}

fn scan_vault(root: &Path) -> Result<Vec<ParsedNote>, String> {
    let mut notes = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok).filter(|entry| entry.path().extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md"))) {
        let path = entry.path();
        let rel = path.strip_prefix(root).map_err(|error| error.to_string())?.to_string_lossy().replace('\\', "/");
        if rel.starts_with(".lattice/") || rel == ".lattice" {
            continue;
        }
        let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
        let modified_at = entry.metadata().ok().and_then(|meta| meta.modified().ok()).map(|_| Utc::now().to_rfc3339());
        notes.push(parse_note(rel, content, modified_at));
    }
    Ok(resolve_links(notes))
}

fn vault_snapshot(root: &Path, notes: &[ParsedNote]) -> VaultSnapshot {
    VaultSnapshot {
        root_path: root.to_string_lossy().to_string(),
        notes: notes.iter().map(|note| note.meta.clone()).collect(),
        tree: build_tree(notes),
        obsidian_settings: read_obsidian_settings(root),
    }
}

fn read_obsidian_settings(root: &Path) -> Option<ObsidianSettings> {
    let obsidian_dir = root.join(".obsidian");
    if !obsidian_dir.is_dir() {
        return None;
    }

    let app = read_json_file(&obsidian_dir.join("app.json"));
    let appearance = read_json_file(&obsidian_dir.join("appearance.json"));
    let core_plugins = read_json_file(&obsidian_dir.join("core-plugins.json"));

    Some(ObsidianSettings {
        detected: true,
        readable_line_length: app
            .as_ref()
            .and_then(|value| value.get("readableLineLength"))
            .and_then(serde_json::Value::as_bool),
        theme: appearance
            .as_ref()
            .and_then(|value| value.get("theme"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        accent_color: appearance
            .as_ref()
            .and_then(|value| value.get("accentColor"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        enabled_core_plugins: read_core_plugins(core_plugins.as_ref()),
        attachment_folder_path: app
            .as_ref()
            .and_then(|value| value.get("attachmentFolderPath"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        css_snippets: appearance
            .as_ref()
            .and_then(|value| value.get("cssSnippets"))
            .and_then(|val| match val {
                serde_json::Value::Array(arr) => Some(
                    arr.iter()
                       .filter_map(serde_json::Value::as_str)
                       .map(str::to_string)
                       .collect()
                ),
                _ => None,
            })
            .unwrap_or_default(),
        hotkeys: read_json_file(&obsidian_dir.join("hotkeys.json")),
    })
}

fn read_json_file(path: &Path) -> Option<serde_json::Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn read_core_plugins(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(str::to_string)
            .collect(),
        Some(serde_json::Value::Object(map)) => {
            let mut plugins = map
            .iter()
            .filter_map(|(key, enabled)| enabled.as_bool().unwrap_or(false).then(|| key.clone()))
            .collect::<Vec<_>>();
            plugins.sort();
            plugins
        },
        _ => Vec::new(),
    }
}

fn parse_note(path: String, raw: String, modified_at: Option<String>) -> ParsedNote {
    let (frontmatter, content) = parse_frontmatter(&raw);
    let title = content.lines().find_map(|line| line.strip_prefix("# ").map(str::trim)).unwrap_or_else(|| path.trim_end_matches(".md")).to_string();
    let tags = Regex::new(r"(^|\s)#([\p{L}\p{N}_/-]+)").unwrap().captures_iter(&content).map(|cap| cap[2].to_string()).collect();
    let content_hash = revision_of(&raw);
    let links = parse_links(&path, &content);
    ParsedNote {
        meta: NoteMeta { path, title, tags, frontmatter, modified_at, content_hash },
        content: raw,
        links,
    }
}

fn parse_frontmatter(raw: &str) -> (HashMap<String, String>, String) {
    if !raw.starts_with("---\n") {
        return (HashMap::new(), raw.to_string());
    }
    let Some(end) = raw[4..].find("\n---") else {
        return (HashMap::new(), raw.to_string());
    };
    let yaml = &raw[4..4 + end];
    let body = raw[4 + end + 4..].trim_start_matches('\n').to_string();
    let frontmatter = yaml.lines().filter_map(|line| {
        let (key, value) = line.split_once(':')?;
        Some((key.trim().to_string(), value.trim().trim_matches('"').to_string()))
    }).collect();
    (frontmatter, body)
}

fn parse_links(source_path: &str, content: &str) -> Vec<NoteLink> {
    let link_re = Regex::new(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]").unwrap();
    let lines: Vec<&str> = content.lines().collect();
    let section_start = lines.iter().position(|line| line.trim().eq_ignore_ascii_case("## Links"));
    let section_end = section_start.map(|start| lines.iter().enumerate().skip(start + 1).find(|(_, line)| line.trim_start().starts_with('#')).map(|(index, _)| index).unwrap_or(lines.len()));
    let mut links = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        for cap in link_re.captures_iter(line) {
            links.push(NoteLink {
                source_path: source_path.to_string(),
                target_ref: cap[1].trim().to_string(),
                resolved_path: None,
                line: index + 1,
                is_managed: section_start.zip(section_end).is_some_and(|(start, end)| index > start && index < end),
            });
        }
    }
    links
}

fn resolve_links(mut notes: Vec<ParsedNote>) -> Vec<ParsedNote> {
    let mut resolver = HashMap::new();
    for note in &notes {
        resolver.insert(normalize_ref(&note.meta.path), note.meta.path.clone());
        resolver.insert(normalize_ref(note.meta.path.trim_end_matches(".md")), note.meta.path.clone());
        resolver.insert(normalize_ref(&note.meta.title), note.meta.path.clone());
    }
    for note in &mut notes {
        for link in &mut note.links {
            link.resolved_path = resolver.get(&normalize_ref(&link.target_ref)).cloned();
        }
    }
    notes
}

fn note_context(notes: &[ParsedNote], path: &str) -> Result<NoteContext, String> {
    let note = notes.iter().find(|note| note.meta.path == path).cloned().ok_or("Note not found")?;
    let backlinks = notes.iter().flat_map(|candidate| candidate.links.iter().filter(move |link| link.resolved_path.as_deref() == Some(path) && candidate.meta.path != path).cloned()).collect();
    Ok(NoteContext { outgoing_links: note.links.clone(), note, backlinks })
}

fn extract_excerpt(content: &str, length: usize) -> String {
    let mut body = content;
    if content.starts_with("---\n") {
        if let Some(end) = content[4..].find("\n---") {
            body = &content[4 + end + 4..];
        }
    }
    // Remove title heading (# Heading)
    let re_heading = Regex::new(r"(?m)^#\s+.+$").unwrap();
    let body_without_heading = re_heading.replace_all(body, "");
    
    // Clean up whitespace/multiple newlines
    let text = body_without_heading.split_whitespace().collect::<Vec<_>>().join(" ");
    let char_count = text.chars().count();
    if char_count <= length {
        text
    } else {
        let truncated: String = text.chars().take(length).collect();
        format!("{}...", truncated)
    }
}

#[derive(Debug, Clone)]
struct IncludedNoteInfo {
    reason: String,
    reason_detail: String,
    score: f64,
    excerpt: String,
}

fn create_context_bundle(notes: &[ParsedNote], focus_path: &str, options: ContextBundleOptions) -> Result<ContextBundle, String> {
    let focus = notes.iter().find(|note| note.meta.path == focus_path).ok_or("Note not found")?;
    let mut included = context_bundle_included_notes(notes, focus_path)?;
    if let Some(selected_paths) = options.selected_paths {
        let selected: HashSet<String> = selected_paths.into_iter().collect();
        included.retain(|(note, _)| selected.contains(&note.meta.path));
    }

    let title = format!("Context Bundle: {}", focus.meta.title);
    let purpose = options.purpose;
    let mode = options.mode.unwrap_or_else(|| "standard".to_string());
    let preset = options.preset;
    let markdown = render_context_bundle(&title, &included, purpose.as_deref(), &mode, preset.as_deref(), notes);
    let estimated_tokens = estimate_tokens(&markdown);

    Ok(ContextBundle {
        title: title.clone(),
        focus_path: focus_path.to_string(),
        note_paths: included.iter().map(|(note, _)| note.meta.path.clone()).collect(),
        markdown,
        estimated_tokens,
    })
}

fn count_title_mentions(content: &str, title: &str) -> usize {
    let mut body = content;
    if content.starts_with("---\n") {
        if let Some(end) = content[4..].find("\n---") {
            body = &content[4 + end + 4..];
        }
    }
    
    let lower_body = body.to_lowercase();
    let lower_title = title.to_lowercase();

    if lower_title.is_empty() {
        return 0;
    }

    let mut count = 0;
    let mut search_from = 0;
    while let Some(relative_idx) = lower_body[search_from..].find(&lower_title) {
        let idx = search_from + relative_idx;
        let mut valid = true;

        let chars_before: Vec<char> = body[..idx].chars().collect();
        if let Some(&last_char) = chars_before.last() {
            if last_char.is_alphanumeric() {
                valid = false;
            }
        }
        let chars_after: Vec<char> = body[idx + title.len()..].chars().collect();
        if let Some(&first_char) = chars_after.first() {
            if first_char.is_alphanumeric() {
                valid = false;
            }
        }

        if valid {
            count += 1;
        }

        search_from = idx + lower_title.len();
    }

    count
}

fn estimate_tokens(text: &str) -> usize {
    let mut english_chars: f64 = 0.0;
    let mut cjk_chars: f64 = 0.0;
    for c in text.chars() {
        if c as u32 > 255 {
            cjk_chars += 1.0;
        } else {
            english_chars += 1.0;
        }
    }
    let total: f64 = english_chars / 4.0 + cjk_chars * 1.2;
    total.ceil() as usize
}


fn context_bundle_candidates(notes: &[ParsedNote], focus_path: &str) -> Result<Vec<ContextBundleCandidate>, String> {
    Ok(context_bundle_included_notes(notes, focus_path)?
        .into_iter()
        .map(|(note, info)| {
            let selected = info.reason != "Recommended";
            ContextBundleCandidate {
                path: note.meta.path.clone(),
                title: note.meta.title.clone(),
                reason: info.reason,
                reason_detail: info.reason_detail,
                score: info.score,
                excerpt: info.excerpt,
                token_estimate: estimate_tokens(&note.content),
                selected,
                character_count: note.content.len(),
            }
        })
        .collect())
}

fn context_bundle_included_notes(notes: &[ParsedNote], focus_path: &str) -> Result<Vec<(ParsedNote, IncludedNoteInfo)>, String> {
    let context = note_context(notes, focus_path)?;
    let mut included: Vec<(ParsedNote, IncludedNoteInfo)> = vec![(
        context.note.clone(),
        IncludedNoteInfo {
            reason: "Focus".to_string(),
            reason_detail: "Focus note".to_string(),
            score: 10.0,
            excerpt: extract_excerpt(&context.note.content, 100),
        },
    )];

    for link in &context.outgoing_links {
        if let Some(resolved_path) = &link.resolved_path {
            if !included.iter().any(|(note, _)| note.meta.path == *resolved_path) {
                if let Some(note) = notes.iter().find(|note| note.meta.path == *resolved_path) {
                    included.push((
                        note.clone(),
                        IncludedNoteInfo {
                            reason: "Outgoing".to_string(),
                            reason_detail: "Direct link inside the focus note".to_string(),
                            score: 8.0,
                            excerpt: extract_excerpt(&note.content, 100),
                        },
                    ));
                }
            }
        }
    }

    for link in &context.backlinks {
        if !included.iter().any(|(note, _)| note.meta.path == link.source_path) {
            if let Some(note) = notes.iter().find(|note| note.meta.path == link.source_path) {
                included.push((
                    note.clone(),
                    IncludedNoteInfo {
                        reason: "Backlink".to_string(),
                        reason_detail: format!("Linked to this note from [[{}]]", note.meta.title),
                        score: 7.0,
                        excerpt: extract_excerpt(&note.content, 100),
                    },
                ));
            }
        }
    }

    // Recommendation logic
    let focus_note = &context.note;
    let focus_tags: HashSet<&str> = focus_note.meta.tags.iter().map(String::as_str).collect();

    for note in notes {
        if included.iter().any(|(n, _)| n.meta.path == note.meta.path) {
            continue;
        }

        let shared: Vec<&str> = note
            .meta
            .tags
            .iter()
            .map(String::as_str)
            .filter(|tag| focus_tags.contains(tag))
            .collect();
            
        let focus_mentions = count_title_mentions(&focus_note.content, &note.meta.title);
        let candidate_mentions = count_title_mentions(&note.content, &focus_note.meta.title);
        let total_mentions = focus_mentions + candidate_mentions;

        if !shared.is_empty() || total_mentions > 0 {
            let mut tag_score = 0.0;
            let mut mention_score = 0.0;
            let mut reasons = Vec::new();

            if !shared.is_empty() {
                tag_score = 3.0 + (shared.len() as f64) * 1.5;
                let formatted_tags = shared
                    .iter()
                    .map(|t| format!("#{}", t))
                    .collect::<Vec<String>>()
                    .join(", ");
                reasons.push(format!("Shares tags: {}", formatted_tags));
            }

            if total_mentions > 0 {
                mention_score = 4.0 + (total_mentions as f64) * 2.0;
                let mut detail_parts = Vec::new();
                if focus_mentions > 0 {
                    detail_parts.push(format!("mentioned {} time(s) in focus", focus_mentions));
                }
                if candidate_mentions > 0 {
                    detail_parts.push(format!("mentions focus {} time(s)", candidate_mentions));
                }
                reasons.push(detail_parts.join(", "));
            }

            let max_score = if tag_score > mention_score { tag_score } else { mention_score };
            let score = if max_score > 9.5 { 9.5 } else { max_score };
            let reason_detail = reasons.join("; ");

            included.push((
                note.clone(),
                IncludedNoteInfo {
                    reason: "Recommended".to_string(),
                    reason_detail,
                    score,
                    excerpt: extract_excerpt(&note.content, 100),
                },
            ));
        }
    }

    Ok(included)
}

fn render_context_bundle(
    title: &str,
    included: &[(ParsedNote, IncludedNoteInfo)],
    purpose: Option<&str>,
    mode: &str,
    preset: Option<&str>,
    notes: &[ParsedNote],
) -> String {
    let mode_capitalized = if mode.is_empty() {
        "Standard".to_string()
    } else {
        let mut chars = mode.chars();
        match chars.next() {
            None => String::new(),
            Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        }
    };

    let mut lines = vec![
        format!("# {}", title),
        String::new(),
    ];

    if let Some(p_preset) = preset {
        if !p_preset.trim().is_empty() && p_preset != "custom" {
            let mut chars = p_preset.chars();
            let preset_capitalized = match chars.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
            };
            lines.push(format!("**Preset**: {}", preset_capitalized));
        }
    }

    lines.push(format!("**Mode**: {}", mode_capitalized));

    if let Some(p) = purpose {
        if !p.trim().is_empty() {
            lines.push(format!("**Purpose**: {}", p.trim()));
        }
    }

    lines.extend([
        String::new(),
        "## Instructions".to_string(),
        String::new(),
        "Use this bundle as local wiki context. Prefer cited note names when answering or proposing edits.".to_string(),
        String::new(),
        "## Included Notes".to_string(),
    ]);

    for (note, info) in included {
        lines.push(format!("- {}: [[{}]] (`{}`)", info.reason, note.meta.title, note.meta.path));
    }
    lines.push(String::new());

    for (note, _) in included {
        lines.extend([
            format!("## Note: {}", note.meta.title),
            String::new(),
            format!("Path: `{}`", note.meta.path),
            String::new(),
        ]);

        if !note.meta.frontmatter.is_empty() {
            lines.push("Frontmatter:".to_string());
            lines.push("```yaml".to_string());
            for (key, value) in &note.meta.frontmatter {
                lines.push(format!("{}: {}", key, value));
            }
            lines.push("```".to_string());
            lines.push(String::new());
        }

        if mode == "short" {
            lines.push(extract_excerpt(&note.content, 150));
            lines.push(String::new());
        } else {
            lines.push(note.content.trim().to_string());
            lines.push(String::new());
        }

        if mode == "full" {
            let context = note_context(notes, &note.meta.path).unwrap();
            let find_note_title = |path: &str| {
                notes.iter().find(|n| n.meta.path == path).map(|n| n.meta.title.clone()).unwrap_or_else(|| {
                    path.split(['/', '\\']).last().unwrap_or(path).trim_end_matches(".md").to_string()
                })
            };

            let mut outgoing_links = Vec::new();
            for link in &context.outgoing_links {
                let t = match &link.resolved_path {
                    Some(res) => find_note_title(res),
                    None => link.target_ref.clone(),
                };
                let formatted = match &link.resolved_path {
                    Some(res) => format!("  - [[{}]] (`{}`)", t, res),
                    None => format!("  - [[{}]]", t),
                };
                outgoing_links.push(formatted);
            }

            let mut backlinks = Vec::new();
            for link in &context.backlinks {
                let t = find_note_title(&link.source_path);
                backlinks.push(format!("  - [[{}]] (`{}`)", t, link.source_path));
            }

            lines.push("### Links".to_string());
            lines.push("- **Outgoing**:".to_string());
            if outgoing_links.is_empty() {
                lines.push("  - None".to_string());
            } else {
                lines.extend(outgoing_links);
            }

            lines.push("- **Backlinks**:".to_string());
            if backlinks.is_empty() {
                lines.push("  - None".to_string());
            } else {
                lines.extend(backlinks);
            }
            lines.push(String::new());
        }
    }

    format!("{}\n", lines.join("\n").trim())
}

fn inbox_path_for_capture(captured_at: &str) -> Result<String, String> {
    let date = parse_capture_time(captured_at)?;
    Ok(format!("Inbox/{}.md", date.format("%Y-%m-%d")))
}

fn format_inbox_capture(content: &str, related_title: Option<&str>, captured_at: &str) -> Result<String, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("Capture content is required".to_string());
    }

    let date = parse_capture_time(captured_at)?;
    let mut lines = vec![
        format!("## {}", date.format("%Y-%m-%d %H:%M")),
        String::new(),
    ];

    if let Some(title) = related_title {
        lines.push(format!("Related: [[{}]]", title));
        lines.push(String::new());
    }

    lines.extend([
        "#inbox".to_string(),
        String::new(),
        content.to_string(),
    ]);

    Ok(format!("{}\n", lines.join("\n")))
}

fn parse_inbox_captures(markdown: &str) -> Vec<InboxCaptureBlock> {
    parse_inbox_capture_spans(markdown)
        .into_iter()
        .map(|span| span.capture)
        .collect()
}

fn parse_inbox_capture_spans(markdown: &str) -> Vec<InboxCaptureSpan> {
    let unprocessed = markdown.split("\n## Processed").next().unwrap_or("");
    let heading = Regex::new(r"(?m)^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$").expect("valid inbox heading regex");
    let matches: Vec<_> = heading.find_iter(unprocessed).collect();
    let mut seen_titles: HashMap<String, usize> = HashMap::new();
    matches
        .iter()
        .enumerate()
        .map(|(index, matched)| {
            let end = matches.get(index + 1).map(|next| next.start()).unwrap_or(unprocessed.len());
            let block = unprocessed[matched.start()..end].trim();
            let title = heading.captures(block).and_then(|captures| captures.get(1)).map(|value| value.as_str()).unwrap_or("").to_string();
            let count = seen_titles.entry(title.clone()).and_modify(|value| *value += 1).or_insert(1);
            let id = if *count == 1 {
                title.clone()
            } else {
                format!("{}#{}", title, count)
            };
            let related_title = Regex::new(r"(?m)^Related:\s*\[\[([^\]]+)]]\s*$")
                .expect("valid related regex")
                .captures(block)
                .and_then(|captures| captures.get(1))
                .map(|value| value.as_str().to_string());
            let body = block
                .lines()
                .filter(|line| {
                    !line.starts_with("## ")
                        && !line.starts_with("Related: [[")
                        && line.trim() != "#inbox"
                })
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();
            InboxCaptureSpan {
                capture: InboxCaptureBlock {
                    id,
                    title,
                    related_title,
                    body,
                    markdown: format!("{}\n", block),
                },
                start: matched.start(),
                end,
            }
        })
        .collect()
}

fn move_inbox_capture_to_processed(markdown: &str, capture_id: &str) -> Result<String, String> {
    let span = parse_inbox_capture_spans(markdown)
        .into_iter()
        .find(|candidate| candidate.capture.id == capture_id)
        .ok_or_else(|| format!("Capture not found: {}", capture_id))?;
    let without_capture = format!("{}{}", &markdown[..span.start], &markdown[span.end..])
        .replace("\n\n\n", "\n\n")
        .trim_end()
        .to_string();
    if without_capture.lines().any(|line| line.trim() == "## Processed") {
        Ok(format!("{}\n\n{}", without_capture, span.capture.markdown))
    } else {
        Ok(format!("{}\n\n## Processed\n\n{}", without_capture, span.capture.markdown))
    }
}

fn parse_capture_time(captured_at: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(captured_at)
        .map(|date| date.with_timezone(&Utc))
        .map_err(|error| error.to_string())
}

fn build_graph(notes: &[ParsedNote]) -> GraphData {
    GraphData {
        focused_path: None,
        nodes: notes.iter().map(|note| GraphNode { id: note.meta.path.clone(), label: note.meta.title.clone(), tags: note.meta.tags.clone() }).collect(),
        edges: notes.iter().flat_map(|note| note.links.iter().filter_map(|link| {
            let target = link.resolved_path.clone()?;
            Some(GraphEdge { id: format!("{}->{}->{}", note.meta.path, target, link.line), source: note.meta.path.clone(), target, is_managed: link.is_managed })
        })).collect(),
    }
}

fn build_tree(notes: &[ParsedNote]) -> Vec<FileTreeNode> {
    let mut root = Vec::new();
    for note in notes {
        insert_tree_path(&mut root, &note.meta.path);
    }
    sort_tree(&mut root);
    root
}

fn insert_tree_path(nodes: &mut Vec<FileTreeNode>, note_path: &str) {
    let parts: Vec<&str> = note_path.split('/').filter(|part| !part.is_empty()).collect();
    let mut level = nodes;
    let mut current_path = String::new();

    for (index, part) in parts.iter().enumerate() {
        if !current_path.is_empty() {
            current_path.push('/');
        }
        current_path.push_str(part);

        let kind = if index == parts.len() - 1 { "note" } else { "folder" };
        let node_index = match level.iter().position(|node| node.path == current_path) {
            Some(existing) => existing,
            None => {
                level.push(FileTreeNode {
                    name: (*part).to_string(),
                    path: current_path.clone(),
                    kind: kind.to_string(),
                    children: Vec::new(),
                });
                level.len() - 1
            }
        };

        level = &mut level[node_index].children;
    }
}

fn sort_tree(nodes: &mut Vec<FileTreeNode>) {
    nodes.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("folder", "note") => std::cmp::Ordering::Greater,
        ("note", "folder") => std::cmp::Ordering::Less,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    for node in nodes {
        sort_tree(&mut node.children);
    }
}

fn clean_entry_name(name: &str) -> Result<String, String> {
    let cleaned = name.trim().replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "-");
    if cleaned.is_empty() {
        Err("Entry name is required".to_string())
    } else {
        Ok(cleaned)
    }
}

fn unique_note_path(parent_path: &str, title: &str, notes: &[ParsedNote]) -> String {
    let first = join_vault_path(parent_path, &format!("{}.md", title));
    if !note_path_exists(&first, notes) {
        return first;
    }

    for index in 2.. {
        let candidate = join_vault_path(parent_path, &format!("{} {}.md", title, index));
        if !note_path_exists(&candidate, notes) {
            return candidate;
        }
    }

    unreachable!()
}

fn note_path_exists(path: &str, notes: &[ParsedNote]) -> bool {
    notes.iter().any(|note| note.meta.path.eq_ignore_ascii_case(path))
}

fn parent_path(path: &str) -> Option<String> {
    path.rsplit_once('/').map(|(parent, _)| parent.to_string())
}

fn join_vault_path(parent_path: &str, name: &str) -> String {
    if parent_path.trim().is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", parent_path.trim_end_matches('/'), name)
    }
}

fn resolve_vault_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    if relative.is_absolute() || path.split(['/', '\\']).any(|part| part == "..") {
        return Err(format!("Unsafe vault path: {}", path));
    }
    Ok(root.join(relative))
}

fn add_managed_link(content: &str, target: &str) -> String {
    if content.contains(&format!("- [[{}]]", target)) {
        return content.to_string();
    }
    let separator = if content.ends_with('\n') { "\n" } else { "\n\n" };
    if content.lines().any(|line| line.trim().eq_ignore_ascii_case("## Links")) {
        format!("{}- [[{}]]\n", content.trim_end(), target)
    } else {
        format!("{}{}## Links\n\n- [[{}]]\n", content, separator, target)
    }
}

fn remove_managed_link(content: &str, target: &str) -> String {
    let mut in_links = false;
    content.lines().filter_map(|line| {
        if line.trim().eq_ignore_ascii_case("## Links") {
            in_links = true;
            return Some(line.to_string());
        }
        if in_links && line.trim_start().starts_with('#') {
            in_links = false;
        }
        if in_links && line.trim() == format!("- [[{}]]", target) {
            None
        } else {
            Some(line.to_string())
        }
    }).collect::<Vec<_>>().join("\n") + "\n"
}

fn snapshot(state: &mut VaultState, path: &str, content: &str, reason: &str) -> String {
    let id = format!("{}:{}", path, Utc::now().timestamp_millis());
    state.snapshots.insert(0, SnapshotRecord {
        id: id.clone(),
        path: path.to_string(),
        created_at: Utc::now().to_rfc3339(),
        reason: reason.to_string(),
    });
    state.snapshot_content.insert(id.clone(), content.to_string());
    id
}

fn revision_of(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())[..12].to_string()
}

fn normalize_ref(value: &str) -> String {
    value.replace('\\', "/").trim_end_matches(".md").to_lowercase()
}

fn git_output(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git").args(args).current_dir(root).output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn auto_commit(root: &Path, path: &str) -> Result<String, String> {
    git_output(root, &["add", path])?;
    git_output(root, &["commit", "-m", &format!("Update {}", path)])?;
    git_output(root, &["rev-parse", "--short", "HEAD"])
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_vault,
            read_note,
            save_note,
            create_note,
            create_folder,
            rename_entry,
            delete_entry,
            capture_to_inbox,
            get_inbox_captures,
            mark_inbox_capture_processed,
            promote_inbox_capture,
            append_inbox_capture,
            get_context_bundle,
            get_context_bundle_candidates,
            search_notes,
            get_note_context,
            get_graph,
            create_graph_link,
            delete_managed_graph_link,
            list_snapshots,
            restore_snapshot,
            get_git_status,
            set_auto_git,
            get_vault_config,
            save_vault_config,
            archive_prompt_run,
            get_archived_prompt,
            get_archive_status,
            delete_archived_prompt,
            prune_archived_prompts,
            load_embeddings_cache,
            save_embeddings_cache,
            get_unresolved_links,
            parse_proposed_edits,
            get_backlink_suggestions,
            apply_backlink_suggestion,
            apply_note_metadata
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lattice");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lattice-{}-{}", name, Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn parsed(path: &str, title: &str) -> ParsedNote {
        ParsedNote {
            meta: NoteMeta {
                path: path.to_string(),
                title: title.to_string(),
                tags: Vec::new(),
                frontmatter: HashMap::new(),
                modified_at: None,
                content_hash: revision_of(title),
            },
            content: format!("# {}", title),
            links: Vec::new(),
        }
    }

    #[test]
    fn build_tree_preserves_nested_folders() {
        let tree = build_tree(&[
            parsed("Home.md", "Home"),
            parsed("Projects/Lattice.md", "Lattice"),
            parsed("일지/한글 노트.md", "한글 노트"),
        ]);

        assert_eq!(tree.len(), 3);
        assert_eq!(tree[0].kind, "note");
        assert_eq!(tree[1].kind, "folder");
        assert_eq!(tree[1].name, "Projects");
        assert_eq!(tree[1].children[0].path, "Projects/Lattice.md");
        assert_eq!(tree[2].name, "일지");
        assert_eq!(tree[2].children[0].name, "한글 노트.md");
    }

    #[test]
    fn vault_paths_stay_inside_the_vault() {
        let root = PathBuf::from("C:/vault");

        assert_eq!(resolve_vault_path(&root, "Projects/Note.md").unwrap(), root.join("Projects/Note.md"));
        assert!(resolve_vault_path(&root, "../outside.md").is_err());
        assert!(resolve_vault_path(&root, "C:/outside.md").is_err());
    }

    #[test]
    fn prompt_archive_paths_stay_inside_lattice_runs() {
        let root = PathBuf::from("C:/vault");

        assert_eq!(
            prompt_run_archive_path(&root, "run_123-abc").unwrap(),
            root.join(".lattice").join("runs").join("run_123-abc.md")
        );
        assert!(prompt_run_archive_path(&root, "../outside").is_err());
        assert!(prompt_run_archive_path(&root, "nested/run").is_err());
        assert!(prompt_run_archive_path(&root, "").is_err());
    }

    #[test]
    fn scan_vault_ignores_lattice_internal_markdown() {
        let root = temp_test_dir("scan-ignore-lattice");
        fs::create_dir_all(root.join(".lattice").join("runs")).unwrap();
        fs::write(root.join("Home.md"), "# Home\n").unwrap();
        fs::write(root.join(".lattice").join("runs").join("run-1.md"), "# Archived prompt\n").unwrap();

        let notes = scan_vault(&root).unwrap();
        let paths = notes.iter().map(|note| note.meta.path.as_str()).collect::<Vec<_>>();

        assert_eq!(paths, vec!["Home.md"]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unique_note_path_adds_numeric_suffixes() {
        let existing = vec![
            parsed("Projects/New Note.md", "New Note"),
            parsed("Projects/New Note 2.md", "New Note 2"),
        ];

        assert_eq!(unique_note_path("Projects", "New Note", &existing), "Projects/New Note 3.md");
    }

    #[test]
    fn test_config_migration() {
        let old_json = r#"{}"#;
        let config: VaultConfig = serde_json::from_str(old_json).unwrap();
        let migrated = migrate_config(config);
        assert_eq!(migrated.version, Some(1));
        assert_eq!(migrated.context_limit, Some(8000));
        assert_eq!(migrated.bundle_preset, Some("ask".to_string()));
        assert_eq!(migrated.bundle_mode, Some("standard".to_string()));
        assert!(migrated.selected_paths.is_some());
        assert!(migrated.prompt_runs.is_some());
        assert!(migrated.prompt_templates.is_some());

        let partial_json = r#"{
            "version": 0,
            "contextLimit": 32000,
            "bundlePreset": "refactor"
        }"#;
        let config2: VaultConfig = serde_json::from_str(partial_json).unwrap();
        let migrated2 = migrate_config(config2);
        assert_eq!(migrated2.version, Some(1));
        assert_eq!(migrated2.context_limit, Some(32000));
        assert_eq!(migrated2.bundle_preset, Some("refactor".to_string()));
        assert_eq!(migrated2.bundle_mode, Some("standard".to_string()));
    }

    #[test]
    fn config_json_keeps_valid_fields_when_other_fields_are_malformed() {
        let config = vault_config_from_json(r#"{
            "version": "bad",
            "contextLimit": 32000,
            "bundlePreset": "refactor",
            "selectedPaths": {
                "Home.md": ["Home.md", 123, null]
            },
            "promptInstructions": {
                "Home.md": "Review this",
                "Broken.md": false
            },
            "promptRuns": [
                {
                    "id": "run-1",
                    "question": "Question",
                    "selectedNotes": ["Home.md"],
                    "preset": "ask",
                    "mode": "standard",
                    "tokenCount": 10,
                    "createdAt": "2026-06-05T00:00:00.000Z",
                    "activePath": "Home.md"
                },
                { "id": 1 }
            ]
        }"#);
        let migrated = migrate_config(config);

        assert_eq!(migrated.version, Some(1));
        assert_eq!(migrated.context_limit, Some(32000));
        assert_eq!(migrated.bundle_preset, Some("refactor".to_string()));
        assert_eq!(migrated.selected_paths.as_ref().unwrap().get("Home.md").unwrap(), &vec!["Home.md".to_string()]);
        assert_eq!(migrated.prompt_instructions.as_ref().unwrap().get("Home.md").unwrap(), "Review this");
        assert_eq!(migrated.prompt_runs.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn context_bundle_uses_selected_candidate_paths() {
        let mut project = parsed("Project.md", "Project");
        project.links = vec![NoteLink {
            source_path: "Project.md".to_string(),
            target_ref: "Research".to_string(),
            resolved_path: Some("Research.md".to_string()),
            line: 3,
            is_managed: false,
        }];
        let mut home = parsed("Home.md", "Home");
        home.links = vec![NoteLink {
            source_path: "Home.md".to_string(),
            target_ref: "Project".to_string(),
            resolved_path: Some("Project.md".to_string()),
            line: 3,
            is_managed: false,
        }];
        let notes = vec![project, parsed("Research.md", "Research"), home];

        let candidates = context_bundle_candidates(&notes, "Project.md").unwrap();
        assert_eq!(candidates.iter().map(|candidate| candidate.path.as_str()).collect::<Vec<_>>(), vec!["Project.md", "Research.md", "Home.md"]);

        let bundle = create_context_bundle(
            &notes,
            "Project.md",
            ContextBundleOptions {
                selected_paths: Some(vec!["Project.md".to_string(), "Home.md".to_string()]),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(bundle.note_paths, vec!["Project.md", "Home.md"]);
        assert!(bundle.markdown.contains("## Note: Project"));
        assert!(bundle.markdown.contains("## Note: Home"));
        assert!(!bundle.markdown.contains("## Note: Research"));
    }

    #[test]
    fn context_bundle_modes_and_purpose() {
        let mut project = parsed("Project.md", "Project");
        project.content = "# Project\n\nThis is a longer body text for testing.".to_string();
        project.links = vec![NoteLink {
            source_path: "Project.md".to_string(),
            target_ref: "Research".to_string(),
            resolved_path: Some("Research.md".to_string()),
            line: 3,
            is_managed: false,
        }];
        let mut home = parsed("Home.md", "Home");
        home.links = vec![NoteLink {
            source_path: "Home.md".to_string(),
            target_ref: "Project".to_string(),
            resolved_path: Some("Project.md".to_string()),
            line: 3,
            is_managed: false,
        }];
        let notes = vec![project, parsed("Research.md", "Research"), home];

        // Short Mode
        let bundle_short = create_context_bundle(
            &notes,
            "Project.md",
            ContextBundleOptions {
                selected_paths: None,
                purpose: Some("Summarize it".to_string()),
                mode: Some("short".to_string()),
                preset: None,
            },
        )
        .unwrap();
        assert!(bundle_short.markdown.contains("**Mode**: Short"));
        assert!(bundle_short.markdown.contains("**Purpose**: Summarize it"));
        assert!(bundle_short.markdown.contains("This is a longer body text for testing."));
        assert!(bundle_short.estimated_tokens > 0);

        // Full Mode
        let bundle_full = create_context_bundle(
            &notes,
            "Project.md",
            ContextBundleOptions {
                selected_paths: None,
                purpose: None,
                mode: Some("full".to_string()),
                preset: None,
            },
        )
        .unwrap();
        assert!(bundle_full.markdown.contains("**Mode**: Full"));
        assert!(bundle_full.markdown.contains("### Links"));
        assert!(bundle_full.markdown.contains("- **Outgoing**:"));
        assert!(bundle_full.markdown.contains("  - [[Research]] (`Research.md`)"));

        // Preset Mode
        let bundle_preset = create_context_bundle(
            &notes,
            "Project.md",
            ContextBundleOptions {
                selected_paths: None,
                purpose: Some("Review code".to_string()),
                mode: Some("full".to_string()),
                preset: Some("refactor".to_string()),
            },
        )
        .unwrap();
        assert!(bundle_preset.markdown.contains("**Preset**: Refactor"));
        assert!(bundle_preset.markdown.contains("**Mode**: Full"));
        assert!(bundle_preset.markdown.contains("**Purpose**: Review code"));
    }

    #[test]
    fn inbox_capture_formats_related_daily_entry() {
        let captured_at = "2026-06-04T06:30:00.000Z";

        assert_eq!(inbox_path_for_capture(captured_at).unwrap(), "Inbox/2026-06-04.md");
        assert_eq!(
            format_inbox_capture("Keep this answer.", Some("Project"), captured_at).unwrap(),
            "## 2026-06-04 06:30\n\nRelated: [[Project]]\n\n#inbox\n\nKeep this answer.\n"
        );
    }

    #[test]
    fn inbox_capture_moves_to_processed_section() {
        let markdown = "# 2026-06-04\n\n## 2026-06-04 06:30\n\n#inbox\n\nKeep this answer.\n";

        let captures = parse_inbox_captures(markdown);
        assert_eq!(captures.len(), 1);
        assert_eq!(captures[0].id, "2026-06-04 06:30");

        let processed = move_inbox_capture_to_processed(markdown, "2026-06-04 06:30").unwrap();
        assert!(processed.contains("## Processed"));
        assert!(processed.ends_with("## 2026-06-04 06:30\n\n#inbox\n\nKeep this answer.\n"));
        assert_eq!(parse_inbox_captures(&processed).len(), 0);
    }

    #[test]
    fn inbox_capture_assigns_unique_duplicate_ids_and_moves_selected_block() {
        let markdown = "# 2026-06-04\n\n## 2026-06-04 06:30\n\n#inbox\n\nFirst captured idea.\n\n## 2026-06-04 06:30\n\n#inbox\n\nSecond captured idea.\n";

        let captures = parse_inbox_captures(markdown);
        assert_eq!(captures.iter().map(|capture| capture.id.as_str()).collect::<Vec<_>>(), vec!["2026-06-04 06:30", "2026-06-04 06:30#2"]);

        let processed = move_inbox_capture_to_processed(markdown, "2026-06-04 06:30#2").unwrap();
        let remaining = parse_inbox_captures(&processed);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].body, "First captured idea.");
        assert!(processed.contains("## Processed"));
        assert!(processed.contains("Second captured idea."));
    }

    #[test]
    fn test_append_inbox_capture_formatting() {
        let target_content_no_newline = "# Target Note";
        let target_content_with_newline = "# Target Note\n";
        let target_content_with_two_newlines = "# Target Note\n\n";
        
        let title = "2026-06-04 06:30";
        let body = "This is a body.";
        
        let fmt = |content: &str| {
            let separator = if content.ends_with("\n\n") {
                ""
            } else if content.ends_with('\n') {
                "\n"
            } else {
                "\n\n"
            };
            format!("{}{}", content, format!("{}### Appended Capture ({})\n\n{}\n", separator, title, body.trim()))
        };
        
        assert_eq!(fmt(target_content_no_newline), "# Target Note\n\n### Appended Capture (2026-06-04 06:30)\n\nThis is a body.\n");
        assert_eq!(fmt(target_content_with_newline), "# Target Note\n\n### Appended Capture (2026-06-04 06:30)\n\nThis is a body.\n");
        assert_eq!(fmt(target_content_with_two_newlines), "# Target Note\n\n### Appended Capture (2026-06-04 06:30)\n\nThis is a body.\n");
    }

    #[test]
    fn test_is_title_mentioned() {
        assert!(count_title_mentions("Hello, this is a Project note.", "Project") > 0);
        assert_eq!(count_title_mentions("Hello, this is a ProjectNote.", "Project"), 0);
        assert!(count_title_mentions("AIM is not a title mention, but AI is.", "AI") > 0);
        assert!(count_title_mentions("프로젝트 노트를 확인합니다.", "프로젝트") > 0);
        assert_eq!(count_title_mentions("프로젝트노트를 확인합니다.", "프로젝트"), 0);
    }

    #[test]
    fn test_recommended_candidates() {
        let mut p = parsed("Project.md", "Project");
        p.meta.tags = vec!["general".to_string()];
        
        let mut h = parsed("Home.md", "Home");
        h.content = "# Home\n\nMentions Project in text.".to_string();
        h.meta.tags = vec!["general".to_string()];
        
        let notes = vec![p, h, parsed("Unrelated.md", "Unrelated")];
        let candidates = context_bundle_candidates(&notes, "Project.md").unwrap();
        
        let home_candidate = candidates.iter().find(|c| c.path == "Home.md").unwrap();
        assert_eq!(home_candidate.reason, "Recommended");
        assert_eq!(home_candidate.reason_detail, "Shares tags: #general; mentions focus 1 time(s)");
        assert_eq!(home_candidate.score, 6.0);
        assert!(home_candidate.excerpt.contains("Mentions Project"));
        assert!(!home_candidate.selected);
        
        assert!(candidates.iter().find(|c| c.path == "Unrelated.md").is_none());
    }

    #[test]
    fn test_recommends_notes_that_mention_focus_title() {
        let p = parsed("Project.md", "Project");
        let mut meeting = parsed("Meeting.md", "Meeting");
        meeting.content = "# Meeting\n\nWe discussed Project in plain text.".to_string();

        let notes = vec![p, meeting, parsed("Other.md", "Other")];
        let candidates = context_bundle_candidates(&notes, "Project.md").unwrap();

        assert!(candidates.iter().any(|candidate| candidate.path == "Meeting.md" && candidate.reason == "Recommended"));
        assert!(candidates.iter().all(|candidate| candidate.path != "Other.md"));
    }

    #[test]
    fn test_estimate_tokens() {
        assert_eq!(estimate_tokens("Hello World"), 3); // 11 English chars / 4 = 2.75 -> ceil -> 3
        assert_eq!(estimate_tokens("한글"), 3); // 2 CJK chars * 1.2 = 2.4 -> ceil -> 3
        assert_eq!(estimate_tokens("Hello 한글"), 4); // 6 English / 4 = 1.5, 2 CJK * 1.2 = 2.4. Sum = 3.9 -> ceil -> 4
    }

    #[test]
    fn reads_obsidian_settings_from_vault_metadata() {
        let root = temp_test_dir("obsidian-settings");
        let obsidian = root.join(".obsidian");
        fs::create_dir_all(&obsidian).unwrap();
        fs::write(obsidian.join("app.json"), r#"{"readableLineLength":true,"attachmentFolderPath":"assets"}"#).unwrap();
        fs::write(obsidian.join("appearance.json"), r##"{"theme":"obsidian","accentColor":"#7c3aed","cssSnippets":["custom-font","dark-mode"]}"##).unwrap();
        fs::write(obsidian.join("core-plugins.json"), r#"{"backlink":true,"graph":true,"canvas":false}"#).unwrap();
        fs::write(obsidian.join("hotkeys.json"), r#"{"editor:toggle-source":[{"modifiers":["Mod","Shift"],"key":"I"}]}"#).unwrap();

        let settings = read_obsidian_settings(&root).unwrap();

        assert!(settings.detected);
        assert_eq!(settings.readable_line_length, Some(true));
        assert_eq!(settings.theme.as_deref(), Some("obsidian"));
        assert_eq!(settings.accent_color.as_deref(), Some("#7c3aed"));
        assert_eq!(settings.enabled_core_plugins, vec!["backlink".to_string(), "graph".to_string()]);
        assert_eq!(settings.attachment_folder_path.as_deref(), Some("assets"));
        assert_eq!(settings.css_snippets, vec!["custom-font".to_string(), "dark-mode".to_string()]);
        assert!(settings.hotkeys.is_some());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_cosine_similarity() {
        let vec_a = vec![1.0, 0.0, 1.0];
        let vec_b = vec![0.0, 1.0, 0.0];
        let vec_c = vec![1.0, 0.0, 1.0];
        assert_eq!(cosine_similarity(&vec_a, &vec_b), 0.0);
        assert!((cosine_similarity(&vec_a, &vec_c) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn test_clean_wiki_links() {
        let text = "This is a [[Wiki Link]] inside.";
        let cleaned = clean_wiki_links(text);
        assert_eq!(cleaned.len(), text.len());
        assert!(!cleaned.contains("Wiki"));
        assert!(!cleaned.contains("Link"));
    }

    #[test]
    fn test_get_excerpt_around_match() {
        let content = "Line 1\nLine 2 with match\nLine 3\nLine 4";
        let excerpt = get_excerpt_around_match(content, 12);
        assert!(excerpt.contains("Line 1"));
        assert!(excerpt.contains("Line 2 with match"));
        assert!(excerpt.contains("Line 3"));
        assert!(!excerpt.contains("Line 4"));
    }
}
