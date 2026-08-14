# remote-claude

Run Claude Code in a Cloudflare Sandbox instead of on your machine.

A job is a prompt and a repository. The executor clones the repository into an
isolated container, runs Claude Code against it, runs your install/lint/test
commands, commits what changed, and hands back a diff — or pushes the branch and
opens a pull request. Nothing runs locally: no Claude Code, no Docker.

```bash
remote-claude "Investigate the 500 on login and fix it"
```

> **Scope.** This is an execution substrate. It knows about *jobs* and
> deliberately nothing about what you are using them for — projects, work items
> and their statuses belong to the product on the other side of the API
> ([ADR 0003](docs/adr/0003-separate-execution-from-product.md)). The product
> built on this one is [spindle](https://github.com/r-hashi01/spindle).

> **You deploy it, and it works for you.** Claude Code signs in with a
> subscription, and Anthropic's
> [terms for Claude Code](https://code.claude.com/docs/en/legal-and-compliance)
> say OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max,
> Team, and Enterprise subscription plans", while Anthropic "does not permit
> third-party developers to offer Claude.ai login or to route requests through
> Free, Pro, or Max plan credentials on behalf of their users."
>
> The line is not about where the container runs — deploying this to your own
> Cloudflare account is no different from renting a VM and running Claude Code on
> it. The line is whether a product stands between somebody and their own
> credential. So: deploy your own, use it yourself. Do not run one and let other
> people send prompts to it; if you are building something for other people, that
> is what [API keys and the commercial terms](https://platform.claude.com/) are
> for, and the flat-subscription economics below do not survive the move.
>
> The API cannot be handed a credential — no request type has a field for one, and
> [a test](src/conventions.test.ts) fails if somebody adds one. Everything else
> here is a decision you have to keep making. [Security](SECURITY.md).

## Documentation

| | |
| --- | --- |
| **[Using it](docs/usage.md)** | Submitting jobs, every option, reading results, pull requests, interactive sessions, and what each failure means |
| **[Operating it](docs/operating.md)** | Prerequisites, secrets, the GitHub App, deploying, configuration, security, cost |
| [SDK](sdk/README.md) | The typed client: `npm i @r-hashi01/remote-claude-client` |
| [Security](SECURITY.md) | The threat model, what to report and where, and what is a decision rather than a bug |
| [Decisions](docs/adr/) | Why it is built this way, including the corrections (Japanese) |
| [Roadmap](docs/roadmap.md) | What is known to be missing, from observed failures (Japanese) |

## How it works

```text
your machine
   │  the remote-claude CLI, the SDK, or plain HTTPS with a bearer token
   ▼
Cloudflare Worker ─── control plane only; Claude Code never runs here
   │
   ├── JobManager (Durable Object)
   │     the queue, job state and logs in SQLite; patches in R2
   │
   ▼ Sandbox SDK
Cloudflare Sandbox / container ─── one job, one container
   ├── /workspace/repo         the checkout
   ├── claude                  authenticated by subscription OAuth
   ├── git, node, python, build tools
   │
   ├──▶ api.anthropic.com      the Worker injects the real token on the way out
   └──▶ github.com             the Worker injects a GitHub App token on the way out
        every other destination is blocked
```

Two properties follow from that shape, and most of the design serves them.

**No credential is inside the container.** The container holds a placeholder.
The Worker's outbound handler swaps in the real Claude token, and a short-lived
GitHub App installation token, as requests leave — so nothing sensitive is on the
sandbox filesystem, in its environment, in the image, or in any backup
([ADR 0002](docs/adr/0002-no-credentials-inside-the-container.md)).

**The pipeline runs in the container, not in the Worker.** A Durable Object gets
30 seconds of CPU between requests, which once capped jobs at about 51 seconds.
The runner is shipped into the sandbox with each job, and the Worker only starts
it and mirrors what it writes
([ADR 0004](docs/adr/0004-run-the-pipeline-inside-the-container.md),
[ADR 0007](docs/adr/0007-ship-the-runner-with-the-worker.md)).

## Quick start

You need a deployment first — see [Operating it](docs/operating.md). Once it is
up:

```bash
remote-claude health                      # is it there?
remote-claude health --auth               # can it authenticate to Claude?
remote-claude "add a test for parseDiff"  # start a job and follow it
```

Read what happened, and take the change:

```bash
remote-claude status <job-id>   # usage, cost, checks, the agent's closing message
remote-claude diff <job-id>     # the patch
remote-claude apply <job-id>    # apply it here
```

Or have the executor deliver it, so that seeing the result needs no CLI at all:

```bash
remote-claude "add a test for parseDiff" --pr
```

From code, use the SDK rather than writing HTTP:

```ts
import { createClient } from '@r-hashi01/remote-claude-client';

const rc = createClient({ url: process.env.REMOTE_CLAUDE_URL!, token: process.env.REMOTE_CLAUDE_TOKEN! });
const job = await rc.startJob({ prompt: 'add a test for parseDiff', pullRequest: {} });
const finished = await rc.waitForJob(job.id, {
  onLog: (lines) => lines.forEach((line) => console.log(line.line)),
});
```

## Repository layout

Four layers, with the arrows pointing inward only
([ADR 0008](docs/adr/0008-layer-the-executor.md)):

```text
src/
  interface/http/     HTTP in, JSON out. Decides nothing
  application/        the use cases, written against ports
    ports/              what the outside world has to provide
    testing.ts          in-memory implementations of every port
  domain/             the rules. Imports nothing
  infrastructure/     the ports implemented: Durable Objects, SQLite, R2, GitHub, the sandbox
container/runner.mjs  the pipeline, executed inside the sandbox
sdk/                  the published client
cli/                  the local CLI and its dashboard
```

`domain` and `application` run without workerd, a container, or a network, which
is what makes the interesting parts testable at all:

```bash
npm test            # domain, application, SDK
npm run typecheck   # the Worker, tests included
npm run sdk:typecheck
```

## Status

Working: jobs, per-job commands, other repositories, push, pull requests,
interactive ACP sessions, and retries for platform hiccups.

Not working, and documented as such: the workspace cache reads its settings and
is never called ([roadmap](docs/roadmap.md) RC-10). One failure mode is still
unexplained — a runner that starts, says nothing and stops. It is retried rather
than diagnosed, and a marker was added so the next occurrence says which half
failed (RC-15).
