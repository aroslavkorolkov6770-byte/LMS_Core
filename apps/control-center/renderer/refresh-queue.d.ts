export interface RefreshQueue<T> {
  request(fresh?: boolean): Promise<T>;
}

export function createRefreshQueue<T>(load: (fresh: boolean) => T | Promise<T>): RefreshQueue<T>;
