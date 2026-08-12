import { describe, expect, test } from 'vitest';
import { NotFound, Refusal } from '../../domain/job/errors';
import { toErrorResponse } from './errors';

const plain = (input: string) => input;

describe('toErrorResponse', () => {
  // The reason this type exists: the status used to be guessed from the wording,
  // and "kept no workspace" was a 500 the first time anybody saw it.
  test('a refusal is the caller’s problem, whatever it says', async () => {
    const answer = toErrorResponse(new Refusal('this executor kept no workspace'), plain);

    expect(answer.status).toBe(400);
    await expect(answer.json()).resolves.toEqual({ error: 'this executor kept no workspace' });
  });

  // "not like that" and "not here" are different answers. Continuing a job that
  // does not exist used to give 400 while fetching the same job gave 404, so a
  // caller could not tell them apart.
  test('something that is not there is 404', async () => {
    const answer = toErrorResponse(new NotFound('job nope is not one this executor knows about'), plain);

    expect(answer.status).toBe(404);
    await expect(answer.json()).resolves.toMatchObject({ error: expect.stringContaining('nope') });
  });

  test('anything else is ours', async () => {
    const answer = toErrorResponse(new Error('too many SQL variables'), plain);

    expect(answer.status).toBe(500);
    await expect(answer.json()).resolves.toEqual({ error: 'too many SQL variables' });
  });

  test('something thrown that is not an error still answers', async () => {
    const answer = toErrorResponse('a string, somehow', plain);
    expect(answer.status).toBe(500);
    await expect(answer.json()).resolves.toEqual({ error: 'a string, somehow' });
  });

  // An error message is one of the places a secret can leave the building.
  test('redacts the message on the way out', async () => {
    const redact = (input: string) => input.replaceAll('sk-ant-secret', '[redacted]');
    const answer = toErrorResponse(new Refusal('clone failed for sk-ant-secret'), redact);

    await expect(answer.json()).resolves.toEqual({ error: 'clone failed for [redacted]' });
  });
});

/**
 * What a Durable Object's throw looks like by the time it gets here.
 *
 * The classification worked in every test and none of them crossed the boundary
 * the real request crosses: `createJob` runs inside the JobManager object, and
 * RPC rebuilds the error from its name, message and stack — not from its class.
 * So `instanceof Refusal` was false in production and every refusal raised
 * inside the object answered 500. Live, naming an unreachable repository:
 *
 *   POST /jobs failed (500): this executor's GitHub App installation cannot
 *   reach no-such-owner/no-such-repo. …
 *
 * 500 also means "worth retrying" to every client that follows the SDK's rule,
 * so a permanent refusal was something consumers would retry forever.
 */
describe('an error that has crossed a Durable Object boundary', () => {
  /** As RPC delivers it: the right name, the wrong prototype. */
  function acrossRpc(name: string, message: string): Error {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  test('a refusal is still the caller\'s, not the server\'s', () => {
    const answer = toErrorResponse(acrossRpc('Refusal', 'pushing is disabled on it'), plain);
    expect(answer.status).toBe(400);
  });

  test('a missing thing is still missing', () => {
    const answer = toErrorResponse(acrossRpc('NotFound', 'job nope is not one this executor knows'), plain);
    expect(answer.status).toBe(404);
  });

  // The names are the contract, so nothing else may borrow them by accident.
  test('anything else is still the server\'s problem', () => {
    expect(toErrorResponse(acrossRpc('TypeError', 'x is not a function'), plain).status).toBe(500);
    expect(toErrorResponse(acrossRpc('Error', 'too many SQL variables'), plain).status).toBe(500);
  });
});
