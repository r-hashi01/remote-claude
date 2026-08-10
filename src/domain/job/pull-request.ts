import type { JobRecord, JobResult, StepResult } from './record';

/**
 * The pull request a finished job opens.
 *
 * What a caller may override, and what the executor fills in otherwise. The
 * defaults exist because the caller with the most context — a product that knows
 * which work item this was — is not always the one submitting the job, and a
 * branch with no pull request is a result nobody outside this machine can see.
 */
export interface PullRequestRequest {
  title?: string;
  body?: string;
  draft?: boolean;
}

export interface PullRequestContent {
  title: string;
  body: string;
  draft: boolean;
}

/**
 * Titles are truncated to the same length the commit subject uses, so a branch
 * and its pull request read the same in a list.
 */
const MAX_TITLE_LENGTH = 68;

export function composePullRequest(
  job: Pick<JobRecord, 'id' | 'prompt' | 'baseBranch' | 'branch' | 'pullRequest'>,
  result: JobResult | undefined
): PullRequestContent {
  const request = job.pullRequest ?? {};
  return {
    title: request.title?.trim() || defaultTitle(job.prompt),
    body: request.body?.trim() || defaultBody(job, result),
    draft: request.draft === true,
  };
}

function defaultTitle(prompt: string): string {
  const firstLine = prompt.split('\n')[0]?.trim() ?? '';
  const title = firstLine || 'remote-claude job';
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}

/**
 * What a reviewer needs and cannot get from the diff: what was asked, and what
 * the executor itself observed afterwards.
 *
 * Deliberately not the agent's closing message. That is a summary written by the
 * thing being reviewed; the steps below are what actually ran.
 */
function defaultBody(
  job: Pick<JobRecord, 'id' | 'prompt' | 'baseBranch' | 'branch'>,
  result: JobResult | undefined
): string {
  const lines = [job.prompt.trim(), '', '---', '', `remote-claude job \`${job.id}\``, ''];

  if (result?.diffStat) lines.push('```', result.diffStat.trim(), '```', '');

  const checks = (result?.steps ?? []).filter((step) => CHECK_STEPS.has(step.name));
  if (checks.length > 0) {
    lines.push(...checks.map(describeStep), '');
  }

  lines.push(`Ran against \`${job.baseBranch}\` on branch \`${job.branch}\`.`);
  return lines.join('\n');
}

const CHECK_STEPS = new Set(['install', 'lint', 'test', 'build']);

function describeStep(step: StepResult): string {
  if (step.skipped) return `- ⏭ ${step.name} — ${step.output}`;
  const mark = step.success ? '✔' : '✖';
  return `- ${mark} ${step.name} (${step.command})`;
}
