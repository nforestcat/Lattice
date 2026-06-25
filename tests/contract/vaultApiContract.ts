import { describe, expect, it } from "vitest";
import type { VaultApi, VaultCapability, GitCapability, AiCapability, ReviewCapability } from "../../src/api/types";

// ponytail: partition assertion — no magic numbers, pure type math
type AssertExtends<A, B> = A extends B ? true : false;
type CapabilityKeys = keyof VaultCapability | keyof GitCapability | keyof AiCapability | keyof ReviewCapability;
type _CheckUnionCoversApi = AssertExtends<keyof VaultApi, CapabilityKeys> extends true ? true : never;
type _CheckApiCoversUnion = AssertExtends<CapabilityKeys, keyof VaultApi> extends true ? true : never;
const _unionCoversApi: _CheckUnionCoversApi = true;
const _apiCoversUnion: _CheckApiCoversUnion = true;
void _unionCoversApi; void _apiCoversUnion;

export function describeVaultContract(name: string, makeApi: () => VaultApi | Promise<VaultApi>) {
  describe(`VaultCapability [${name}]`, () => {
    it("round-trips note save/read", async () => {
      const api = await makeApi();
      const vault = await api.openVault("Demo Vault");
      expect(vault.notes.length).toBeGreaterThan(0);

      const note = vault.notes[0];
      const doc = await api.readNote(note.path);
      const saved = await api.saveNote(note.path, doc.content + "\ntest", doc.revision);
      expect(saved.revision).toBeDefined();

      const reread = await api.readNote(note.path);
      expect(reread.content).toContain("test");
    });

    it("entry mutation returns vault + selectedPath", async () => {
      const api = await makeApi();
      await api.openVault("Demo Vault");
      const result = await api.createNote(null, "Contract Test Note");
      expect(result.vault).toBeDefined();
      expect(result.selectedPath).toBeDefined();
    });

    it("config round-trip", async () => {
      const api = await makeApi();
      await api.openVault("Demo Vault");
      const config = await api.getVaultConfig();
      expect(config).toBeDefined();
      await api.saveVaultConfig(config);
      const reread = await api.getVaultConfig();
      expect(reread).toEqual(config);
    });

    it("searchNotes returns array", async () => {
      const api = await makeApi();
      await api.openVault("Demo Vault");
      const results = await api.searchNotes({ query: "" });
      expect(Array.isArray(results)).toBe(true);
    });
  });
}

export function describeGitContract(name: string, makeApi: () => VaultApi | Promise<VaultApi>) {
  describe(`GitCapability [${name}]`, () => {
    it("getGitStatus returns status shape", async () => {
      const api = await makeApi();
      await api.openVault("Demo Vault");
      const status = await api.getGitStatus();
      expect(status).toBeDefined();
    });

    it("all git methods are callable functions", async () => {
      const api = await makeApi();
      const gitKeys: (keyof GitCapability)[] = [
        "getGitStatus", "setAutoGit", "getGitChanges", "getGitDiff",
        "gitStageAll", "gitStageFile", "gitUnstageFile", "gitCommit",
        "gitPull", "gitPush", "gitSuggestCommitMessage",
        "gitPullPreflight", "gitStashPush", "gitStashPop", "gitStashDrop", "gitMergeHeadExists",
      ];
      for (const key of gitKeys) {
        expect(typeof api[key]).toBe("function");
      }
    });
  });
}

export function describeAiContract(name: string, makeApi: () => VaultApi | Promise<VaultApi>) {
  describe(`AiCapability [${name}]`, () => {
    it("archive round-trip", async () => {
      const api = await makeApi();
      await api.openVault("Demo Vault");
      const id = await api.archivePromptRun("contract-test-run", "test content");
      expect(id).toBeDefined();
      const content = await api.getArchivedPrompt("contract-test-run");
      expect(content).toContain("test content");
      await api.deleteArchivedPrompt("contract-test-run");
    });

    it("parseProposedEdits returns array", async () => {
      const api = await makeApi();
      const result = await api.parseProposedEdits("no edits here");
      expect(Array.isArray(result)).toBe(true);
    });

    it("all ai methods are callable functions", async () => {
      const api = await makeApi();
      const aiKeys: (keyof AiCapability)[] = [
        "archivePromptRun", "getArchivedPrompt", "deleteArchivedPrompt",
        "pruneArchivedPrompts", "getArchiveStatus",
        "saveApiKey", "getApiKey", "fetchProviderModels", "parseProposedEdits",
      ];
      for (const key of aiKeys) {
        expect(typeof api[key]).toBe("function");
      }
    });
  });
}

export function describeReviewContract(name: string, makeApi: () => VaultApi | Promise<VaultApi>) {
  describe(`ReviewCapability [${name}]`, () => {
    it("all review methods are callable functions", async () => {
      const api = await makeApi();
      const reviewKeys: (keyof ReviewCapability)[] = [
        "appendAiAudit", "persistReviewDecisions",
      ];
      for (const key of reviewKeys) {
        expect(typeof api[key]).toBe("function");
      }
    });
  });
}
