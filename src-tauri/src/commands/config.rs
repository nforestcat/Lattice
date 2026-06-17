use crate::*;
use std::collections::HashSet;
use sha2::{Digest, Sha256};
use regex::Regex;

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_vault_config(state: tauri::State<AppState>) -> Result<VaultConfig, String> {
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

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_archive_status(state: tauri::State<AppState>) -> Result<ArchiveStatus, String> {
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

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn delete_archived_prompt(run_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let run_path = prompt_run_archive_path(root, &run_id)?;
    if run_path.exists() {
        fs::remove_file(&run_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn prune_archived_prompts(active_run_ids: Vec<String>, state: tauri::State<AppState>) -> Result<(), String> {
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

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn archive_prompt_run(run_id: String, content: String, state: tauri::State<AppState>) -> Result<String, String> {
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

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_archived_prompt(run_id: String, state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let run_path = prompt_run_archive_path(root, &run_id)?;
    if run_path.exists() {
        fs::read_to_string(&run_path).map_err(|e| e.to_string())
    } else {
        Err("Archived prompt not found".to_string())
    }
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn save_vault_config(config: VaultConfig, state: tauri::State<AppState>) -> Result<(), String> {
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

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn append_ai_audit(record: serde_json::Value, state: tauri::State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let lattice_dir = root.join(".lattice");
    if !lattice_dir.exists() {
        fs::create_dir_all(&lattice_dir).map_err(|e| e.to_string())?;
    }
    let audit_path = lattice_dir.join("ai-audit.jsonl");
    let line = serde_json::to_string(&record).map_err(|e| e.to_string())? + "\n";
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&audit_path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn load_embeddings_cache(state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let path = embeddings_cache_path(root);
    if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn save_embeddings_cache(content: String, state: tauri::State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let lattice_dir = root.join(".lattice");
    if !lattice_dir.exists() {
        fs::create_dir_all(&lattice_dir).map_err(|e| e.to_string())?;
    }
    let path = embeddings_cache_path(root);
    fs::write(path, content).map_err(|e| e.to_string())
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn load_embeddings_status(state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let path = embeddings_status_path(root);
    if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn save_embeddings_status(content: String, state: tauri::State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let lattice_dir = root.join(".lattice");
    if !lattice_dir.exists() {
        fs::create_dir_all(&lattice_dir).map_err(|e| e.to_string())?;
    }
    let path = embeddings_status_path(root);
    fs::write(path, content).map_err(|e| e.to_string())
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_backlink_suggestions(active_path: String, state: tauri::State<AppState>) -> Result<Vec<BacklinkSuggestion>, String> {
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

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn apply_backlink_suggestion(suggestion: BacklinkSuggestion, state: tauri::State<AppState>) -> Result<(), String> {
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

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn apply_note_metadata(
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

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_unresolved_links(state: tauri::State<AppState>) -> Result<Vec<UnresolvedLinkGroup>, String> {
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

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn parse_proposed_edits(raw_text: String) -> Result<Vec<ProposedEdit>, String> {
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

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_wiki_health_report(state: tauri::State<AppState>) -> Result<Vec<NoteHealthReport>, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let notes = &guard.notes;
    
    let mut reports = Vec::new();
    
    let mut linked_paths = HashSet::new();
    for note in notes {
        for link in &note.links {
            if let Some(ref resolved) = link.resolved_path {
                linked_paths.insert(resolved.clone());
            }
        }
    }
    
    let now = Utc::now();
    
    for note in notes {
        let mut issues = Vec::new();
        let mut is_orphan = false;
        let mut is_stale = false;
        let mut is_too_broad = false;
        let mut is_duplicated = false;
        let mut missing_summary = false;
        let mut weak_backlinks = false;
        
        let note_path = &note.meta.path;
        
        if note_path.ends_with(".lattice-folder.md") {
            continue;
        }

        // 1. Orphan check
        if note_path != "Home.md" && !linked_paths.contains(note_path) {
            is_orphan = true;
            issues.push("Orphan note: No other notes link to this note.".to_string());
        }
        
        // 2. Stale check
        if let Some(ref mod_time_str) = note.meta.modified_at {
            if let Ok(mod_time) = DateTime::parse_from_rfc3339(mod_time_str) {
                let mod_time_utc: DateTime<Utc> = mod_time.with_timezone(&Utc);
                let duration = now.signed_duration_since(mod_time_utc);
                if duration.num_days() > 30 {
                    is_stale = true;
                    issues.push(format!("Stale: Last modified {} days ago.", duration.num_days()));
                }
            }
        }
        
        // 3. Too broad check
        if note.content.chars().count() > 5000 {
            is_too_broad = true;
            issues.push(format!("Too broad: Content length is very high ({} characters). Consider splitting.", note.content.chars().count()));
        }
        
        // 4. Missing summary check
        if !note.meta.frontmatter.contains_key("summary") {
            missing_summary = true;
            issues.push("Missing summary: Note does not have a 'summary' property in its frontmatter.".to_string());
        }
        
        // 5. Weak backlinks check
        let resolved_out_links_count = note.links.iter().filter(|l| l.resolved_path.is_some()).count();
        let backlink_count = notes.iter()
            .filter(|n| n.meta.path != note.meta.path)
            .filter(|n| n.links.iter().any(|l| l.resolved_path.as_ref() == Some(note_path)))
            .count();
        if resolved_out_links_count > 3 && backlink_count == 0 {
            weak_backlinks = true;
            issues.push("Weak backlinks: Note references multiple pages but has no backlinks.".to_string());
        }
        
        // 6. Duplicate check
        let mut duplicate_peer_path: Option<String> = None;
        let mut duplicate_peer_modified_at: Option<String> = None;
        for other in notes {
            if other.meta.path != note.meta.path {
                if other.content.trim() == note.content.trim() && !note.content.trim().is_empty() {
                    is_duplicated = true;
                    issues.push(format!("Duplicate content: Identical to note [[{}]].", other.meta.title));
                    duplicate_peer_path = Some(other.meta.path.clone());
                    duplicate_peer_modified_at = other.meta.modified_at.clone();
                    break;
                }
            }
        }
        
        // Compute quality score
        let mut score: usize = 100;
        if is_orphan { score = score.saturating_sub(15); }
        if is_stale { score = score.saturating_sub(10); }
        if is_too_broad { score = score.saturating_sub(15); }
        if is_duplicated { score = score.saturating_sub(30); }
        if missing_summary { score = score.saturating_sub(15); }
        if weak_backlinks { score = score.saturating_sub(10); }
        
        let duplicate_peer = duplicate_peer_path.map(|p| crate::models::DuplicatePeerInfo {
            path: p,
            score: 0, // filled in post-pass below
            modified_at: duplicate_peer_modified_at,
        });
        reports.push(NoteHealthReport {
            path: note.meta.path.clone(),
            title: note.meta.title.clone(),
            score,
            issues,
            is_orphan,
            is_stale,
            is_too_broad,
            is_duplicated,
            missing_summary,
            weak_backlinks,
            duplicate_peer,
        });
    }

    // Fill in peer scores for duplicate pairs (requires all reports to be built first)
    let path_to_score: std::collections::HashMap<String, usize> =
        reports.iter().map(|r| (r.path.clone(), r.score)).collect();
    for report in &mut reports {
        if let Some(ref mut peer) = report.duplicate_peer {
            if let Some(&peer_score) = path_to_score.get(&peer.path) {
                peer.score = peer_score;
            }
        }
    }

    Ok(reports)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarNote {
    pub path: String,
    pub title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCheckResult {
    pub exact_match: Option<String>,
    pub similar_notes: Vec<SimilarNote>,
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) async fn check_ingest_duplicate(
    source_ref: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<DuplicateCheckResult, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;

    let exact_match = guard.notes.iter().find(|note| {
        note.meta.frontmatter.get("source").map(|s| s == &source_ref).unwrap_or(false)
            || note.meta.frontmatter.get("source_file").map(|s| s == &source_ref).unwrap_or(false)
    }).map(|note| note.meta.path.clone());

    let search_term = source_ref
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .filter(|s| !s.is_empty())
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();

    let similar_notes: Vec<SimilarNote> = if search_term.len() > 3 {
        guard.notes.iter()
            .filter(|note| {
                exact_match.as_ref().map_or(true, |p| p != &note.meta.path) &&
                note.meta.title.to_lowercase().contains(&search_term)
            })
            .take(3)
            .map(|note| SimilarNote {
                path: note.meta.path.clone(),
                title: note.meta.title.clone(),
            })
            .collect()
    } else {
        vec![]
    };

    Ok(DuplicateCheckResult { exact_match, similar_notes })
}
