import { describe, expect, test } from 'vitest';
import { NOT_FOUND, NotFound, REFUSAL, Refusal } from './errors';

/**
 * These two classes are three lines each and were the last thing anybody would
 * have written a test for. Then the name became a wire contract.
 *
 * A refusal thrown inside a Durable Object reaches the HTTP layer as a plain
 * Error: RPC carries the name, message and stack and drops the class. So the
 * literal assigned in the constructor is the only thing that still says which
 * failure this is by the time a status has to be chosen — and a rename here,
 * which reads as a tidy-up, silently turns every refusal into a 500.
 */
describe('the name a failure travels under', () => {
  test('is the constant the HTTP layer compares against', () => {
    expect(new Refusal('pushing is disabled on it').name).toBe(REFUSAL);
    expect(new NotFound('job nope is not one this executor knows').name).toBe(NOT_FOUND);
  });

  // Not interchangeable: "not like that" and "not here" are different answers,
  // and they were briefly the same one.
  test('distinguishes the two', () => {
    expect(REFUSAL).not.toBe(NOT_FOUND);
  });

  test('survives being rebuilt from name and message alone', () => {
    const original = new Refusal('this executor kept no workspace');
    // What RPC hands over: a plain Error wearing the same name.
    const delivered = Object.assign(new Error(original.message), { name: original.name });

    expect(delivered instanceof Refusal).toBe(false);
    expect(delivered.name).toBe(REFUSAL);
    expect(delivered.message).toBe('this executor kept no workspace');
  });
})
