import type { JobGateway } from '../application/ports.js';
import { normaliseUrl } from '../domain/endpoint.js';
import type { AuthProbe, SandboxLedger } from '../domain/executor.js';
import type {
  ContinueJob,
  JobRecord,
  JobSummary,
  LogPage,
  OutputWindow,
  StartJob,
} from '../domain/job.js';
import { ExecutorError } from './errors.js';

export interface ExecutorConfig {
  /** Base URL of the job API. A trailing slash is tolerated. */
  url: string;
  /** The deployment's `REMOTE_CLAUDE_TOKEN`. */
  token: string;
}

export interface HttpJobGatewayOptions {
  /** Injectable for tests and for runtimes with their own fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * The gateway over HTTP.
 *
 * The only file in this package that knows the API is HTTP: which path each
 * operation lives at, that the create response also carries the id under an older
 * name, that the list endpoint answers to two field names, and that an error body
 * is an envelope worth unwrapping. Everything above it works in jobs.
 *
 * Nothing is persisted or logged here, and the token is held only for the
 * lifetime of this object.
 */
export class HttpJobGateway implements JobGateway {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ExecutorConfig, options: HttpJobGatewayOptions = {}) {
    this.base = normaliseUrl(config.url);
    this.token = config.token;
    // Wrapped rather than referenced: an unbound `fetch` throws an illegal
    // invocation in some runtimes.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async ping(): Promise<boolean> {
    // Unauthenticated on the executor's side by design, so this proves the URL
    // and nothing at all about the token.
    const response = await this.fetchImpl(`${this.base}/health`, {
      headers: { accept: 'application/json' },
    });
    return response.ok;
  }

  /**
   * Whether Claude Code on that deployment can actually authenticate.
   *
   * A negative answer is a 503 with a body explaining itself, so unlike every
   * other call a non-2xx here is information rather than a failure.
   */
  async checkAuth(): Promise<AuthProbe> {
    const response = await this.fetchImpl(`${this.base}/health/auth`, {
      headers: this.headers(),
    });
    const body = (await response.json().catch(() => null)) as AuthProbe | null;
    if (body && typeof body.ok === 'boolean') return body;
    throw new ExecutorError(`the executor answered ${response.status} for the auth probe`, response.status);
  }

  async create(input: StartJob): Promise<JobRecord> {
    const body = await this.call<JobRecord & { jobId?: string }>('/jobs', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    // Older executors name the id `jobId` in this response only. Normalised here
    // so callers never have to know that.
    return { ...body, id: body.id ?? (body.jobId as string) };
  }

  async continue(jobId: string, input: ContinueJob): Promise<JobRecord> {
    const body = await this.call<JobRecord & { jobId?: string }>(
      `/jobs/${encodeURIComponent(jobId)}/continue`,
      { method: 'POST', body: JSON.stringify(input) }
    );
    return { ...body, id: body.id ?? (body.jobId as string) };
  }

  get(jobId: string): Promise<JobRecord> {
    return this.call<JobRecord>(`/jobs/${encodeURIComponent(jobId)}`);
  }

  async list(limit: number): Promise<JobSummary[]> {
    const body = await this.call<{ jobs?: JobSummary[]; tasks?: JobSummary[] }>(
      `/jobs?limit=${limit}&summary=1`
    );
    // `tasks` is what this endpoint answered with before the rename to jobs.
    return body.jobs ?? body.tasks ?? [];
  }

  async cancel(jobId: string): Promise<void> {
    await this.call(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  }

  logs(jobId: string, since: number): Promise<LogPage> {
    return this.call<LogPage>(`/jobs/${encodeURIComponent(jobId)}/logs?since=${since}`);
  }

  logTail(jobId: string, limit: number): Promise<LogPage> {
    return this.call<LogPage>(`/jobs/${encodeURIComponent(jobId)}/logs?tail=${limit}`);
  }

  output(jobId: string, offset: number, limit = 65_536): Promise<OutputWindow> {
    return this.call<OutputWindow>(
      `/jobs/${encodeURIComponent(jobId)}/output?offset=${offset}&limit=${limit}`
    );
  }

  async getDiff(jobId: string): Promise<string | null> {
    const response = await this.fetchImpl(`${this.base}/jobs/${encodeURIComponent(jobId)}/diff`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    // Not an error: a job that changed nothing has no patch.
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ExecutorError(
        `the executor answered ${response.status} for the diff`,
        response.status
      );
    }
    return response.text();
  }

  sandboxes(): Promise<SandboxLedger> {
    return this.call<SandboxLedger>('/sandboxes');
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    };
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers: { ...init.headers, ...this.headers() },
    });

    if (!response.ok) {
      // The executor answers errors as {"error": "..."}. Unwrap it: the message
      // it writes is the useful part — often about its own configuration — and a
      // caller should not have to parse the envelope to show it.
      const raw = (await response.text().catch(() => '')).slice(0, 1_000);
      let detail = raw;
      try {
        const parsed = JSON.parse(raw) as { error?: string };
        if (parsed.error) detail = parsed.error;
      } catch {
        // Not JSON — Cloudflare Access in front of the executor, most likely.
      }
      throw new ExecutorError(
        `${init.method ?? 'GET'} ${path} failed (${response.status}): ${detail}`,
        response.status
      );
    }

    return (await response.json()) as T;
  }
}
