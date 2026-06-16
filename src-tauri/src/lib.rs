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

mod models;
use models::*;
mod commands;

#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) inner: Mutex<VaultState>,
}

#[derive(Default)]
pub(crate) struct VaultState {
    pub(crate) root_path: Option<PathBuf>,
    pub(crate) notes: Vec<ParsedNote>,
    pub(crate) snapshots: Vec<SnapshotRecord>,
    pub(crate) snapshot_content: HashMap<String, String>,
    pub(crate) auto_git_enabled: bool,
}

static FALLBACK_KEYS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn save_api_key_in_keyring(provider: &str, key: &str) -> Result<(), String> {
    let key_trimmed = key.trim();
    
    if key_trimmed.is_empty() {
        let mut guard = FALLBACK_KEYS.lock().unwrap();
        if let Some(map) = guard.as_mut() {
            map.remove(provider);
        }
    }

    match keyring::Entry::new("lattice", provider) {
        Ok(entry) => {
            if key_trimmed.is_empty() {
                let _ = entry.delete_password();
            } else {
                if let Err(_) = entry.set_password(key_trimmed) {
                    let mut guard = FALLBACK_KEYS.lock().unwrap();
                    let map = guard.get_or_insert_with(HashMap::new);
                    map.insert(provider.to_string(), key_trimmed.to_string());
                }
            }
        }
        Err(_) => {
            let mut guard = FALLBACK_KEYS.lock().unwrap();
            let map = guard.get_or_insert_with(HashMap::new);
            if key_trimmed.is_empty() {
                map.remove(provider);
            } else {
                map.insert(provider.to_string(), key_trimmed.to_string());
            }
        }
    }
    Ok(())
}

fn get_api_key_from_keyring(provider: &str) -> Option<String> {
    if let Ok(entry) = keyring::Entry::new("lattice", provider) {
        if let Ok(pass) = entry.get_password() {
            return Some(pass);
        }
    }
    let guard = FALLBACK_KEYS.lock().unwrap();
    if let Some(map) = guard.as_ref() {
        return map.get(provider).cloned();
    }
    None
}



























fn parse_status_conflicts(stdout: &[u8]) -> bool {
    let parts: Vec<&[u8]> = stdout.split(|&b| b == 0).collect();
    for part in parts {
        if part.is_empty() {
            continue;
        }
        let part_str = String::from_utf8_lossy(part);
        if part_str.len() >= 4 {
            let x = part_str.chars().nth(0).unwrap_or(' ');
            let y = part_str.chars().nth(1).unwrap_or(' ');
            if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
                return true;
            }
        }
    }
    false
}

fn has_conflicts(root: &Path) -> bool {
    if let Ok(cmd_output) = Command::new("git")
        .args(&["status", "--porcelain", "-z"])
        .current_dir(root)
        .output()
    {
        if cmd_output.status.success() {
            return parse_status_conflicts(&cmd_output.stdout);
        }
    }
    false
}

fn staged_conflict_marker_file(root: &Path, paths: &[&str]) -> Result<Option<String>, String> {
    let mut diff_args = vec!["diff", "--cached", "--name-only", "-z"];
    if !paths.is_empty() {
        diff_args.push("--");
        diff_args.extend(paths.iter().copied());
    }

    let staged_files_output = Command::new("git")
        .args(&diff_args)
        .current_dir(root)
        .output()
        .map_err(|error| error.to_string())?;

    if !staged_files_output.status.success() {
        return Err(String::from_utf8_lossy(&staged_files_output.stderr).trim().to_string());
    }

    for part in staged_files_output.stdout.split(|&b| b == 0) {
        if part.is_empty() {
            continue;
        }
        let rel_path = String::from_utf8_lossy(part);
        if let Ok(show_output) = Command::new("git")
            .args(&["show", &format!(":{}", rel_path)])
            .current_dir(root)
            .output()
        {
            if show_output.status.success() {
                let content = String::from_utf8_lossy(&show_output.stdout);
                let has_conflict = content.lines().any(|l| {
                    l.starts_with("<<<<<<<") || l.starts_with("=======") || l.starts_with(">>>>>>>")
                });
                if has_conflict {
                    return Ok(Some(rel_path.to_string()));
                }
            }
        }
    }

    Ok(None)
}




