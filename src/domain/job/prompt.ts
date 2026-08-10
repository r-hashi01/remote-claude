/** Hard cap on an accepted prompt. */
export const MAX_PROMPT_LENGTH = 20_000;

/**
 * The prompt as the executor will run it.
 *
 * Both rules are about failing at the door rather than in the container: an
 * empty prompt would start a sandbox to ask the agent nothing, and an unbounded
 * one ends up interpolated into a shell command.
 */
export function normalisePrompt(raw: string | undefined): string {
  const prompt = (raw ?? '').trim();
  if (!prompt) throw new Error('prompt is required');
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
  }
  return prompt;
}
