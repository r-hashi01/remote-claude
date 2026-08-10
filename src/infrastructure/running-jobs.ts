import type { RunningJobs } from '../application/ports';

/**
 * The jobs this executor is driving right now.
 *
 * In memory on purpose, and correct because exactly one Durable Object instance
 * exists: that is what makes the concurrency count trivially right. Nothing here
 * needs to survive a restart — a restarted executor re-adopts what storage says
 * was in flight (see `JobService.adopt`).
 *
 * Cancellation is a flag rather than an `AbortController` because nothing awaits
 * it: the next poll observes it, kills the container's processes and settles.
 */
export class RunningJobRegistry implements RunningJobs {
  private readonly jobs = new Map<string, { cancelled: boolean }>();

  get size(): number {
    return this.jobs.size;
  }

  ids(): string[] {
    return [...this.jobs.keys()];
  }

  has(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  begin(jobId: string): void {
    this.jobs.set(jobId, { cancelled: false });
  }

  end(jobId: string): void {
    this.jobs.delete(jobId);
  }

  requestCancel(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    entry.cancelled = true;
    return true;
  }

  isCancelled(jobId: string): boolean {
    return this.jobs.get(jobId)?.cancelled === true;
  }
}