fn git_changes_for_root(root: &Path) -> Result<Vec<GitFileChange>, String> {
    let is_repo = git_output(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|value| value == "true")
        .unwrap_or(false);
    if !is_repo {
        return Ok(Vec::new());
    }
    
    let cmd_output = Command::new("git")
        .args(&["status", "--porcelain", "-z"])
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;
    
    if !cmd_output.status.success() {
        return Err(String::from_utf8_lossy(&cmd_output.stderr).trim().to_string());
    }

    let stdout = cmd_output.stdout;
    let parts: Vec<&[u8]> = stdout.split(|&b| b == 0).collect();
    let mut changes = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let part = parts[i];
        if part.is_empty() {
            i += 1;
            continue;
        }
        let part_str = String::from_utf8_lossy(part);
        if part_str.len() < 4 {
            i += 1;
            continue;
        }
        let x = part_str.chars().nth(0).unwrap_or(' ');
        let y = part_str.chars().nth(1).unwrap_or(' ');
        let path = part_str[3..].to_string();

        if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            changes.push(GitFileChange {
                path,
                status: "conflict".to_string(),
                staged: false,
            });
            i += 1;
        } else if x == '?' && y == '?' {
            changes.push(GitFileChange {
                path,
                status: "untracked".to_string(),
                staged: false,
            });
            i += 1;
        } else if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            if i + 1 < parts.len() {
                let status = if x == 'R' || y == 'R' { "renamed" } else { "added" };
                let staged = x == 'R' || x == 'C' || (x != ' ' && x != '?');
                changes.push(GitFileChange {
                    path,
                    status: status.to_string(),
                    staged,
                });
                i += 2;
            } else {
                i += 1;
            }
        } else {
            // Check staged (index)
            if x != ' ' {
                let status = match x {
                    'M' => "modified",
                    'A' => "added",
                    'D' => "deleted",
                    _ => "modified",
                };
                changes.push(GitFileChange {
                    path: path.clone(),
                    status: status.to_string(),
                    staged: true,
                });
            }
            // Check unstaged (working tree)
            if y != ' ' {
                let status = match y {
                    'M' => "modified",
                    'D' => "deleted",
                    _ => "modified",
                };
                changes.push(GitFileChange {
                    path,
                    status: status.to_string(),
                    staged: false,
                });
            }
            i += 1;
        }
    }
    Ok(changes)
}




fn git_unstage_file_in_root(root: &Path, path: &str) -> Result<(), String> {
    // Guard against real reset failures on mature repositories by verifying HEAD first
    let head_exists = git_output(root, &["rev-parse", "--verify", "HEAD"]).is_ok();
    if head_exists {
        // Resolve if it's a rename to unstage both old and new paths
        let mut paths_to_reset = vec![path.to_string()];
        if let Ok(status_output) = Command::new("git").args(&["status", "--porcelain", "-z"]).current_dir(root).output() {
            if status_output.status.success() {
                let stdout = status_output.stdout;
                let parts: Vec<&[u8]> = stdout.split(|&b| b == 0).collect();
                let mut i = 0;
                while i < parts.len() {
                    let part = parts[i];
                    if part.is_empty() {
                        i += 1;
                        continue;
                    }
                    let part_str = String::from_utf8_lossy(part);
                    if part_str.len() >= 4 {
                        let x = part_str.chars().nth(0).unwrap_or(' ');
                        let _y = part_str.chars().nth(1).unwrap_or(' ');
                        let new_path = part_str[3..].to_string();
                        if (x == 'R' || x == 'C') && i + 1 < parts.len() {
                            let old_path = String::from_utf8_lossy(parts[i + 1]).to_string();
                            if new_path == path {
                                paths_to_reset.push(old_path);
                            }
                            i += 2;
                            continue;
                        }
                    }
                    i += 1;
                }
            }
        }
        for p in paths_to_reset {
            git_output(root, &["reset", "HEAD", "--", &p])?;
        }
    } else {
        git_output(root, &["rm", "--cached", "--", &path])?;
    }
    Ok(())
}



