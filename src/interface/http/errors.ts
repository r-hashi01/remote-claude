import { NOT_FOUND, NotFound, REFUSAL, Refusal } from '../../domain/job/errors';
import type { Redact } from '../../application/ports';

/**
 * Turn a thrown thing into an answer.
 *
 * Separate from the entry point so that it can be tested without workerd: the
 * entry point exports Durable Object classes, which cannot be imported outside
 * it. What is worth testing here is not the wiring but the two rules — which
 * failures are the caller's, and that nothing secret rides out in a message.
 */
export function toErrorResponse(error: unknown, redact: Redact): Response {
  const message = redact(error instanceof Error ? error.message : String(error));

  // Each error says what it is. This used to be guessed from the wording, by
  // matching against a list of words, so every new refusal had to remember to
  // contain one of them — and the ones that forgot reported a caller's mistake
  // as a server error.
  const status = statusFor(error);
  return Response.json({ error: message }, { status });
}

/**
 * Which failure this is.
 *
 * `instanceof` is the answer while the throw and the catch are in one place. The
 * request's throws are not: `createJob` runs inside the JobManager Durable
 * Object, and RPC rebuilds an error from its name, message and stack rather than
 * its class — so every refusal raised inside the object arrived as a plain Error
 * and was answered 500. Which also tells every client following the SDK's rule
 * that the failure is worth retrying, so a permanent refusal became something
 * consumers would retry forever.
 *
 * The tests all passed because they all called the service directly. The name is
 * checked as well precisely because it is what survives the crossing.
 */
function statusFor(error: unknown): number {
  if (error instanceof NotFound) return 404;
  if (error instanceof Refusal) return 400;
  const name = error instanceof Error ? error.name : '';
  if (name === NOT_FOUND) return 404;
  if (name === REFUSAL) return 400;
  return 500;
}
