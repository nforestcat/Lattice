import { askConfirm } from "../api/dialog";
import type { LinkMutationResult } from "../api/types";

type ConfirmAction = (message: string, title?: string) => Promise<boolean>;

export async function deleteManagedGraphLinkAfterConfirmation(
  sourcePath: string,
  targetPath: string,
  deleteManagedGraphLink: (sourcePath: string, targetPath: string) => Promise<LinkMutationResult>,
  confirmAction: ConfirmAction = askConfirm,
): Promise<LinkMutationResult | null> {
  const confirmed = await confirmAction(`Remove managed graph link to "${targetPath}"?`, "Delete Link");
  if (!confirmed) {
    return null;
  }

  return deleteManagedGraphLink(sourcePath, targetPath);
}