fn git_commit_in_root(root: &Path, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    
    // Safety guard: reject if repository has active conflicts
    if has_conflicts(root) {
        return Err("Cannot commit: repository has unresolved merge conflicts. Please resolve conflicts first.".to_string());
    }

    let porcelain = git_output(root, &["status", "--porcelain"]).unwrap_or_default();
    let has_staged = porcelain.lines().any(|line| {
        if line.len() >= 2 {
            let x = line.chars().next().unwrap_or(' ');
            x != ' ' && x != '?'
        } else {
            false
        }
    });
    if !has_staged {
        return Err("No staged changes to commit. Please stage changes first.".to_string());
    }

    if let Some(path) = staged_conflict_marker_file(root, &[])? {
        return Err(format!(
            "Cannot commit: File '{}' contains unresolved merge conflict markers.",
            path
        ));
    }

    git_output(root, &["commit", "-m", message])
}


fn git_pull_in_root(root: &Path) -> Result<String, String> {
    if has_conflicts(root) {
        return Err("Cannot pull: repository has unresolved merge conflicts. Please resolve conflicts first.".to_string());
    }
    git_output_all(root, &["pull"])
}


fn git_push_in_root(root: &Path) -> Result<String, String> {
    if has_conflicts(root) {
        return Err("Cannot push: repository has unresolved merge conflicts. Please resolve conflicts first.".to_string());
    }
    git_output_all(root, &["push"])
}

const STASH_MARKER: &str = "wiki-pull-autostash";

pub(crate) fn git_pull_preflight_in_root(root: &Path) -> Result<PullPreflight, String> {
    let dirty_files = git_changes_for_root(root)?;
    let is_clean = dirty_files.is_empty();
    let has_conflicts_now = has_conflicts(root);
    Ok(PullPreflight {
        is_clean,
        dirty_files,
        has_conflicts: has_conflicts_now,
    })
}

pub(crate) fn git_stash_push_in_root(root: &Path) -> Result<String, String> {
    git_output_all(
        root,
        &["stash", "push", "--include-untracked", "-m", STASH_MARKER],
    )
}

fn parse_stash_list_for_marker(list_output: &str) -> Option<String> {
    for line in list_output.lines() {
        if line.contains(STASH_MARKER) {
            if let Some(idx) = line.find(':') {
                return Some(line[..idx].trim().to_string());
            }
        }
    }
    None
}

fn resolve_stash_ref_by_marker(root: &Path) -> Result<Option<String>, String> {
    let list = git_output(root, &["stash", "list"])?;
    Ok(parse_stash_list_for_marker(&list))
}

pub(crate) fn git_stash_pop_in_root(root: &Path, with_index: bool) -> Result<StashPopResult, String> {
    let Some(stash_ref) = resolve_stash_ref_by_marker(root)? else {
        return Err("No autostash entry found".to_string());
    };
    let mut args: Vec<&str> = vec!["stash", "pop"];
    if with_index {
        args.push("--index");
    }
    args.push(stash_ref.as_str());

    match git_output_all(root, &args) {
        Ok(_) => Ok(StashPopResult {
            status: "clean".to_string(),
            stash_ref: None,
        }),
        Err(_) => {
            // pop이 실패(충돌)했어도 stash entry가 남아있을 수 있음 -> 재해석
            let surviving_ref = resolve_stash_ref_by_marker(root)?;
            Ok(StashPopResult {
                status: "conflict".to_string(),
                stash_ref: surviving_ref,
            })
        }
    }
}

pub(crate) fn git_stash_drop_in_root(root: &Path) -> Result<String, String> {
    let Some(stash_ref) = resolve_stash_ref_by_marker(root)? else {
        return Err("No autostash entry found to drop".to_string());
    };
    git_output_all(root, &["stash", "drop", &stash_ref])
}

