use crate::models::SnapshotRecord;
use crate::VaultState;
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn recovery_dir(root: &Path) -> PathBuf {
    root.join(".lattice").join("recovery")
}

pub(crate) fn recovery_index_path(root: &Path) -> PathBuf {
    recovery_dir(root).join("index.json")
}

fn hex_encode_id(id: &str) -> String {
    id.bytes().map(|b| format!("{:02x}", b)).collect()
}

pub(crate) fn recovery_blob_path(root: &Path, id: &str) -> PathBuf {
    recovery_dir(root).join("blobs").join(hex_encode_id(id))
}

pub(crate) fn snapshot(
    state: &mut VaultState,
    root: &Path,
    path: &str,
    content: &str,
    reason: &str,
) -> String {
    let ts = Utc::now().timestamp_millis();
    let mut id = format!("{}:{}", path, ts);
    let mut counter = 1u32;
    while state.snapshots.iter().any(|s| s.id == id) {
        id = format!("{}:{}:{}", path, ts, counter);
        counter += 1;
    }
    let record = SnapshotRecord {
        id: id.clone(),
        path: path.to_string(),
        created_at: Utc::now().to_rfc3339(),
        reason: reason.to_string(),
    };
    state.snapshots.insert(0, record);
    state
        .snapshot_content
        .insert(id.clone(), content.to_string());

    if let Err(e) = write_recovery_blob(root, &id, content) {
        eprintln!("[lattice] recovery blob write failed: {}", e);
    } else if let Err(e) = persist_recovery_index(root, &state.snapshots) {
        eprintln!("[lattice] recovery index write failed: {}", e);
    }

    apply_retention(root, &mut state.snapshots);

    id
}

pub(crate) fn write_recovery_blob(root: &Path, id: &str, content: &str) -> Result<(), String> {
    let blob_path = recovery_blob_path(root, id);
    if let Some(parent) = blob_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&blob_path, content).map_err(|e| e.to_string())
}

pub(crate) fn persist_recovery_index(
    root: &Path,
    snapshots: &[SnapshotRecord],
) -> Result<(), String> {
    let index_path = recovery_index_path(root);
    if let Some(parent) = index_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(snapshots).map_err(|e| e.to_string())?;
    let tmp_path = index_path.with_extension("json.tmp");
    fs::write(&tmp_path, &json).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &index_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        e.to_string()
    })
}

pub(crate) fn load_recovery_index(root: &Path) -> Vec<SnapshotRecord> {
    let index_path = recovery_index_path(root);
    let content = match fs::read_to_string(&index_path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let mut records: Vec<SnapshotRecord> = serde_json::from_str(&content).unwrap_or_default();
    records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    records
}

pub(crate) fn load_recovery_content(root: &Path, id: &str) -> Result<String, String> {
    let blob_path = recovery_blob_path(root, id);
    fs::read_to_string(&blob_path).map_err(|e| format!("Blob read failed for {}: {}", id, e))
}

pub(crate) fn self_heal_recovery(root: &Path, snapshots: &mut Vec<SnapshotRecord>) {
    let blobs_dir = recovery_dir(root).join("blobs");
    let index_ids: HashSet<String> = snapshots.iter().map(|s| hex_encode_id(&s.id)).collect();

    if let Ok(entries) = fs::read_dir(&blobs_dir) {
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().to_string();
            if !index_ids.contains(&name) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    let original_len = snapshots.len();
    snapshots.retain(|s| recovery_blob_path(root, &s.id).exists());
    if snapshots.len() != original_len {
        if let Err(e) = persist_recovery_index(root, snapshots) {
            eprintln!("[lattice] self-heal index rewrite failed: {}", e);
        }
    }
}

const RETENTION_MAX_PER_PATH: usize = 50;

pub(crate) fn apply_retention(root: &Path, snapshots: &mut Vec<SnapshotRecord>) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut to_remove = Vec::new();

    for (i, s) in snapshots.iter().enumerate() {
        let count = counts.entry(s.path.clone()).or_insert(0);
        *count += 1;
        if *count > RETENTION_MAX_PER_PATH {
            to_remove.push(i);
        }
    }

    if to_remove.is_empty() {
        return;
    }

    for &i in to_remove.iter().rev() {
        let removed = snapshots.remove(i);
        let _ = fs::remove_file(recovery_blob_path(root, &removed.id));
    }

    if let Err(e) = persist_recovery_index(root, snapshots) {
        eprintln!("[lattice] retention index rewrite failed: {}", e);
    }
}
