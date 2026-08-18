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
 * Everything a job can be continued from: the checkout and the conversation Claude
 * Code keeps beside it.
 *
 * Only that. What this directory holds is what a later turn restores, so anything
 * put here is a decision to carry it forward.
 */
export const WORKSPACE_DIR = '/workspace';

/** Where a repository is checked out. */
export const REPO_DIR = '/workspace/repo';

/**
 * Where the container runner keeps its state files.
 *
 * **Outside the workspace, and that is the point.** These files are how one job
 * hands its progress to the Worker — the log, the status, the result, the raw
 * output. Where the data *lives* is the Durable Object's SQLite and R2; this is the
 * conveyor, not the record.
 *
 * They were under `/workspace`, and so they travelled in the stored workspace and
 * came back on the next turn. It showed: a continuation's log opened with nineteen
 * lines of the turn before it, because the mirror reads that file from the top and
 * the file it read was the one that came back. Worse, the restored status said
 * `completed` beside the previous turn's result, which is all the first poll of a
 * continuation needs to finish it with an answer from before it started — avoided
 * only by the runner rewriting the status a second before that poll looked.
 *
 * An exclusion in the snapshot call would have fixed that instance. This makes the
 * next one impossible: there is nothing to remember, because the conveyor is not in
 * the thing being carried.
 *
 * Not under `/tmp`, deliberately. That is tmpfs on some hosts, and the raw output
 * view has no size limit — which is fine on a disk and is a job's memory budget on
 * a filesystem that is memory.
 */
export const STATE_DIR = '/var/lib/remote-claude';
