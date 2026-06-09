import { useState, useEffect } from "react";
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

  useEffect(() => {
    if (gitOutputLog) {
      setIsConsoleOpen(true);
    }
  }, [gitOutputLog]);

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

  const parseDiffLine = (line: string, index: number) => {
    const cleanLine = line.startsWith("+") || line.startsWith("-") ? line.slice(1) : line;
    if (cleanLine.startsWith("<<<<<<<") || cleanLine.startsWith("=======") || cleanLine.startsWith(">>>>>>>")) {
      return (
        <div key={index} className="gitDiffLine diff-conflict-marker">
          {line}
        </div>
      );
    }
    if (line.startsWith("+++") || line.startsWith("---")) {
      return (
        <div key={index} className="gitDiffLine diff-hunk">
          {line}
        </div>
      );
    }
    if (line.startsWith("+")) {
      return (
        <div key={index} className="gitDiffLine diff-add">
          {line}
        </div>
      );
    }
    if (line.startsWith("-")) {
      return (
        <div key={index} className="gitDiffLine diff-del">
          {line}
        </div>
      );
    }
    if (line.startsWith("@@")) {
      return (
        <div key={index} className="gitDiffLine diff-hunk">
          {line}
        </div>
      );
    }
    return (
      <div key={index} className="gitDiffLine diff-context">
        {line}
      </div>
    );
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
            <pre className="gitDiffPre">
              {activeDiff.split(/\r?\n/).map((line, idx) => parseDiffLine(line, idx))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
