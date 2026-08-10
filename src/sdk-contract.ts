/**
 * The SDK's promise, checked against what this Worker actually returns.
 *
 * `sdk/src/types.ts` re-declares the wire shapes rather than importing them
 * from here, because that package must install outside this repository and
 * without `@cloudflare/workers-types`. Duplicated types drift, and a client
 * that quietly disagrees with its server is the worst kind of SDK — so the
 * duplication is verified rather than trusted.
 *
 * Nothing imports this file at runtime; it exists to make `npm run typecheck`
 * fail when the two halves diverge. The failure will name the assertion, and
 * the fix is to change the SDK to match the API — never the other way round,
 * unless the API change is deliberate.
 */

import type { JobRecord, JobRequest, JobSummary, LogLine } from './domain/job/record';
import type { JobStatus } from './domain/job/status';
import type { SandboxLedger } from './domain/sandbox/ledger';
// The published surface, not an internal file: what a consumer can see is what
// has to stay true.
import type * as sdk from '../sdk/src/index';

/** Non-distributive, so unions are compared whole rather than member by member. */
type Extends<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;

// What the API returns must satisfy what the SDK promises its callers.
export type JobRecordIsDescribed = Assert<Extends<JobRecord, sdk.JobRecord>>;
export type JobSummaryIsDescribed = Assert<Extends<JobSummary, sdk.JobSummary>>;
export type LogLineIsDescribed = Assert<Extends<LogLine, sdk.LogLine>>;
export type LedgerIsDescribed = Assert<Extends<SandboxLedger, sdk.SandboxLedger>>;

// Statuses must match exactly in both directions: a status the SDK omits breaks
// callers that switch on it, and one it invents is a state they will wait for
// forever.
export type StatusesAreCovered = Assert<Extends<JobStatus, sdk.JobStatus>>;
export type NoInventedStatuses = Assert<Extends<sdk.JobStatus, JobStatus>>;

// Anything the SDK lets a caller send must be a request this Worker understands.
export type StartJobIsAccepted = Assert<Extends<sdk.StartJob, JobRequest>>;
