import type {
  ContextBundleCandidate,
  GitStatus,
  Snapshot,
  VaultApi,
} from "../api/types";
import type { InboxCaptureBlock } from "../core/capture";
import type { GraphData, NoteContext } from "../core/types";

type NoteContextApi = Pick<
  VaultApi,
  "getContextBundleCandidates" | "getInboxCaptures" | "getNoteContext" | "listSnapshots"
>;

type VaultOverviewApi = Pick<VaultApi, "getGitStatus" | "getGraph">;

export type NoteContextRefreshData = {
  readonly context: NoteContext;
  readonly snapshots: Snapshot[];
  readonly candidates: ContextBundleCandidate[];
  readonly inboxCaptures: InboxCaptureBlock[];
};

export type VaultOverviewData = {
  readonly graph: GraphData;
  readonly gitStatus: GitStatus;
};

export async function loadNoteContext(
  api: NoteContextApi,
  path: string,
  includeInboxCaptures: boolean,
): Promise<NoteContextRefreshData> {
  const [context, snapshots, candidates, inboxCaptures] = await Promise.all([
    api.getNoteContext(path),
    api.listSnapshots(path),
    api.getContextBundleCandidates(path),
    includeInboxCaptures ? api.getInboxCaptures(path) : Promise.resolve([]),
  ]);

  return { context, snapshots, candidates, inboxCaptures };
}

export async function loadVaultOverview(api: VaultOverviewApi): Promise<VaultOverviewData> {
  const [graph, gitStatus] = await Promise.all([
    api.getGraph(),
    api.getGitStatus(),
  ]);

  return { graph, gitStatus };
}
