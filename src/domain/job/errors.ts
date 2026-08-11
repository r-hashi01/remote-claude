/**
 * A refusal: the request, or this deployment's configuration, not a fault.
 *
 * Exists because the HTTP layer used to guess. It matched the message against a
 * list of words — `required|invalid|must|disabled|exceeds` — and anything else
 * became a 500. Every new refusal had to remember to contain one of those words,
 * and the ones that forgot reported a caller's mistake as a server error. That
 * happened twice: "cannot reach" had to be added by hand, and "kept no
 * workspace" was a 500 the first time anybody saw it.
 *
 * Throwing this says what the status is, once, where the reason is known.
 */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refusal';
  }
}
