export type ActionOutcome = "verified" | "unverified" | "failed" | "rejected" | "busy";

export interface ActionResult {
  ok: boolean;
  outcome: ActionOutcome;
  message: string;
}

export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class KeyedLocks {
  private held = new Set<string>();

  has(key: string): boolean {
    return this.held.has(key);
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.held.add(key);
    try {
      return await fn();
    } finally {
      this.held.delete(key);
    }
  }
}
