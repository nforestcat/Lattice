export type GitStatus = {
  isRepo: boolean;
  autoGitEnabled: boolean;
  branch: string | null;
  hasChanges: boolean;
  hasConflicts: boolean;
};

export type GitSettings = {
  autoGitEnabled: boolean;
};

export type PullPreflight = {
  isClean: boolean;
  dirtyFiles: GitFileChange[];
  hasConflicts: boolean;
};

export type StashPopResult = {
  status: "clean" | "conflict";
  stashRef: string | null;
};

export type GitFileChange = {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflict";
  staged: boolean;
};
