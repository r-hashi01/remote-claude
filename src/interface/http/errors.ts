import { NotFound, Refusal } from '../../domain/job/errors';
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
  const status = error instanceof NotFound ? 404 : error instanceof Refusal ? 400 : 500;
  return Response.json({ error: message }, { status });
}
