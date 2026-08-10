/**
 * The paths inside a sandbox, in one place.
 *
 * These are a contract with two things that cannot be changed from here: the
 * container image, and `container/runner.mjs` (which defaults to the same values
 * — see ADR 0007 for what happens when two artifacts have to agree). They were
 * declared twice in this layer, once by the job path and once by the session
 * path, which is how the same string starts meaning two different things.
 */

/** Where a repository is checked out. */
export const REPO_DIR = '/workspace/repo';

/** Where the container runner keeps its state files. */
export const STATE_DIR = '/workspace/.remote-claude';
