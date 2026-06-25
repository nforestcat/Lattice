import { useState } from "react";
import type { UnresolvedLinkGroup } from "../../api/types";

export function useUnresolvedLinks() {
  const [unresolvedLinks, setUnresolvedLinks] = useState<UnresolvedLinkGroup[]>([]);
  const [isScanningUnresolved, setIsScanningUnresolved] = useState(false);
  const [selectedUnresolvedTargets, setSelectedUnresolvedTargets] = useState<Set<string>>(new Set());
  const [activeUnresolvedTarget, setActiveUnresolvedTarget] = useState<string | null>(null);

  return {
    unresolvedLinks, setUnresolvedLinks,
    isScanningUnresolved, setIsScanningUnresolved,
    selectedUnresolvedTargets, setSelectedUnresolvedTargets,
    activeUnresolvedTarget, setActiveUnresolvedTarget,
  };
}

export type UnresolvedLinksState = ReturnType<typeof useUnresolvedLinks>;
