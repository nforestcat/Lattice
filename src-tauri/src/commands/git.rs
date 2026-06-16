use crate::*;

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_git_status(state: tauri::State<AppState>) -> Result<GitStatus, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Ok(GitStatus { is_repo: false, auto_git_enabled: false, branch: None, has_changes: false, has_conflicts: false });
    };
    let is_repo = git_output(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|value| value == "true")
        .unwrap_or(false);
    Ok(GitStatus {
        is_repo,
        auto_git_enabled: guard.auto_git_enabled,
        branch: if is_repo { git_output(root, &["branch", "--show-current"]).ok() } else { None },
        has_changes: if is_repo { git_output(root, &["status", "--porcelain"]).map(|value| !value.trim().is_empty()).unwrap_or(false) } else { false },
        has_conflicts: if is_repo { has_conflicts(root) } else { false },
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn set_auto_git(enabled: bool, state: tauri::State<AppState>) -> Result<GitSettings, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    guard.auto_git_enabled = enabled;
    Ok(GitSettings { auto_git_enabled: enabled })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_git_changes(state: tauri::State<AppState>) -> Result<Vec<GitFileChange>, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Ok(Vec::new());
    };
    git_changes_for_root(root)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_git_diff(path: String, staged: bool, state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    let full_path = resolve_vault_path(root, &path)?;
    if staged {
        git_output(root, &["diff", "--cached", "--", &path])
    } else {
        let is_untracked = full_path.exists() && git_output(root, &["status", "--porcelain", "-z", "--", &path]).map(|s| s.starts_with("??")).unwrap_or(false);
        if is_untracked {
            match std::fs::read_to_string(&full_path) {
                Ok(content) => {
                    let mut diff = vec![
                        "--- /dev/null".to_string(),
                        format!("+++ b/{}", path),
                        format!("@@ -0,0 +1,{} @@", content.lines().count()),
                    ];
                    for line in content.lines() {
                        diff.push(format!("+{}", line));
                    }
                    Ok(diff.join("\n"))
                }
                Err(e) => Err(e.to_string()),
            }
        } else {
            git_output(root, &["diff", "--", &path])
        }
    }
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn git_stage_file(path: String, state: tauri::State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    let _full_path = resolve_vault_path(root, &path)?;
    git_output(root, &["add", "--", &path])?;
    Ok(())
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn git_unstage_file(path: String, state: tauri::State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    let _full_path = resolve_vault_path(root, &path)?;
    git_unstage_file_in_root(root, &path)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn git_stage_all(state: tauri::State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    git_output(root, &["add", "-A"])?;
    Ok(())
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn git_commit(message: String, state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    git_commit_in_root(root, &message)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn git_pull(state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    git_pull_in_root(root)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn git_push(state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    git_push_in_root(root)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_conflict_files(
    state: tauri::State<AppState>,
) -> Result<Vec<ConflictFile>, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Ok(vec![]);
    };

    let output = git_output(root, &["diff", "--name-only", "--diff-filter=U"])
        .unwrap_or_default();

    let conflict_paths: Vec<String> = output.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let mut result = Vec::new();
    for path in conflict_paths {
        let full_path = root.join(&path);
        let content = std::fs::read_to_string(&full_path).unwrap_or_default();
        let hunks = parse_conflict_hunks(&content);
        result.push(ConflictFile { path, hunks });
    }
    Ok(result)
}

fn parse_conflict_hunks(content: &str) -> Vec<ConflictHunk> {
    let mut hunks = Vec::new();
    let mut index = 0;
    let mut pos = 0;

    while pos < content.len() {
        let remaining = &content[pos..];
        let Some(start_rel) = remaining.find("<<<<<<< ") else { break };
        let after_marker = &remaining[start_rel..];

        // find end of the <<<<<<< line
        let Some(ours_start_rel) = after_marker.find('\n') else { break };
        let ours_text_start = start_rel + ours_start_rel + 1;

        let remaining2 = &remaining[start_rel..];
        let Some(mid_rel) = remaining2.find("\n=======") else { break };
        let ours = remaining[start_rel + ours_start_rel + 1..start_rel + mid_rel].to_string();

        // skip "\n=======" (8 chars) plus optional trailing newline
        let sep_end = start_rel + mid_rel + 8;
        let sep_skip = if remaining.as_bytes().get(sep_end) == Some(&b'\n') { 9 } else { 8 };
        let after_sep = &remaining[start_rel + mid_rel + sep_skip..];
        let Some(end_rel) = after_sep.find("\n>>>>>>> ") else { break };
        let theirs = after_sep[..end_rel].to_string();

        // skip past ">>>>>>> ...\n"
        let footer_start = start_rel + mid_rel + sep_skip + end_rel;
        let footer_remaining = &remaining[footer_start..];
        let footer_skip = footer_remaining.find('\n').map(|i| i + 1).unwrap_or(footer_remaining.len());

        hunks.push(ConflictHunk {
            index,
            ours,
            theirs,
            resolved: false,
            resolution: None,
            manual_content: None,
        });
        index += 1;

        let _ = ours_text_start; // suppress unused warning
        pos += start_rel + mid_rel + sep_skip + end_rel + footer_skip;
    }
    hunks
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn resolve_conflict_hunk(
    path: String,
    hunk_index: usize,
    resolution: String,
    manual_content: Option<String>,
    state: tauri::State<AppState>,
) -> Result<ConflictFile, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    let full_path = root.join(&path);
    let content = std::fs::read_to_string(&full_path).map_err(|e| e.to_string())?;

    let new_content = apply_hunk_resolution(&content, hunk_index, &resolution, manual_content.as_deref())?;
    std::fs::write(&full_path, &new_content).map_err(|e| e.to_string())?;

    let remaining_hunks = parse_conflict_hunks(&new_content);
    Ok(ConflictFile { path, hunks: remaining_hunks })
}

fn apply_hunk_resolution(
    content: &str,
    target_index: usize,
    resolution: &str,
    manual: Option<&str>,
) -> Result<String, String> {
    let mut result = String::new();
    let mut current_index = 0usize;
    let mut pos = 0usize;

    while pos < content.len() {
        let remaining = &content[pos..];
        let Some(start_rel) = remaining.find("<<<<<<< ") else {
            result.push_str(remaining);
            pos = content.len();
            break;
        };

        // push everything before this hunk
        result.push_str(&remaining[..start_rel]);

        let from_marker = &remaining[start_rel..];

        // find end of <<<<<<< header line
        let Some(header_end_rel) = from_marker.find('\n') else { break };
        let header = &from_marker[..header_end_rel]; // "<<<<<<< HEAD" etc.

        let Some(mid_rel) = from_marker.find("\n=======\n") else { break };
        let ours = &from_marker[header_end_rel + 1..mid_rel];

        let after_sep = &from_marker[mid_rel + 9..]; // skip "\n=======\n"
        let Some(end_rel) = after_sep.find("\n>>>>>>> ") else { break };
        let theirs = &after_sep[..end_rel];

        let footer_part = &after_sep[end_rel + 1..]; // starts with ">>>>>>> ..."
        let footer_line_end = footer_part.find('\n').map(|i| i + 1).unwrap_or(footer_part.len());
        let footer = &footer_part[..footer_line_end.saturating_sub(1)]; // without trailing newline

        if current_index == target_index {
            let replacement = match resolution {
                "ours" => ours.to_string(),
                "theirs" => theirs.to_string(),
                "manual" => manual.unwrap_or(ours).to_string(),
                _ => return Err(format!("Unknown resolution: {}", resolution)),
            };
            result.push_str(&replacement);
            // if replacement is non-empty and doesn't end with newline, add one
            if !replacement.is_empty() && !replacement.ends_with('\n') {
                result.push('\n');
            }
        } else {
            // reconstruct original conflict markers
            result.push_str(&format!("{}\n{}\n=======\n{}\n{}\n", header, ours, theirs, footer));
        }

        current_index += 1;
        let consumed = start_rel + mid_rel + 9 + end_rel + 1 + footer_line_end;
        pos += consumed;
    }

    if pos < content.len() {
        result.push_str(&content[pos..]);
    }

    Ok(result)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn mark_conflict_resolved(
    path: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    git_output(root, &["add", "--", &path])?;
    Ok(())
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn suggest_commit_message(state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    suggest_commit_message_in_root(root)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn git_pull_preflight(state: tauri::State<AppState>) -> Result<PullPreflight, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    git_pull_preflight_in_root(root)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn git_stash_push(state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    git_stash_push_in_root(root)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn git_stash_pop(with_index: bool, state: tauri::State<AppState>) -> Result<StashPopResult, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    git_stash_pop_in_root(root, with_index)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn git_stash_drop(state: tauri::State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    git_stash_drop_in_root(root)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn git_merge_head_exists(state: tauri::State<AppState>) -> Result<bool, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let Some(root) = &guard.root_path else {
        return Err("No vault open".to_string());
    };
    Ok(git_merge_head_exists_in_root(root))
}
