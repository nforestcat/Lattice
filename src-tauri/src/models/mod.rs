use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub frontmatter: HashMap<String, String>,
    pub modified_at: Option<String>,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteLink {
    pub source_path: String,
    pub target_ref: String,
    pub resolved_path: Option<String>,
    pub line: usize,
    pub is_managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedNote {
    #[serde(flatten)]
    pub meta: NoteMeta,
    pub content: String,
    pub links: Vec<NoteLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub children: Vec<FileTreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSnapshot {
    pub root_path: String,
    pub notes: Vec<NoteMeta>,
    pub tree: Vec<FileTreeNode>,
    pub obsidian_settings: Option<ObsidianSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianSettings {
    pub detected: bool,
    pub readable_line_length: Option<bool>,
    pub theme: Option<String>,
    pub accent_color: Option<String>,
    pub enabled_core_plugins: Vec<String>,
    pub attachment_folder_path: Option<String>,
    pub css_snippets: Vec<String>,
    pub hotkeys: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDocument {
    pub path: String,
    pub content: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub saved: bool,
    pub revision: String,
    pub conflict: bool,
    pub snapshot_id: Option<String>,
    pub git_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    pub query: String,
    pub tags: Option<Vec<String>>,
    pub frontmatter: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContext {
    pub note: ParsedNote,
    pub backlinks: Vec<NoteLink>,
    pub outgoing_links: Vec<NoteLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub is_managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub focused_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkMutationResult {
    pub note: NoteDocument,
    pub graph: GraphData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryMutationResult {
    pub vault: VaultSnapshot,
    pub selected_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInput {
    pub content: String,
    pub related_path: Option<String>,
    pub captured_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxCaptureBlock {
    pub id: String,
    pub title: String,
    pub related_title: Option<String>,
    pub body: String,
    pub markdown: String,
}

#[derive(Debug, Clone)]
pub struct InboxCaptureSpan {
    pub capture: InboxCaptureBlock,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteInboxCaptureInput {
    pub inbox_path: String,
    pub capture_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendInboxCaptureInput {
    pub inbox_path: String,
    pub capture_id: String,
    pub target_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBundle {
    pub title: String,
    pub focus_path: String,
    pub note_paths: Vec<String>,
    pub markdown: String,
    pub estimated_tokens: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextBundleOptions {
    pub selected_paths: Option<Vec<String>>,
    pub purpose: Option<String>,
    pub mode: Option<String>,
    pub preset: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBundleCandidate {
    pub path: String,
    pub title: String,
    pub reason: String,
    pub reason_detail: String,
    pub score: f64,
    pub excerpt: String,
    pub token_estimate: usize,
    pub selected: bool,
    pub character_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRecord {
    pub id: String,
    pub path: String,
    pub created_at: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub auto_git_enabled: bool,
    pub branch: Option<String>,
    pub has_changes: bool,
    pub has_conflicts: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSettings {
    pub auto_git_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRun {
    pub id: String,
    pub question: String,
    pub selected_notes: Vec<String>,
    pub preset: String,
    #[serde(default)]
    pub purpose: Option<String>,
    pub mode: String,
    pub token_count: usize,
    pub created_at: String,
    pub active_path: String,
    pub prompt_hash: Option<String>,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    pub id: String,
    pub name: String,
    pub template: String,
    pub is_system: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub provider: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub embedding_model: Option<String>,
    #[serde(default)]
    pub embedding_provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NoteTemplate {
    pub name: String,
    pub description: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultConfig {
    #[serde(default)]
    pub version: Option<usize>,
    #[serde(default)]
    pub context_limit: Option<usize>,
    #[serde(default)]
    pub bundle_preset: Option<String>,
    #[serde(default)]
    pub bundle_purpose: Option<String>,
    #[serde(default)]
    pub bundle_mode: Option<String>,
    #[serde(default)]
    pub selected_paths: Option<HashMap<String, Vec<String>>>,
    #[serde(default)]
    pub prompt_instructions: Option<HashMap<String, String>>,
    #[serde(default)]
    pub prompt_runs: Option<Vec<PromptRun>>,
    #[serde(default)]
    pub prompt_templates: Option<Vec<PromptTemplate>>,
    #[serde(default)]
    pub llm_config: Option<LlmConfig>,
    #[serde(default)]
    pub archive_retention_policy: Option<String>,
    #[serde(default)]
    pub note_templates: Option<Vec<NoteTemplate>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: String, // "modified" | "added" | "deleted" | "untracked" | "renamed"
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveStatus {
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkSuggestion {
    pub id: String,
    pub source_path: String,
    pub source_title: String,
    pub target_path: String,
    pub target_title: String,
    pub suggestion_type: String, // "unlinked_mention" | "semantic"
    pub excerpt: String,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedLinkSource {
    pub path: String,
    pub title: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedLinkGroup {
    pub target: String,
    pub sources: Vec<UnresolvedLinkSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedEdit {
    pub id: String,
    #[serde(rename = "type")]
    pub edit_type: String,
    pub path: String,
    pub new_path: Option<String>,
    pub content: Option<String>,
    pub target_content: Option<String>,
    pub replacement_content: Option<String>,
    pub reason: Option<String>,
    pub applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteHealthReport {
    pub path: String,
    pub title: String,
    pub score: usize,
    pub issues: Vec<String>,
    pub is_orphan: bool,
    pub is_stale: bool,
    pub is_too_broad: bool,
    pub is_duplicated: bool,
    pub missing_summary: bool,
    pub weak_backlinks: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestRaw {
    pub title: Option<String>,
    pub text: String,
    pub source_ref: String,
    pub source_type: String,
    pub ingest_date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictHunk {
    pub index: usize,
    pub ours: String,
    pub theirs: String,
    pub resolved: bool,
    pub resolution: Option<String>,
    pub manual_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub hunks: Vec<ConflictHunk>,
}
