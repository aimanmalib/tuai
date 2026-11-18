// Global limits of the relayer: a sliding one-hour window of claim attempts and one broadcast at a time.

const HOUR_MS = 60 * 60 * 1000;

/** Counts attempts in the last hour across all clients. */
export class HourlyLimit {
  private times: number[] = [];
  private readonly max: number;
  private readonly now: () => Date;

  constructor(max: number, now: () => Date) {
    this.max = max;
    this.now = now;
  }

  private prune(): void {
    const from = this.now().getTime() - HOUR_MS;
    this.times = this.times.filter((t) => t > from);
  }

  used(): number {
    this.prune();
    return this.times.length;
  }

  /** Records an attempt; false (and nothing recorded) when the hour is already full. */
  take(): boolean {
    this.prune();
    if (this.times.length >= this.max) return false;
    this.times.push(this.now().getTime());
    return true;
  }
}

/** Runs tasks one after another, so two claims never spend the same relayer or pool outputs. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
