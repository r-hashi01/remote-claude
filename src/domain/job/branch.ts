/**
 * Git refs are interpolated into shell commands in the container, so the
 * accepted character set is deliberately boring. `..` is excluded separately:
 * every character in it is otherwise legal, and it is how a ref reaches
 * somewhere it was not meant to.
 */
export function sanitizeRef(ref: string): string {
  const trimmed = ref.trim();
  if (!/^[A-Za-z0-9._\/-]{1,255}$/.test(trimmed) || trimmed.includes('..')) {
    throw new Error(`invalid branch name: ${trimmed}`);
  }
  return trimmed;
}

/** The branch a job works on when the caller did not name one. */
export function branchForJob(jobId: string): string {
  return `claude/${jobId}`;
}
