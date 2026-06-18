import { createContext, useContext } from "react";
import type { UseModelDownloadReturn } from "../hooks/useModelDownload";

export const ModelDownloadContext = createContext<UseModelDownloadReturn | null>(null);

export function useModelDownloadContext(): UseModelDownloadReturn {
  const ctx = useContext(ModelDownloadContext);
  if (!ctx) throw new Error("useModelDownloadContext must be used within ModelDownloadContext.Provider");
  return ctx;
}
