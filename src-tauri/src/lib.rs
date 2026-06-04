use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
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
struct ContextBundle {
    title: String,
    focus_path: String,
    note_paths: Vec<String>,
    markdown: String,
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
fn get_context_bundle(path: String, state: tauri::State<AppState>) -> Result<ContextBundle, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    create_context_bundle(&guard.notes, &path)
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
    fs::write(root.join(&snapshot.path), &content).map_err(|error| error.to_string())?;
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

fn create_context_bundle(notes: &[ParsedNote], focus_path: &str) -> Result<ContextBundle, String> {
    let context = note_context(notes, focus_path)?;
    let mut included: Vec<(ParsedNote, &'static str)> = vec![(context.note.clone(), "Focus")];

    for link in &context.outgoing_links {
        if let Some(resolved_path) = &link.resolved_path {
            if !included.iter().any(|(note, _)| note.meta.path == *resolved_path) {
                if let Some(note) = notes.iter().find(|note| note.meta.path == *resolved_path) {
                    included.push((note.clone(), "Outgoing"));
                }
            }
        }
    }

    for link in &context.backlinks {
        if !included.iter().any(|(note, _)| note.meta.path == link.source_path) {
            if let Some(note) = notes.iter().find(|note| note.meta.path == link.source_path) {
                included.push((note.clone(), "Backlink"));
            }
        }
    }

    let title = format!("Context Bundle: {}", context.note.meta.title);
    Ok(ContextBundle {
        title: title.clone(),
        focus_path: focus_path.to_string(),
        note_paths: included.iter().map(|(note, _)| note.meta.path.clone()).collect(),
        markdown: render_context_bundle(&title, &included),
    })
}

fn render_context_bundle(title: &str, included: &[(ParsedNote, &'static str)]) -> String {
    let mut lines = vec![
        format!("# {}", title),
        String::new(),
        "## Included Notes".to_string(),
    ];

    for (note, reason) in included {
        lines.push(format!("- {}: [[{}]] (`{}`)", reason, note.meta.title, note.meta.path));
    }

    lines.extend([
        String::new(),
        "## Instructions".to_string(),
        String::new(),
        "Use this bundle as local wiki context. Prefer cited note names when answering or proposing edits.".to_string(),
        String::new(),
    ]);

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

        lines.push(note.content.trim().to_string());
        lines.push(String::new());
    }

    format!("{}\n", lines.join("\n").trim())
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
            get_context_bundle,
            search_notes,
            get_note_context,
            get_graph,
            create_graph_link,
            delete_managed_graph_link,
            list_snapshots,
            restore_snapshot,
            get_git_status,
            set_auto_git
        ])
        .run(tauri::generate_context!())
        .expect("error while running Local Vault Notes");
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn unique_note_path_adds_numeric_suffixes() {
        let existing = vec![
            parsed("Projects/New Note.md", "New Note"),
            parsed("Projects/New Note 2.md", "New Note 2"),
        ];

        assert_eq!(unique_note_path("Projects", "New Note", &existing), "Projects/New Note 3.md");
    }
}
