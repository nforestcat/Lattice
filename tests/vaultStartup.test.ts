import { describe, expect, it } from "vitest";
import { getStartupVaultPath, rememberVaultPath } from "../src/ui/vaultStartup";

function createStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value)
  };
}

describe("vault startup path", () => {
  it("opens the remembered real vault in desktop mode", () => {
    const storage = createStorage({ "lattice:lastVaultPath": "C:/vaults/notes" });

    expect(getStartupVaultPath(storage, true)).toBe("C:/vaults/notes");
  });

  it("falls back to the demo vault outside desktop mode", () => {
    const storage = createStorage({ "lattice:lastVaultPath": "C:/vaults/notes" });

    expect(getStartupVaultPath(storage, false)).toBe("Demo Vault");
  });

  it("remembers the last selected vault path", () => {
    const storage = createStorage();

    rememberVaultPath(storage, "D:/knowledge");

    expect(storage.getItem("lattice:lastVaultPath")).toBe("D:/knowledge");
  });
});
