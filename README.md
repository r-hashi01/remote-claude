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

> **One person's deployment.** The container signs in as *you*: your Claude
> subscription, over OAuth. Anthropic's
> [consumer terms](https://www.anthropic.com/legal/consumer-terms) say you "may
> not share your Account login information, Anthropic API key, or Account
> credentials with anyone else" and "may not make your Account available to
> anyone else" — and a deployment that runs other people's prompts on your
> credential is doing the second one, whether or not anybody ever sees the token.
> Standing this up as a shared service for a team is not a feature this project
> has yet to add: there is no notion of a user anywhere in it — no accounts, no
> seats, no per-person tokens, nothing that attributes a job to whoever asked for
> it. Which is also the reason to say this out loud. Nothing in the software
> enforces it. One bearer token is the whole gate, and handing that string to ten
> people is something no part of the system would notice or object to.
> [Security](docs/operating.md#security).

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
