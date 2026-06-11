import { useState, useEffect, useMemo } from "react";
import type { GitFileChange, GitStatus } from "../../api/types";

interface GitWorkspaceProps {
  gitStatus: GitStatus | null;
  gitChanges: GitFileChange[];
  selectedGitFile: string | null;
  selectedGitFileStaged: boolean;
  activeDiff: string | null;
  commitMessage: string;
  isGitLoading: boolean;
  gitOutputLog: string | null;
  setCommitMessage: (msg: string) => void;
  setSelectedGitFile: (path: string | null) => void;
  setSelectedGitFileStaged: (staged: boolean) => void;
  setGitOutputLog: (log: string | null) => void;
  onRefreshGit: () => Promise<void>;
  onStageAll: () => Promise<void>;
  onStageFile: (path: string) => Promise<void>;
  onUnstageFile: (path: string) => Promise<void>;
  onCommit: (message: string) => Promise<void>;
  onPull: () => Promise<void>;
  onPush: () => Promise<void>;
  onLoadDiff: (path: string, staged: boolean) => Promise<void>;
}

type ParsedDiffLine = {
  type: "context" | "add" | "del" | "conflict" | "meta";
  prefix: string;
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

type ParsedDiffHunk = {
  id: string;
  header: string;
  rangeLabel: string;
  oldStart: number;
  newStart: number;
  oldCount: number;
  newCount: number;
  heading: string;
  lines: ParsedDiffLine[];
};

type ParsedDiffFile = {
  oldPath: string | null;
  newPath: string | null;
  hunks: ParsedDiffHunk[];
};

function normalizeDiffPath(rawPath: string) {
  const unquoted = rawPath.trim().replace(/^"|"$/g, "");
  return unquoted.replace(/^[ab]\//, "");
}

function parseDiffGitHeader(line: string): { oldPath: string; newPath: string } | null {
  // Unquoted paths: diff --git a/path b/path
  // Using a/ and b/ as anchors handles paths with spaces correctly
  let match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (match) return { oldPath: match[1], newPath: match[2] };
  // Quoted paths (spaces in filenames): diff --git "a/path with spaces" "b/path with spaces"
  match = /^diff --git "a\/(.+)" "b\/(.+)"$/.exec(line);
  if (match) return { oldPath: match[1], newPath: match[2] };
  return null;
}

function parseHunkHeader(line: string) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
  if (!match) return null;

  const oldStart = Number(match[1]);
  const oldCount = match[2] ? Number(match[2]) : 1;
  const newStart = Number(match[3]);
  const newCount = match[4] ? Number(match[4]) : 1;
  const heading = match[5]?.trim() || "";

  return {
    oldStart,
    oldCount,
    newStart,
    newCount,
    heading,
    rangeLabel: `-${oldStart},${oldCount} +${newStart},${newCount}`
  };
}

function isFileMetadataLine(line: string) {
  return /^(index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/.test(line);
}

function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let currentFile: ParsedDiffFile = { oldPath: null, newPath: null, hunks: [] };
  let currentHunk: ParsedDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const ensureFile = () => {
    if (!files.includes(currentFile)) {
      files.push(currentFile);
    }
  };

  const ensureFallbackHunk = () => {
    ensureFile();
    if (!currentHunk) {
      currentHunk = {
        id: `fallback-${currentFile.hunks.length}`,
        header: "Diff",
        rangeLabel: "unified diff",
        oldStart: 0,
        newStart: 0,
        oldCount: 0,
        newCount: 0,
        heading: "",
        lines: []
      };
      currentFile.hunks.push(currentHunk);
    }
    return currentHunk;
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (currentFile.oldPath || currentFile.newPath || currentFile.hunks.length > 0) {
        currentFile = { oldPath: null, newPath: null, hunks: [] };
        currentHunk = null;
      }
      const parsed = parseDiffGitHeader(line);
      if (parsed) {
        currentFile.oldPath = parsed.oldPath;
        currentFile.newPath = parsed.newPath;
      }
      ensureFile();
      continue;
    }

    if (!currentHunk && isFileMetadataLine(line)) {
      ensureFile();
      continue;
    }

    if (!currentHunk && line.startsWith("--- ")) {
      ensureFile();
      currentFile.oldPath = normalizeDiffPath(line.slice(4));
      currentHunk = null;
      continue;
    }

    if (!currentHunk && line.startsWith("+++ ")) {
      ensureFile();
      currentFile.newPath = normalizeDiffPath(line.slice(4));
      currentHunk = null;
      continue;
    }

    const hunkHeader = parseHunkHeader(line);
    if (hunkHeader) {
      ensureFile();
      oldLine = hunkHeader.oldStart;
      newLine = hunkHeader.newStart;
      currentHunk = {
        id: `${currentFile.hunks.length}:${hunkHeader.rangeLabel}`,
        header: line,
        ...hunkHeader,
        lines: []
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    const hunk = ensureFallbackHunk();
    if (line.startsWith("\\ No newline")) {
      hunk.lines.push({ type: "meta", prefix: "", content: line, oldLine: null, newLine: null });
    } else if (line.startsWith("<<<<<<<") || line.startsWith("=======") || line.startsWith(">>>>>>>")) {
      hunk.lines.push({ type: "conflict", prefix: "", content: line, oldLine: null, newLine: null });
    } else if (currentHunk && line.startsWith("+")) {
      const content = line.slice(1);
      const isConflictMarker = content.startsWith("<<<<<<<") || content.startsWith("=======") || content.startsWith(">>>>>>>");
      hunk.lines.push(isConflictMarker
        ? { type: "conflict", prefix: "+", content, oldLine: null, newLine: null }
        : { type: "add", prefix: "+", content, oldLine: null, newLine });
      newLine += 1;
    } else if (currentHunk && line.startsWith("-")) {
      const content = line.slice(1);
      const isConflictMarker = content.startsWith("<<<<<<<") || content.startsWith("=======") || content.startsWith(">>>>>>>");
      hunk.lines.push(isConflictMarker
        ? { type: "conflict", prefix: "-", content, oldLine: null, newLine: null }
        : { type: "del", prefix: "-", content, oldLine, newLine: null });
      oldLine += 1;
    } else if (currentHunk) {
      hunk.lines.push({
        type: "context",
        prefix: " ",
        content: line.startsWith(" ") ? line.slice(1) : line,
        oldLine,
        newLine
      });
      oldLine += 1;
      newLine += 1;
    } else {
      hunk.lines.push({ type: "meta", prefix: "", content: line, oldLine: null, newLine: null });
    }
  }

  return files.length > 0 ? files : [currentFile];
}

export function GitWorkspace({
  gitStatus,
  gitChanges,
  selectedGitFile,
  selectedGitFileStaged,
  activeDiff,
  commitMessage,
  isGitLoading,
  gitOutputLog,
  setCommitMessage,
  setSelectedGitFile,
  setSelectedGitFileStaged,
  setGitOutputLog,
  onRefreshGit,
  onStageAll,
  onStageFile,
  onUnstageFile,
  onCommit,
  onPull,
  onPush,
  onLoadDiff
}: GitWorkspaceProps) {
  const [isConsoleOpen, setIsConsoleOpen] = useState(true);
  const [collapsedHunks, setCollapsedHunks] = useState<Set<string>>(new Set());
  const parsedDiffFiles = useMemo(() => parseUnifiedDiff(activeDiff || ""), [activeDiff]);

  useEffect(() => {
    if (gitOutputLog) {
      setIsConsoleOpen(true);
    }
  }, [gitOutputLog]);

  useEffect(() => {
    setCollapsedHunks(new Set());
  }, [activeDiff, selectedGitFile, selectedGitFileStaged]);

  if (!gitStatus?.isRepo) {
    return (
      <div className="gitNonRepoContainer">
        <span className="gitWarningIcon">[!]</span>
        <h3>Not a Git Repository</h3>
        <p>This vault folder is not initialized as a Git repository.</p>
        <p className="subtext">
          Initialize Git in this directory via your terminal to enable version tracking and synchronization:
        </p>
        <code className="initCode">git init</code>
      </div>
    );
  }

  const conflictedChanges = gitChanges.filter(c => c.status === "conflict");
  const stagedChanges = gitChanges.filter(c => c.staged && c.status !== "conflict");
  const unstagedChanges = gitChanges.filter(c => !c.staged && c.status !== "conflict");
  const isClean = !isGitLoading && gitChanges.length === 0;
  const selectedDiffHasMarkers = !!activeDiff && activeDiff.includes("<<<<<<<") && activeDiff.includes("=======") && activeDiff.includes(">>>>>>>");

  const handleFileClick = (change: GitFileChange) => {
    setSelectedGitFile(change.path);
    setSelectedGitFileStaged(change.staged);
    void onLoadDiff(change.path, change.staged);
  };

  const toggleHunk = (hunkId: string) => {
    setCollapsedHunks((prev) => {
      const next = new Set(prev);
      if (next.has(hunkId)) {
        next.delete(hunkId);
      } else {
        next.add(hunkId);
      }
      return next;
    });
  };

  return (
    <div className="gitWorkspaceLayout">
      <div className="gitLeftCol">
        <div className="gitRepoInfo">
          <span className="gitBranchLabel">Branch:</span>
          <strong> {gitStatus.branch || "unknown"}</strong>
        </div>

        {(gitStatus?.hasConflicts || selectedDiffHasMarkers) && (
          <div className="gitConflictWarningCard">
            <h4>⚠️ Conflict Warning</h4>
            <p>
              {gitStatus?.hasConflicts
                ? "Repository has unresolved merge conflicts. You cannot commit, pull, or push until you resolve them."
                : "The currently viewed file contains unresolved conflict markers. Please clean them up before committing."}
            </p>
          </div>
        )}

        <div className="gitActionsSection">
          <div className="gitActionsRow">
            <button
              type="button"
              className="smallButton"
              disabled={isGitLoading}
              onClick={onRefreshGit}
            >
              Refresh
            </button>
            <button
              type="button"
              className="smallButton successButton"
              disabled={isGitLoading || unstagedChanges.length === 0}
              onClick={onStageAll}
            >
              Stage All
            </button>
          </div>

          <div className="gitCommitBox">
            <textarea
              className="gitCommitMessageTextarea"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Type a commit message..."
              disabled={isGitLoading}
            />
            <button
              type="button"
              className="smallButton primary"
              style={{ width: "100%", marginTop: "6px" }}
              disabled={isGitLoading || !commitMessage.trim() || stagedChanges.length === 0 || gitStatus?.hasConflicts || selectedDiffHasMarkers}
              onClick={() => void onCommit(commitMessage)}
            >
              Commit Selected ({stagedChanges.length})
            </button>
          </div>

          <div className="gitSyncBox">
            <span className="boxLabel">Sync with Remote</span>
            <div className="gitActionsRow" style={{ marginTop: "4px" }}>
              <button
                type="button"
                className="smallButton"
                style={{ flex: 1 }}
                disabled={isGitLoading || gitStatus?.hasConflicts || selectedDiffHasMarkers}
                onClick={onPull}
              >
                Pull
              </button>
              <button
                type="button"
                className="smallButton"
                style={{ flex: 1 }}
                disabled={isGitLoading || gitStatus?.hasConflicts || selectedDiffHasMarkers}
                onClick={onPush}
              >
                Push
              </button>
            </div>
          </div>
        </div>

        <div className="gitChangesList">
          {conflictedChanges.length > 0 && (
            <div className="gitChangesGroup conflicted">
              <h4 style={{ color: "#d32f2f" }}>Unresolved Conflicts ({conflictedChanges.length})</h4>
              {conflictedChanges.map((c) => (
                <div
                  key={`conflict:${c.path}`}
                  className={`gitFileItem conflicted ${selectedGitFile === c.path ? "active" : ""}`}
                  onClick={() => handleFileClick(c)}
                >
                  <span className="statusIcon conflict">C</span>
                  <span className="filePath">{c.path}</span>
                  <button
                    type="button"
                    className="gitFileActionButton stageButton"
                    title="Stage resolved file"
                    disabled={isGitLoading}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onStageFile(c.path);
                    }}
                  >
                    +
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="gitChangesGroup">
            <h4>Staged Changes ({stagedChanges.length})</h4>
            {stagedChanges.length === 0 ? (
              <div className="gitEmptyState">No staged modifications.</div>
            ) : (
              stagedChanges.map((c) => (
                <div
                  key={`staged:${c.path}`}
                  className={`gitFileItem ${selectedGitFile === c.path && selectedGitFileStaged ? "active" : ""}`}
                  onClick={() => handleFileClick(c)}
                >
                  <span className={`statusIcon ${c.status}`}>{c.status[0].toUpperCase()}</span>
                  <span className="filePath">{c.path}</span>
                  <button
                    type="button"
                    className="gitFileActionButton unstageButton"
                    title="Unstage this file"
                    disabled={isGitLoading}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onUnstageFile(c.path);
                    }}
                  >
                    -
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="gitChangesGroup" style={{ marginTop: "16px" }}>
            <h4>Unstaged Changes ({unstagedChanges.length})</h4>
            {unstagedChanges.length === 0 ? (
              <div className="gitEmptyState">No unstaged modifications.</div>
            ) : (
              unstagedChanges.map((c) => (
                <div
                  key={`unstaged:${c.path}`}
                  className={`gitFileItem ${selectedGitFile === c.path && !selectedGitFileStaged ? "active" : ""}`}
                  onClick={() => handleFileClick(c)}
                >
                  <span className={`statusIcon ${c.status}`}>{c.status[0].toUpperCase()}</span>
                  <span className="filePath">{c.path}</span>
                  <button
                    type="button"
                    className="gitFileActionButton stageButton"
                    title="Stage this file"
                    disabled={isGitLoading}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onStageFile(c.path);
                    }}
                  >
                    +
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {gitOutputLog && (() => {
          const hasConsoleError = gitOutputLog.toLowerCase().includes("error") || gitOutputLog.toLowerCase().includes("fatal");
          return (
            <div className={`gitConsoleCard ${hasConsoleError ? "hasError" : ""}`}>
              <div className="gitConsoleHeader" onClick={() => setIsConsoleOpen(!isConsoleOpen)}>
                <span>Command Output Console</span>
                <span>{isConsoleOpen ? " [v]" : " [^]"}</span>
              </div>
              {isConsoleOpen && (
                <pre className="gitConsoleLog">
                  {gitOutputLog}
                </pre>
              )}
            </div>
          );
        })()}
      </div>

      <div className="gitRightCol">
        <div className="gitDiffHeader">
          <h3>Unified Difference View</h3>
          {selectedGitFile && (
            <span className="diffFilePath">
              <code>{selectedGitFile}</code> ({selectedGitFileStaged ? "Staged" : "Unstaged"})
            </span>
          )}
        </div>
        
        <div className="gitDiffBody">
          {isClean ? (
            <div className="gitCleanRepoState">
              <div className="gitCleanRepoContent">
                <span className="cleanBadge">✓</span>
                <h3>All changes committed</h3>
                <p>Your workspace is clean. No modifications detected.</p>
                <button type="button" className="smallButton" onClick={onRefreshGit} disabled={isGitLoading}>
                  Refresh Status
                </button>
              </div>
            </div>
          ) : !selectedGitFile ? (
            <div className="gitDiffPlaceholder">
              <span className="placeholderIcon">[File]</span>
              <p>Select a modified file from the changes list to review its unified differences.</p>
            </div>
          ) : activeDiff === null ? (
            <div className="gitDiffPlaceholder">
              <p>Loading diff...</p>
            </div>
          ) : activeDiff.trim() === "" ? (
            <div className="gitDiffPlaceholder">
              <p>No changes detected in this file.</p>
            </div>
          ) : (
            <div className="gitDiffViewer">
              {parsedDiffFiles.map((file, fileIndex) => (
                <section key={`${file.oldPath}:${file.newPath}:${fileIndex}`} className="gitDiffFile">
                  <div className="gitDiffFileHeader">
                    <span className="gitDiffFileTitle">
                      <code>{file.oldPath || selectedGitFile || "old"}</code>
                      <span aria-hidden="true"> {"->"} </span>
                      <code>{file.newPath || selectedGitFile || "new"}</code>
                    </span>
                    <span className="gitDiffFileMeta">{file.hunks.length} hunk{file.hunks.length === 1 ? "" : "s"}</span>
                  </div>
                  {file.hunks.map((hunk) => {
                    const hunkStateId = `${fileIndex}:${hunk.id}`;
                    const isCollapsed = collapsedHunks.has(hunkStateId);
                    return (
                      <div key={hunk.id} className={`gitDiffHunk ${isCollapsed ? "collapsed" : ""}`}>
                        <button
                          type="button"
                          className="gitDiffHunkHeader"
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleHunk(hunkStateId)}
                        >
                          <span>{isCollapsed ? "[+]" : "[-]"}</span>
                          <span>{hunk.header}</span>
                          <span className="gitDiffHunkMeta">
                            {isCollapsed ? "Expand" : "Collapse"} hunk {hunk.rangeLabel}
                          </span>
                        </button>
                        {!isCollapsed && (
                          <div className="gitDiffTable">
                            {hunk.lines.map((line, lineIndex) => (
                              <div key={`${hunk.id}:${lineIndex}`} className={`gitDiffRow diff-${line.type}`}>
                                <span className="gitDiffLineNumber old">{line.oldLine ?? ""}</span>
                                <span className="gitDiffLineNumber new">{line.newLine ?? ""}</span>
                                <span className="gitDiffContent">{`${line.prefix}${line.content}`}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
