/**
 * A gateway that answers from memory.
 *
 * Only tests import this. It exists so the polling loop — the one piece of real
 * behaviour in this package — can be tested without a server, a clock or a
 * network, by scripting exactly the sequence of answers that used to require an
 * executor and a few minutes of waiting.
 */

import type { JobRecord, JobSummary, LogLine, LogPage, StartJob } from '../domain/job.js';
import type { AuthProbe, JobGateway, SandboxLedger } from './ports.js';

export class FakeJobGateway implements JobGateway {
  /** Answers for successive `get` calls; the last one repeats. */
  states: JobRecord[] = [];
  /** Every log line produced so far. Append between polls to simulate output. */
  lines: LogLine[] = [];
  /** Called before each `get`, with the number of gets already served. */
  onGet: ((attempt: number) => void) | undefined;

  readonly calls: string[] = [];
  created: StartJob | null = null;
  cancelled: string[] = [];
  diff: string | null = null;

  private gets = 0;

  async ping(): Promise<boolean> {
    this.calls.push('ping');
    return true;
  }

  async checkAuth(): Promise<AuthProbe> {
    this.calls.push('checkAuth');
    return { ok: true };
  }

  async create(input: StartJob): Promise<JobRecord> {
    this.calls.push('create');
    this.created = input;
    return this.states[0] as JobRecord;
  }

  async get(_jobId: string): Promise<JobRecord> {
    this.onGet?.(this.gets);
    this.calls.push('get');
    const state = this.states[Math.min(this.gets, this.states.length - 1)];
    this.gets += 1;
    if (!state) throw new Error('the test scripted no states');
    return state;
  }

  async list(_limit: number): Promise<JobSummary[]> {
    this.calls.push('list');
    return this.states as JobSummary[];
  }

  async cancel(jobId: string): Promise<void> {
    this.calls.push('cancel');
    this.cancelled.push(jobId);
  }

  async logs(_jobId: string, since: number): Promise<LogPage> {
    this.calls.push(`logs:${since}`);
    const logs = this.lines.filter((line) => line.seq > since);
    return { logs, nextSince: logs.at(-1)?.seq ?? since };
  }

  async getDiff(_jobId: string): Promise<string | null> {
    this.calls.push('getDiff');
    return this.diff;
  }

  async sandboxes(): Promise<SandboxLedger> {
    this.calls.push('sandboxes');
    return { outstanding: [], destroyed: 0, running: [], entries: [] };
  }
}

/** A line the way the executor would have written it. */
export function line(seq: number, text: string): LogLine {
  return { seq, ts: seq, stream: 'stdout', line: text };
}
