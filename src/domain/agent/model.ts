import { Refusal } from '../job/errors';

/**
 * Which model a run uses.
 *
 * Anything Claude Code's `--model` accepts: an alias (`opus`, `sonnet`,
 * `haiku`), a full id (`claude-opus-4-5-20251101`), or a provider-qualified one
 * (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`). This deliberately does not
 * hold a list of known models — a list here would be stale the week a model is
 * released, and the one thing worse than an unrecognised model is a recognised
 * model being refused.
 *
 * So the rule is about shape, not membership. What it exists to catch is a
 * caller sending something that is not a model name at all — a sentence, a path,
 * a shell fragment — which is otherwise discovered twenty seconds into a job,
 * after a sandbox has been created and a repository cloned. Whether the name
 * means anything is Anthropic's answer, and it arrives in the agent step's own
 * error message.
 */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,99}$/;

/**
 * The model to use, or `undefined` to leave the choice to whoever is next.
 *
 * Empty and blank are `undefined` rather than a refusal: for a job that means
 * "the deployment's model", and for a deployment it means "Claude Code's
 * default". An option somebody left blank is one they did not set — unlike
 * `commands`, where an empty string is the instruction to skip a step.
 */
export function normaliseModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const model = value.trim();
  if (!model) return undefined;

  if (!MODEL_NAME.test(model)) {
    throw new Refusal(
      `"${model.slice(0, 60)}" is not a model name. Pass an alias (opus, sonnet, haiku) or ` +
        'a model id such as claude-opus-4-5-20251101; the executor does not keep a list of ' +
        'valid models, so anything shaped like a name is passed to Claude Code as it is.'
    );
  }
  return model;
}
