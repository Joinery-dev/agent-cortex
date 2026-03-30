/**
 * Simple counting semaphore for limiting concurrent async operations.
 *
 * Usage:
 *   const sem = new Semaphore(5);
 *   const results = await Promise.all(items.map(item => sem.run(() => doWork(item))));
 */
export class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {
    if (maxConcurrency < 1) {
      throw new Error(`Semaphore concurrency must be >= 1, got ${maxConcurrency}`);
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Keep running count the same — slot transfers to next waiter
      next();
    } else {
      this.running--;
    }
  }
}
