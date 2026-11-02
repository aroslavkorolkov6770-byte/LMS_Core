import type { HealthCheck } from "./service-health";

export class PageReadinessCache {
  private readonly values = new Map<string, { expires: number; result: HealthCheck }>();
  private readonly pending = new Map<string, Promise<HealthCheck>>();
  private generation = 0;
  constructor(private readonly ttlMs = 15000, private readonly now = () => performance.now()) {}
  invalidate() { ++this.generation; this.values.clear(); this.pending.clear(); }
  async check(key: string, load: () => Promise<HealthCheck>, fresh = false): Promise<HealthCheck> {
    const running = this.pending.get(key);
    if (running) return running;
    const saved = this.values.get(key);
    if (!fresh && saved && saved.expires > this.now()) return { ...saved.result };
    const generation = this.generation;
    const task: Promise<HealthCheck> = Promise.resolve().then(load).then((result) => {
      if (generation === this.generation) {
        if (result.healthState === "healthy") this.values.set(key, { expires: this.now() + this.ttlMs, result: { ...result } });
        else this.values.delete(key);
      }
      return result;
    }).finally(() => { if (this.pending.get(key) === task) this.pending.delete(key); });
    this.pending.set(key, task);
    return task;
  }
}
