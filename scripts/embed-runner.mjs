#!/usr/bin/env node
/**
 * Inline container/runner.mjs into a TypeScript module.
 *
 * The runner used to be baked into the container image with COPY. That made
 * the Worker and the image two artifacts that had to agree, with nothing
 * enforcing it — and they silently disagreed: a wrangler build reported the
 * COPY layer CACHED and shipped a stale runner, while the Worker had already
 * started depending on a feature only the new one had.
 *
 * Shipping the runner inside the Worker bundle removes the failure mode rather
 * than detecting it. There is only one artifact now, so it cannot drift.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'container/runner.mjs'), 'utf8');

const generated = `// GENERATED — do not edit.
// Source: container/runner.mjs
// Regenerate: npm run embed
/* eslint-disable */

/** The in-container job runner, shipped inside the Worker bundle. */
export const RUNNER_SOURCE = ${JSON.stringify(source)};
`;

writeFileSync(join(root, 'src/runner-source.ts'), generated);
process.stderr.write(`embedded container/runner.mjs (${source.length} bytes)\n`);
