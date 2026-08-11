/**
 * The paths inside a sandbox, in one place.
 *
 * These are a contract with two things that cannot be changed from here: the
 * container image, and `container/runner.mjs` (which defaults to the same values
 * — see ADR 0007 for what happens when two artifacts have to agree). They were
 * declared twice in this layer, once by the job path and once by the session
 * path, which is how the same string starts meaning two different things.
 */

/**
 * Everything a job can be continued from: the checkout, the state files, and the
 * conversation Claude Code keeps beside them.
 */
export const WORKSPACE_DIR = '/workspace';

/** Where a repository is checked out. */
export const REPO_DIR = '/workspace/repo';

/** Where the container runner keeps its state files. */
export const STATE_DIR = '/workspace/.remote-claude';
