/**
 * A non-2xx answer from the executor.
 *
 * `status` is worth branching on: 401/403 means the token, 400 means the request
 * or that deployment's configuration (the message says which), 404 means the job
 * is unknown to it.
 */
export class ExecutorError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ExecutorError';
  }
}