pub(crate) fn git_merge_head_exists_in_root(root: &Path) -> bool {
    Command::new("git")
        .args(&["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .current_dir(root)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub(crate) fn format_commit_message(entries: &[(String, String)]) -> String {
    let mut added = vec![];
    let mut modified = vec![];
    let mut deleted = vec![];
    let mut other = vec![];

    for (status, path) in entries {
        match status.as_str() {
            "A" => added.push(path.as_str()),
            "M" => modified.push(path.as_str()),
            "D" => deleted.push(path.as_str()),
            _ => other.push(path.as_str()),
        }
    }

    let total = entries.len();
    let mut lines = vec![format!("chore(wiki): update {} file(s)", total)];
    lines.push(String::new());
    for p in &added    { lines.push(format!("- add: {}", p)); }
    for p in &modified { lines.push(format!("- modify: {}", p)); }
    for p in &deleted  { lines.push(format!("- delete: {}", p)); }
    for p in &other    { lines.push(format!("- change: {}", p)); }
    lines.join("\n")
}

pub(crate) fn suggest_commit_message_in_root(root: &std::path::Path) -> Result<String, String> {
    let output = git_output(root, &["diff", "--cached", "--name-status"])?;
    let entries: Vec<(String, String)> = output
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| {
            let mut parts = l.splitn(2, '\t');
            let status = parts.next()?.trim().to_string();
            let path = parts.next()?.trim().to_string();
            Some((status, path))
        })
        .collect();
    if entries.is_empty() {
        return Err("No staged changes".to_string());
    }
    Ok(format_commit_message(&entries))
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
        archive_retention_policy: object.get("archiveRetentionPolicy").and_then(serde_json::Value::as_str).map(str::to_string),
        note_templates: object.get("noteTemplates").and_then(|value| {
            value.as_array().map(|templates| {
                templates.iter()
                    .filter_map(|template| serde_json::from_value::<NoteTemplate>(template.clone()).ok())
                    .collect::<Vec<_>>()
            })
        }),
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







fn prompt_run_archive_path(root: &Path, run_id: &str) -> Result<PathBuf, String> {
    let is_safe = !run_id.is_empty()
        && run_id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
    if !is_safe {
        return Err("Invalid prompt run id".to_string());
    }
    Ok(root.join(".lattice").join("runs").join(format!("{}.md", run_id)))
}


fn embeddings_cache_path(root: &Path) -> PathBuf {
    root.join(".lattice").join("embeddings.json")
}

fn embeddings_status_path(root: &Path) -> PathBuf {
    root.join(".lattice").join("embeddings-status.json")
}



#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingEntry {
    content_hash: String,
    vector: Vec<f32>,
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


#[cfg(not(test))]
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
    let mut nodes: Vec<GraphNode> = notes.iter().map(|note| GraphNode {
        id: note.meta.path.clone(),
        label: note.meta.title.clone(),
        tags: note.meta.tags.clone(),
        kind: Some("note".to_string()),
    }).collect();

    let mut edges = Vec::new();
    let mut unresolved_targets = HashMap::new(); // normalized -> original
    let mut seen_unresolved_edges = HashSet::new(); // (source, target)

    for note in notes {
        for link in &note.links {
            if let Some(target) = &link.resolved_path {
                edges.push(GraphEdge {
                    id: format!("{}->{}->{}", note.meta.path, target, link.line),
                    source: note.meta.path.clone(),
                    target: target.clone(),
                    is_managed: link.is_managed,
                });
            } else {
                let target_ref = link.target_ref.clone();
                let normalized = normalize_ref(&target_ref);
                let ghost_id = format!("unresolved:{}", normalized);

                // Track unique unresolved targets, keeping the first display reference we see
                unresolved_targets.entry(normalized).or_insert(target_ref);

                // Deduplicate edges to unresolved targets per source/target pair
                let edge_key = (note.meta.path.clone(), ghost_id.clone());
                if !seen_unresolved_edges.contains(&edge_key) {
                    seen_unresolved_edges.insert(edge_key);
                    edges.push(GraphEdge {
                        id: format!("{}->{}", note.meta.path, ghost_id),
                        source: note.meta.path.clone(),
                        target: ghost_id,
                        is_managed: link.is_managed,
                    });
                }
            }
        }
    }

    // Add ghost nodes to the nodes list
    for (normalized, original) in unresolved_targets {
        nodes.push(GraphNode {
            id: format!("unresolved:{}", normalized),
            label: original,
            tags: vec![],
            kind: Some("unresolved".to_string()),
        });
    }

    GraphData {
        focused_path: None,
        nodes,
        edges,
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

fn git_output_all(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git").args(args).current_dir(root).output().map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let mut combined = Vec::new();
    if !stdout.is_empty() {
        combined.push(stdout);
    }
    if !stderr.is_empty() {
        combined.push(stderr);
    }
    let combined_str = combined.join("\n");
    if output.status.success() {
        Ok(combined_str)
    } else {
        Err(combined_str)
    }
}

fn auto_commit(root: &Path, path: &str) -> Result<String, String> {
    if has_conflicts(root) {
        return Err("Cannot auto-commit: repository has unresolved merge conflicts.".to_string());
    }
    git_output(root, &["add", path])?;
    if let Some(marker_path) = staged_conflict_marker_file(root, &[path])? {
        return Err(format!(
            "Cannot auto-commit: File '{}' contains unresolved merge conflict markers.",
            marker_path
        ));
    }
    git_output(root, &["commit", "-m", &format!("Update {}", path)])?;
    git_output(root, &["rev-parse", "--short", "HEAD"])
}

// ── Ingestion ──────────────────────────────────────────────────────────────

const MIN_EXTRACT_CHARS: usize = 200;

fn strip_html_tags(html: &str) -> String {
    let re = Regex::new(r"<[^>]+>").unwrap();
    let stripped = re.replace_all(html, " ");
    // collapse whitespace
    let ws = Regex::new(r"\s+").unwrap();
    ws.replace_all(stripped.as_ref(), " ").trim().to_string()
}




#[cfg(not(test))]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::vault::open_vault,
            commands::vault::read_note,
            commands::vault::save_note,
            commands::vault::create_note,
            commands::vault::create_folder,
            commands::vault::rename_entry,
            commands::vault::delete_entry,
            commands::vault::capture_to_inbox,
            commands::vault::get_inbox_captures,
            commands::vault::mark_inbox_capture_processed,
            commands::vault::promote_inbox_capture,
            commands::vault::append_inbox_capture,
            commands::vault::get_context_bundle,
            commands::vault::get_context_bundle_candidates,
            commands::vault::search_notes,
            commands::vault::get_note_context,
            commands::vault::get_graph,
            commands::vault::create_graph_link,
            commands::vault::delete_managed_graph_link,
            commands::vault::list_snapshots,
            commands::vault::restore_snapshot,
            commands::git::get_git_status,
            commands::git::set_auto_git,
            commands::git::get_git_changes,
            commands::git::get_git_diff,
            commands::git::git_stage_all,
            commands::git::git_commit,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_stage_file,
            commands::git::git_unstage_file,
            commands::git::get_conflict_files,
            commands::git::resolve_conflict_hunk,
            commands::git::mark_conflict_resolved,
            commands::git::suggest_commit_message,
            commands::git::git_pull_preflight,
            commands::git::git_stash_push,
            commands::git::git_stash_pop,
            commands::git::git_stash_drop,
            commands::git::git_merge_head_exists,
            commands::config::get_vault_config,
            commands::config::save_vault_config,
            commands::config::archive_prompt_run,
            commands::config::get_archived_prompt,
            commands::config::get_archive_status,
            commands::config::delete_archived_prompt,
            commands::config::prune_archived_prompts,
            commands::config::append_ai_audit,
            commands::config::check_ingest_duplicate,
            commands::config::load_embeddings_cache,
            commands::config::save_embeddings_cache,
            commands::config::load_embeddings_status,
            commands::config::save_embeddings_status,
            commands::config::get_unresolved_links,
            commands::config::parse_proposed_edits,
            commands::config::get_backlink_suggestions,
            commands::config::apply_backlink_suggestion,
            commands::config::apply_note_metadata,
            commands::llm::save_api_key,
            commands::llm::get_api_key,
            commands::llm::send_llm_chat_message,
            commands::llm::get_llm_embedding,
            commands::llm::fetch_provider_models,
            commands::config::get_wiki_health_report,
            commands::ingest::ingest_url,
            commands::ingest::ingest_pdf,
            commands::embedding::get_local_embedding_model_status,
            commands::embedding::download_local_embedding_model,
            commands::embedding::get_local_embedding
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

    #[test]
    fn test_unstage_in_unborn_repo() {
        let root = temp_test_dir("unborn-repo");
        git_output(&root, &["init"]).unwrap();

        let head_exists = git_output(&root, &["rev-parse", "--verify", "HEAD"]).is_ok();
        assert!(!head_exists);

        let test_file = "Test.md";
        fs::write(root.join(test_file), "# Test Content").unwrap();
        git_output(&root, &["add", test_file]).unwrap();

        let changes_before = git_changes_for_root(&root).unwrap();
        assert!(changes_before.iter().any(|c| c.path == test_file && c.staged));

        git_unstage_file_in_root(&root, test_file).unwrap();

        let changes_after = git_changes_for_root(&root).unwrap();
        assert!(changes_after.iter().any(|c| c.path == test_file && !c.staged));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_unstage_staged_rename_clears_index_delete() {
        let root = temp_test_dir("staged-rename");
        git_output(&root, &["init"]).unwrap();
        git_output(&root, &["config", "user.email", "test@example.com"]).unwrap();
        git_output(&root, &["config", "user.name", "Test User"]).unwrap();

        fs::write(root.join("Old.md"), "# Old").unwrap();
        git_output(&root, &["add", "Old.md"]).unwrap();
        git_output(&root, &["commit", "-m", "Initial commit"]).unwrap();
        git_output(&root, &["mv", "Old.md", "New.md"]).unwrap();

        let changes_before = git_changes_for_root(&root).unwrap();
        assert!(changes_before.iter().any(|change| {
            change.path == "New.md" && change.status == "renamed" && change.staged
        }));

        git_unstage_file_in_root(&root, "New.md").unwrap();

        let porcelain_output = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(porcelain_output.status.success());
        let porcelain = String::from_utf8_lossy(&porcelain_output.stdout);
        assert!(!porcelain.lines().any(|line| line.starts_with("D  Old.md")));
        assert!(porcelain.lines().any(|line| line == " D Old.md"));
        assert!(porcelain.lines().any(|line| line == "?? New.md"));

        let changes_after = git_changes_for_root(&root).unwrap();
        assert!(!changes_after.iter().any(|change| change.staged));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_parse_status_conflicts_logic() {
        let empty: &[u8] = b"";
        assert!(!parse_status_conflicts(empty));

        let non_conflict: &[u8] = b"M  src/lib.rs\0A  src/main.rs\0";
        assert!(!parse_status_conflicts(non_conflict));

        let conflict_uu: &[u8] = b"UU src/lib.rs\0";
        assert!(parse_status_conflicts(conflict_uu));

        let conflict_aa: &[u8] = b"AA src/lib.rs\0";
        assert!(parse_status_conflicts(conflict_aa));

        let conflict_dd: &[u8] = b"DD src/lib.rs\0";
        assert!(parse_status_conflicts(conflict_dd));

        let conflict_ud: &[u8] = b"UD src/lib.rs\0";
        assert!(parse_status_conflicts(conflict_ud));
    }

    #[test]
    fn test_conflict_guards() {
        let root = temp_test_dir("conflict-guards");
        git_output(&root, &["init"]).unwrap();
        git_output(&root, &["config", "user.email", "test@example.com"]).unwrap();
        git_output(&root, &["config", "user.name", "Test User"]).unwrap();

        let test_file = "Note.md";
        fs::write(root.join(test_file), "Initial content\n").unwrap();
        git_output(&root, &["add", test_file]).unwrap();
        git_output(&root, &["commit", "-m", "Initial commit"]).unwrap();

        // branch other
        git_output(&root, &["checkout", "-b", "other"]).unwrap();
        fs::write(root.join(test_file), "Other content\n").unwrap();
        git_output(&root, &["add", test_file]).unwrap();
        git_output(&root, &["commit", "-m", "Other commit"]).unwrap();

        // master
        git_output(&root, &["checkout", "master"]).unwrap();
        fs::write(root.join(test_file), "Master content\n").unwrap();
        git_output(&root, &["add", test_file]).unwrap();
        git_output(&root, &["commit", "-m", "Master commit"]).unwrap();

        // merge causing conflict
        let _ = git_output(&root, &["merge", "other"]);

        // 1. Verify has_conflicts detects unmerged files
        assert!(has_conflicts(&root));

        // 2. Verify git_commit returns conflict error
        let commit_res = git_commit_in_root(&root, "Try to commit during conflict");
        assert!(commit_res.is_err());
        assert!(commit_res.unwrap_err().contains("unresolved merge conflicts"));

        // 3. Verify git_pull returns conflict error
        let pull_res = git_pull_in_root(&root);
        assert!(pull_res.is_err());
        assert!(pull_res.unwrap_err().contains("unresolved merge conflicts"));

        // 4. Verify git_push returns conflict error
        let push_res = git_push_in_root(&root);
        assert!(push_res.is_err());
        assert!(push_res.unwrap_err().contains("unresolved merge conflicts"));

        // 5. Verify auto_commit returns conflict error
        let auto_res = auto_commit(&root, test_file);
        assert!(auto_res.is_err());
        assert!(auto_res.unwrap_err().contains("unresolved merge conflicts"));

        // Stage file with conflict markers to resolve git status's unmerged state
        fs::write(root.join(test_file), "<<<<<<<\nmaster\n=======\nother\n>>>>>>>\n").unwrap();
        git_output(&root, &["add", test_file]).unwrap();
        assert!(!has_conflicts(&root));

        // 6. Verify git_commit rejects commit because of index conflict markers
        let commit_res2 = git_commit_in_root(&root, "Commit file with markers");
        assert!(commit_res2.is_err());
        assert!(commit_res2.unwrap_err().contains("unresolved merge conflict markers"));

        let auto_marker_res = auto_commit(&root, test_file);
        assert!(auto_marker_res.is_err());
        assert!(auto_marker_res.unwrap_err().contains("unresolved merge conflict markers"));

        // Clean up and resolve
        fs::write(root.join(test_file), "Resolved content\n").unwrap();
        git_output(&root, &["add", test_file]).unwrap();
        let commit_res3 = git_commit_in_root(&root, "Resolved commit");
        assert!(commit_res3.is_ok());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_parse_stash_list_single_marker() {
        let list = "stash@{0}: On main: wiki-pull-autostash";
        assert_eq!(parse_stash_list_for_marker(list), Some("stash@{0}".to_string()));
    }

    #[test]
    fn test_parse_stash_list_marker_at_nonzero_ref() {
        let list = "stash@{0}: WIP on main: unrelated work\n\
                    stash@{1}: On main: wiki-pull-autostash\n\
                    stash@{2}: WIP on feature: other";
        assert_eq!(parse_stash_list_for_marker(list), Some("stash@{1}".to_string()));
    }

    #[test]
    fn test_parse_stash_list_no_marker() {
        let list = "stash@{0}: WIP on main: some work\n\
                    stash@{1}: WIP on feature: other";
        assert_eq!(parse_stash_list_for_marker(list), None);
    }

    #[test]
    fn test_format_commit_message_groups_by_status() {
        let entries = vec![
            ("A".to_string(), "a.md".to_string()),
            ("M".to_string(), "b.md".to_string()),
        ];
        let message = format_commit_message(&entries);
        assert_eq!(
            message,
            "chore(wiki): update 2 file(s)\n\n- add: a.md\n- modify: b.md"
        );
    }

    #[test]
    fn test_format_commit_message_multiple_per_status_and_other() {
        let entries = vec![
            ("A".to_string(), "a.md".to_string()),
            ("A".to_string(), "a2.md".to_string()),
            ("D".to_string(), "c.md".to_string()),
            ("R".to_string(), "d.md".to_string()),
        ];
        let message = format_commit_message(&entries);
        assert_eq!(
            message,
            "chore(wiki): update 4 file(s)\n\n- add: a.md\n- add: a2.md\n- delete: c.md\n- change: d.md"
        );
    }

    #[test]
    fn test_parse_stash_list_empty() {
        assert_eq!(parse_stash_list_for_marker(""), None);
    }

    #[test]
    fn test_git_changes_includes_untracked() {
        let root = temp_test_dir("preflight-untracked");
        git_output(&root, &["init"]).unwrap();
        git_output(&root, &["config", "user.email", "test@example.com"]).unwrap();
        git_output(&root, &["config", "user.name", "Test User"]).unwrap();

        fs::write(root.join("newnote.md"), "# New\n").unwrap();

        let preflight = git_pull_preflight_in_root(&root).unwrap();
        assert!(!preflight.is_clean);
        assert!(!preflight.has_conflicts);
        assert!(preflight
            .dirty_files
            .iter()
            .any(|c| c.path == "newnote.md" && c.status == "untracked"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_stash_push_pop_drop_roundtrip() {
        let root = temp_test_dir("stash-roundtrip");
        git_output(&root, &["init"]).unwrap();
        git_output(&root, &["config", "user.email", "test@example.com"]).unwrap();
        git_output(&root, &["config", "user.name", "Test User"]).unwrap();

        fs::write(root.join("Note.md"), "Initial\n").unwrap();
        git_output(&root, &["add", "Note.md"]).unwrap();
        git_output(&root, &["commit", "-m", "Initial commit"]).unwrap();

        // Create a dirty change plus an untracked file
        fs::write(root.join("Note.md"), "Modified\n").unwrap();
        fs::write(root.join("untracked.md"), "Untracked\n").unwrap();

        // No autostash exists yet -> pop/drop must error
        assert!(git_stash_pop_in_root(&root, false).is_err());
        assert!(git_stash_drop_in_root(&root).is_err());

        // Push the autostash
        git_stash_push_in_root(&root).unwrap();
        let preflight = git_pull_preflight_in_root(&root).unwrap();
        assert!(preflight.is_clean);
        assert!(resolve_stash_ref_by_marker(&root).unwrap().is_some());

        // Pop cleanly restores both files
        let pop = git_stash_pop_in_root(&root, false).unwrap();
        assert_eq!(pop.status, "clean");
        assert!(pop.stash_ref.is_none());
        assert!(root.join("untracked.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("Note.md")).unwrap().replace("\r\n", "\n"),
            "Modified\n"
        );
        assert!(resolve_stash_ref_by_marker(&root).unwrap().is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_stash_pop_conflict_keeps_entry() {
        let root = temp_test_dir("stash-conflict");
        git_output(&root, &["init"]).unwrap();
        git_output(&root, &["config", "user.email", "test@example.com"]).unwrap();
        git_output(&root, &["config", "user.name", "Test User"]).unwrap();

        fs::write(root.join("Note.md"), "Base\n").unwrap();
        git_output(&root, &["add", "Note.md"]).unwrap();
        git_output(&root, &["commit", "-m", "Initial commit"]).unwrap();

        // Working tree change that we stash
        fs::write(root.join("Note.md"), "Stashed change\n").unwrap();
        git_stash_push_in_root(&root).unwrap();

        // Commit a different change to the same file so pop conflicts
        fs::write(root.join("Note.md"), "Conflicting commit\n").unwrap();
        git_output(&root, &["add", "Note.md"]).unwrap();
        git_output(&root, &["commit", "-m", "Conflicting commit"]).unwrap();

        let pop = git_stash_pop_in_root(&root, false).unwrap();
        assert_eq!(pop.status, "conflict");
        assert!(pop.stash_ref.is_some());
        // entry survives a conflicting pop
        assert!(resolve_stash_ref_by_marker(&root).unwrap().is_some());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_merge_head_exists() {
        let root = temp_test_dir("merge-head");
        git_output(&root, &["init"]).unwrap();
        git_output(&root, &["config", "user.email", "test@example.com"]).unwrap();
        git_output(&root, &["config", "user.name", "Test User"]).unwrap();

        fs::write(root.join("Note.md"), "Base\n").unwrap();
        git_output(&root, &["add", "Note.md"]).unwrap();
        git_output(&root, &["commit", "-m", "Initial commit"]).unwrap();

        // No merge in progress
        assert!(!git_merge_head_exists_in_root(&root));

        // Create divergent branches that conflict
        git_output(&root, &["checkout", "-b", "other"]).unwrap();
        fs::write(root.join("Note.md"), "Other\n").unwrap();
        git_output(&root, &["add", "Note.md"]).unwrap();
        git_output(&root, &["commit", "-m", "Other commit"]).unwrap();

        git_output(&root, &["checkout", "master"]).unwrap();
        fs::write(root.join("Note.md"), "Master\n").unwrap();
        git_output(&root, &["add", "Note.md"]).unwrap();
        git_output(&root, &["commit", "-m", "Master commit"]).unwrap();

        // Conflicting merge leaves MERGE_HEAD in place
        let _ = git_output(&root, &["merge", "other"]);
        assert!(git_merge_head_exists_in_root(&root));

        let _ = fs::remove_dir_all(root);
    }
}
