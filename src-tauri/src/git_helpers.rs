use crate::models::*;
use std::path::Path;
use std::process::Command;

pub(crate) fn parse_status_conflicts(stdout: &[u8]) -> bool {
    let parts: Vec<&[u8]> = stdout.split(|&b| b == 0).collect();
    for part in parts {
        if part.is_empty() {
            continue;
        }
        let part_str = String::from_utf8_lossy(part);
        if part_str.len() >= 4 {
            let x = part_str.chars().next().unwrap_or(' ');
            let y = part_str.chars().nth(1).unwrap_or(' ');
            if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
                return true;
            }
        }
    }
    false
}

pub(crate) fn has_conflicts(root: &Path) -> bool {
    if let Ok(cmd_output) = Command::new("git")
        .args(["status", "--porcelain", "-z"])
        .current_dir(root)
        .output()
    {
        if cmd_output.status.success() {
            return parse_status_conflicts(&cmd_output.stdout);
        }
    }
    false
}

pub(crate) fn staged_conflict_marker_file(root: &Path, paths: &[&str]) -> Result<Option<String>, String> {
    let mut diff_args = vec!["diff", "--cached", "--name-only", "-z"];
    if !paths.is_empty() {
        diff_args.push("--");
        diff_args.extend(paths.iter().copied());
    }

    let staged_files_output = Command::new("git")
        .args(diff_args)
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
            .args(["show", &format!(":{}", rel_path)])
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




pub(crate) fn git_changes_for_root(root: &Path) -> Result<Vec<GitFileChange>, String> {
    let is_repo = git_output(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|value| value == "true")
        .unwrap_or(false);
    if !is_repo {
        return Ok(Vec::new());
    }

    let cmd_output = Command::new("git")
        .args(["status", "--porcelain", "-z"])
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
        let x = part_str.chars().next().unwrap_or(' ');
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




pub(crate) fn git_unstage_file_in_root(root: &Path, path: &str) -> Result<(), String> {
    // Guard against real reset failures on mature repositories by verifying HEAD first
    let head_exists = git_output(root, &["rev-parse", "--verify", "HEAD"]).is_ok();
    if head_exists {
        // Resolve if it's a rename to unstage both old and new paths
        let mut paths_to_reset = vec![path.to_string()];
        if let Ok(status_output) = Command::new("git").args(["status", "--porcelain", "-z"]).current_dir(root).output() {
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
                        let x = part_str.chars().next().unwrap_or(' ');
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
        git_output(root, &["rm", "--cached", "--", path])?;
    }
    Ok(())
}



pub(crate) fn git_commit_in_root(root: &Path, message: &str) -> Result<String, String> {
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


pub(crate) fn git_pull_in_root(root: &Path) -> Result<String, String> {
    if has_conflicts(root) {
        return Err("Cannot pull: repository has unresolved merge conflicts. Please resolve conflicts first.".to_string());
    }
    git_output_all(root, &["pull"])
}


pub(crate) fn git_push_in_root(root: &Path) -> Result<String, String> {
    if has_conflicts(root) {
        return Err("Cannot push: repository has unresolved merge conflicts. Please resolve conflicts first.".to_string());
    }
    git_output_all(root, &["push"])
}

pub(crate) const STASH_MARKER: &str = "wiki-pull-autostash";

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

pub(crate) fn parse_stash_list_for_marker(list_output: &str) -> Option<String> {
    for line in list_output.lines() {
        if line.contains(STASH_MARKER) {
            if let Some(idx) = line.find(':') {
                return Some(line[..idx].trim().to_string());
            }
        }
    }
    None
}

pub(crate) fn resolve_stash_ref_by_marker(root: &Path) -> Result<Option<String>, String> {
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
        .args(["rev-parse", "-q", "--verify", "MERGE_HEAD"])
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

pub(crate) fn git_output(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git").args(args).current_dir(root).output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

pub(crate) fn git_output_all(root: &Path, args: &[&str]) -> Result<String, String> {
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

pub(crate) fn auto_commit(root: &Path, path: &str) -> Result<String, String> {
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
