// New Core Runtime packages must never silently create or read local user-data JSON files.
export function readJsonFile<T = unknown>(_key: string, _fallback: T): T {
  throw new Error("Local JSON storage is disabled in this Core Runtime package");
}
export function writeJsonFile(_key: string, _data: unknown): never {
  throw new Error("Local JSON storage is disabled in this Core Runtime package");
}
