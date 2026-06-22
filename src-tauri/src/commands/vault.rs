use crate::*;

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn open_vault(path: String, state: tauri::State<AppState>) -> Result<VaultSnapshot, String> {
    let root = PathBuf::from(path);
    let notes = scan_vault(&root)?;
    let tree = build_tree(&notes);
    let metas = notes.iter().map(|note| note.meta.clone()).collect();
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    guard.root_path = Some(root.clone());
    guard.notes = notes;
    Ok(VaultSnapshot {
        root_path: root.to_string_lossy().to_string(),
        notes: metas,
        tree,
        obsidian_settings: read_obsidian_settings(&root),
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn read_note(path: String, state: tauri::State<AppState>) -> Result<NoteDocument, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.as_ref().ok_or("No vault is open")?;
    let full_path = resolve_vault_path(root, &path)?;
    let content = fs::read_to_string(&full_path).map_err(|error| error.to_string())?;
    Ok(NoteDocument {
        path,
        revision: revision_of(&content),
        content,
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn save_note(path: String, content: String, base_revision: String, state: tauri::State<AppState>) -> Result<SaveResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let full_path = resolve_vault_path(&root, &path)?;
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
    reindex_after_mutation(&mut guard, &root)?;
    let git_commit = if guard.auto_git_enabled { auto_commit(&root, &path).ok() } else { None };
    Ok(SaveResult {
        saved: true,
        revision: revision_of(&content),
        conflict: false,
        snapshot_id: Some(snapshot_id),
        git_commit,
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn create_note(parent_path: Option<String>, title: String, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
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
    reindex_after_mutation(&mut guard, &root)?;
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(path),
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn create_folder(parent_path: Option<String>, name: String, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let clean_name = clean_entry_name(&name)?;
    let folder_path = join_vault_path(parent_path.as_deref().unwrap_or(""), &clean_name);
    let full_path = resolve_vault_path(&root, &folder_path)?;
    if full_path.exists() {
        return Err(format!("Entry already exists: {}", folder_path));
    }
    fs::create_dir_all(&full_path).map_err(|error| error.to_string())?;
    reindex_after_mutation(&mut guard, &root)?;
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(folder_path),
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn rename_entry(path: String, new_name: String, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
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
    reindex_after_mutation(&mut guard, &root)?;
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(to_path),
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn delete_entry(path: String, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
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
    reindex_after_mutation(&mut guard, &root)?;
    let selected_path = guard.notes.first().map(|note| note.meta.path.clone());
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path,
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn capture_to_inbox(input: CaptureInput, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
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
    reindex_after_mutation(&mut guard, &root)?;
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(path),
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_inbox_captures(inbox_path: String, state: tauri::State<AppState>) -> Result<Vec<InboxCaptureBlock>, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let full_path = resolve_vault_path(&root, &inbox_path)?;
    let content = fs::read_to_string(&full_path).map_err(|error| error.to_string())?;
    Ok(parse_inbox_captures(&content))
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn mark_inbox_capture_processed(inbox_path: String, capture_id: String, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let full_path = resolve_vault_path(&root, &inbox_path)?;
    let content = fs::read_to_string(&full_path).map_err(|error| error.to_string())?;
    fs::write(&full_path, move_inbox_capture_to_processed(&content, &capture_id)?).map_err(|error| error.to_string())?;
    reindex_after_mutation(&mut guard, &root)?;
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(inbox_path),
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn promote_inbox_capture(input: PromoteInboxCaptureInput, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
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
    reindex_after_mutation(&mut guard, &root)?;
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(note_path),
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn append_inbox_capture(input: AppendInboxCaptureInput, state: tauri::State<AppState>) -> Result<EntryMutationResult, String> {
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
    
    reindex_after_mutation(&mut guard, &root)?;
    if guard.auto_git_enabled {
        let _ = auto_commit(&root, &input.target_path);
        let _ = auto_commit(&root, &input.inbox_path);
    }
    
    Ok(EntryMutationResult {
        vault: vault_snapshot(&root, &guard.notes),
        selected_path: Some(input.target_path),
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_context_bundle(path: String, options: ContextBundleOptions, state: tauri::State<AppState>) -> Result<ContextBundle, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    create_context_bundle(&guard.notes, &path, options)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_context_bundle_candidates(path: String, state: tauri::State<AppState>) -> Result<Vec<ContextBundleCandidate>, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    context_bundle_candidates(&guard.notes, &path)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn search_notes(filters: SearchFilters, state: tauri::State<AppState>) -> Result<Vec<NoteMeta>, String> {
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

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_note_context(path: String, state: tauri::State<AppState>) -> Result<NoteContext, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    note_context(&guard.notes, &path)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_graph(_filters: HashMap<String, serde_json::Value>, state: tauri::State<AppState>) -> Result<GraphData, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    Ok(build_graph(&guard.notes))
}

#[cfg(not(test))]
fn mutate_graph_link(source_path: String, target_path: String, add: bool, state: tauri::State<AppState>) -> Result<LinkMutationResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let target_title = guard.notes.iter().find(|note| note.meta.path == target_path).map(|note| note.meta.title.clone()).ok_or("Target note not found")?;
    let full_path = resolve_vault_path(&root, &source_path)?;
    let content = fs::read_to_string(&full_path).map_err(|error| error.to_string())?;
    let next = if add { add_managed_link(&content, &target_title) } else { remove_managed_link(&content, &target_title) };
    fs::write(&full_path, &next).map_err(|error| error.to_string())?;
    reindex_after_mutation(&mut guard, &root)?;
    Ok(LinkMutationResult {
        note: NoteDocument { path: source_path, revision: revision_of(&next), content: next },
        graph: build_graph(&guard.notes),
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn create_graph_link(source_path: String, target_path: String, state: tauri::State<AppState>) -> Result<LinkMutationResult, String> {
    mutate_graph_link(source_path, target_path, true, state)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn delete_managed_graph_link(source_path: String, target_path: String, state: tauri::State<AppState>) -> Result<LinkMutationResult, String> {
    mutate_graph_link(source_path, target_path, false, state)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn list_snapshots(path: String, state: tauri::State<AppState>) -> Result<Vec<SnapshotRecord>, String> {
    let guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    Ok(guard.snapshots.iter().filter(|snapshot| snapshot.path == path).cloned().collect())
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn restore_snapshot(snapshot_id: String, state: tauri::State<AppState>) -> Result<SaveResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "State lock poisoned")?;
    let root = guard.root_path.clone().ok_or("No vault is open")?;
    let snapshot = guard.snapshots.iter().find(|candidate| candidate.id == snapshot_id).cloned().ok_or("Snapshot not found")?;
    let content = guard.snapshot_content.get(&snapshot_id).cloned().ok_or("Snapshot content not found")?;
    let target_path = resolve_vault_path(&root, &snapshot.path)?;
    fs::write(target_path, &content).map_err(|error| error.to_string())?;
    reindex_after_mutation(&mut guard, &root)?;
    Ok(SaveResult {
        saved: true,
        revision: revision_of(&content),
        conflict: false,
        snapshot_id: Some(snapshot_id),
        git_commit: None,
    })
}
