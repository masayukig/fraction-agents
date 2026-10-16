/** A turn a task waits for: granted with `true`, or `false` when the task was canceled while it waited. */
export interface Turn {
  granted: Promise<boolean>;
  /** Whether the turn was granted at once, without waiting. */
  immediate: boolean;
}

interface Waiter {
  taskId: string;
  grant: (granted: boolean) => void;
}

/**
 * How many tasks work at once in the whole agent (ADR 0019). A task over the limit waits for its turn, in the order
 * it came; a task that comes back from the caller's answer goes before the new ones, so that tasks begun finish
 * first. Without a limit every turn is granted at once.
 */
export class TaskSlots {
  readonly #limit: number | undefined;
  readonly #holders = new Set<string>();
  /** Tasks that come back from the caller's answer. */
  readonly #resumed: Waiter[] = [];
  readonly #fresh: Waiter[] = [];
  #closed = false;

  constructor(limit: number | undefined) {
    this.#limit = limit;
  }

  /** Waits for the task's turn. `resumed` puts it before the new tasks. */
  acquire(taskId: string, resumed = false): Turn {
    if (this.#closed) return { granted: Promise.resolve(false), immediate: false };
    if (this.#limit === undefined || this.#holders.size < this.#limit) {
      this.#holders.add(taskId);
      return { granted: Promise.resolve(true), immediate: true };
    }
    const granted = new Promise<boolean>((resolve) => (resumed ? this.#resumed : this.#fresh).push({ taskId, grant: resolve }));
    return { granted, immediate: false };
  }

  /** Gives the task's slot to the next task waiting, if the task holds one. */
  release(taskId: string): void {
    if (!this.#holders.delete(taskId)) return;
    const next = this.#resumed.shift() ?? this.#fresh.shift();
    if (!next || this.#closed) return;
    this.#holders.add(next.taskId);
    next.grant(true);
  }

  /**
   * Grants no turn from here on. For shutting down: the tasks in the line are left as they are, unfinished, and the
   * next start marks them failed like the tasks that were working (ADR 0019).
   */
  close(): void {
    this.#closed = true;
    this.#resumed.length = 0;
    this.#fresh.length = 0;
  }

  /** Takes the task out of the line, if it waits in it. Returns whether it did. */
  cancel(taskId: string): boolean {
    for (const line of [this.#resumed, this.#fresh]) {
      const index = line.findIndex((waiter) => waiter.taskId === taskId);
      if (index < 0) continue;
      const [waiter] = line.splice(index, 1);
      waiter!.grant(false);
      return true;
    }
    return false;
  }
}
