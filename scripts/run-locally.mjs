#!/usr/bin/env node
/**
 * Run the container job runner against a local checkout.
 *
 * Why: the only way to exercise the pipeline was deploy, start a job, wait,
 * read logs — about four minutes per iteration. Most of the defects found while
 * building it were mechanical (a wrong flag, output handled in the wrong shape,
 * a duplicated translator) and would have surfaced in seconds here.
 *
 * This runs the same runner.mjs the Worker ships, so what it exercises is the
 * real thing, not a model of it.
 *
 * It always works on a throwaway clone, never on the directory you point it
 * at. The runner branches and commits — that is its job — and pointed at a live
 * working tree it will commit whatever is sitting there, untracked files
 * included, onto a branch that then gets discarded. Isolation is not a
 * convenience here; it is the property that made the runner safe to write in
 * the first place.
 *
 *   node scripts/run-locally.mjs <repo-dir> "<prompt>" [--no-agent]
 *
 * --no-agent replaces the Claude step with a no-op, so the surrounding pipeline
 * can be tested without spending subscription quota or local CPU.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeProcessEnvironment } from '../src/domain/agent/environment.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const noAgent = argv.includes('--no-agent');
const [repoArg, prompt] = argv.filter((a) => !a.startsWith('--'));

if (!repoArg || !prompt) {
  process.stderr.write('usage: run-locally.mjs <repo-dir> "<prompt>" [--no-agent]\n');
  process.exit(2);
}

const repoDir = resolve(repoArg);
if (!existsSync(join(repoDir, '.git'))) {
  process.stderr.write(`not a git repository: ${repoDir}\n`);
  process.exit(2);
}

// Clone rather than use the directory directly. --local hardlinks, so this is
// cheap, and it mirrors the sandbox: only committed state comes across.
const workDir = mkdtempSync(join(tmpdir(), 'remote-claude-work-'));
const checkout = join(workDir, 'repo');
const clone = spawnSync('git', ['clone', '--local', '--quiet', repoDir, checkout]);
if (clone.status !== 0) {
  process.stderr.write(`clone failed: ${clone.stderr?.toString() ?? ''}\n`);
  process.exit(1);
}

const stateDir = mkdtempSync(join(tmpdir(), 'remote-claude-'));
const branch = `local/${Date.now().toString(36)}`;

writeFileSync(
  join(stateDir, 'job.json'),
  JSON.stringify({
    id: 'local',
    prompt,
    branch,
    baseBranch: 'main',
    options: { skipChecks: false, keepSandbox: false, push: false },
    commands: { install: '', lint: '', test: '', build: '' },
    stepTimeoutMs: 600_000,
    claudeTimeoutMs: 600_000,
  })
);

process.stderr.write(`state:  ${stateDir}\nclone:  ${checkout}\nsource: ${repoDir} (untouched)\nbranch: ${branch}\n\n`);

// The same environment the Worker builds, so the harness exercises the runner
// under the conditions it actually runs in — including the Anthropic variables
// being unset, which is a rule the pipeline verifies for itself.
//
// One value is deliberately not applied. In the container the conversation
// directory is moved inside /workspace so that a single snapshot carries both
// the tree and the conversation, and authentication comes from the environment
// rather than from that directory — the container's is empty either way. Here it
// is where `claude setup-token` left your credentials, so moving it logs you out.
const { CLAUDE_CONFIG_DIR: _containerOnly, ...overrides } = claudeProcessEnvironment({
  authMode: 'direct',
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  ci: true,
});
const env = { ...process.env, ...overrides, REPO_DIR: checkout, IS_SANDBOX: '1' };
// `undefined` means unset, which an inherited environment will not do by itself.
for (const [name, value] of Object.entries(overrides)) if (value === undefined) delete env[name];
if (noAgent) {
  // The runner invokes `claude`; shadow it with a stub on PATH.
  const stubDir = mkdtempSync(join(tmpdir(), 'rc-stub-'));
  writeFileSync(join(stubDir, 'claude'), '#!/bin/sh\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"result\\":\\"(agent skipped)\\"}"\n', { mode: 0o755 });
  env.PATH = `${stubDir}:${env.PATH}`;
}

const child = spawn('node', [join(root, 'container/runner.mjs'), stateDir], { env, stdio: 'inherit' });

child.on('close', (code) => {
  const read = (name) => {
    try {
      return readFileSync(join(stateDir, name), 'utf8');
    } catch {
      return null;
    }
  };

  process.stderr.write('\n--- log ---\n');
  for (const line of (read('log.ndjson') ?? '').split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    process.stderr.write(`[${entry.stream}] ${entry.line}\n`);
  }

  process.stderr.write(`\n--- status ---\n${read('status.json') ?? '(none)'}\n`);
  process.stderr.write(`\nexit ${code}. artifacts remain in ${stateDir}\n`);
  process.exit(code ?? 1);
});
