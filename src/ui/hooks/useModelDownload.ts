import { useState, useCallback, useRef, useEffect } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";

export interface DownloadProgress {
  fileIndex: number;
  fileCount: number;
  receivedBytes: number;
  totalBytes: number | null;
  pct: number | null; // null = indeterminate
}

export interface ModelDownloadState {
  downloading: boolean;
  progress: DownloadProgress | null;
  error: string | null;
  downloaded: boolean;
  modelSizeMb: number;
}

export interface UseModelDownloadReturn extends ModelDownloadState {
  startDownload: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

type ModelStatus = {
  downloaded: boolean;
  modelSizeMb: number;
};

export function useModelDownload(): UseModelDownloadReturn {
  const [state, setState] = useState<ModelDownloadState>({
    downloading: false,
    progress: null,
    error: null,
    downloaded: false,
    modelSizeMb: 113,
  });

  const downloadingRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await invoke<ModelStatus>("get_local_embedding_model_status");
      setState(prev => ({
        ...prev,
        downloaded: status.downloaded,
        modelSizeMb: status.modelSizeMb || 113,
      }));
    } catch {
      // ignore status check failures
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const startDownload = useCallback(async () => {
    if (downloadingRef.current) return; // concurrency guard
    downloadingRef.current = true;
    setState(prev => ({ ...prev, downloading: true, error: null, progress: null }));

    const channel = new Channel<DownloadProgress>();
    channel.onmessage = (data) => {
      setState(prev => ({ ...prev, progress: data }));
    };

    try {
      await invoke("download_local_embedding_model", { onProgress: channel });
      await refreshStatus();
      setState(prev => ({ ...prev, downloading: false, progress: null }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState(prev => ({ ...prev, downloading: false, error: msg }));
    } finally {
      channel.onmessage = () => {};
      downloadingRef.current = false;
    }
  }, [refreshStatus]);

  return { ...state, startDownload, refreshStatus };
}
