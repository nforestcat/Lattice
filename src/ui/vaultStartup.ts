const LAST_VAULT_KEY = "lattice:lastVaultPath";
const DEMO_VAULT = "Demo Vault";

export function getStartupVaultPath(storage: Storage, isDesktop: boolean): string {
  if (!isDesktop) {
    return DEMO_VAULT;
  }

  return storage.getItem(LAST_VAULT_KEY) || DEMO_VAULT;
}

export function rememberVaultPath(storage: Storage, path: string): void {
  storage.setItem(LAST_VAULT_KEY, path);
}
