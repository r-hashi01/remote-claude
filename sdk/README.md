# @r-hashi01/remote-claude-client

A typed client for [remote-claude](https://github.com/r-hashi01/remote-claude)'s job API.

remote-claude runs Claude Code in a Cloudflare Sandbox: give it a prompt and a
repository, get back a diff. This package is how you talk to a deployment of it,
so that you do not start by hand-writing fetch calls.

No dependencies. Node 18+ or any runtime with a global `fetch`.

```bash
npm install @r-hashi01/remote-claude-client
```

## Running a job

```ts
import { createClient, describeOutcome } from '@r-hashi01/remote-claude-client';

const rc = createClient({
  url: process.env.REMOTE_CLAUDE_URL!,
  token: process.env.REMOTE_CLAUDE_TOKEN!,
});

const job = await rc.startJob({ prompt: 'Investigate the 500 on login and fix it' });

const finished = await rc.waitForJob(job.id, {
  onLog: (lines) => lines.forEach((line) => console.log(line.line)),
  onStatus: (status) => console.error(`-> ${status}`),
});

console.log(describeOutcome(finished));

if (finished.status === 'completed') {
  const patch = await rc.getDiff(job.id);
  // apply it, open a PR, show it to somebody
}
```

`waitForJob` resolves on `failed` and `cancelled` too: those are outcomes, not
exceptions. Read `status` and `error`.

A failed job still carries `result.steps` — the commands the executor ran and
what each printed — which is usually what a reader wants from a failure. The
reason it failed is on `error`, not inside `result`.

## Watching it happen

Two views, and they answer different questions. `waitForJob`'s `onLog` gives
parsed lines — the step markers, and which stream each came from — and answers
**where a run is up to**. `followOutput` gives the bytes the commands produced,
unsplit and untruncated, and answers **what is happening**.

```ts
const outcome = await rc.followOutput(job.id, {
  onChunk: (text, offset) => process.stdout.write(text),
  onStart: (offset, skipped) =>
    skipped > 0 && console.error(`joined late; ${skipped} bytes skipped`),
  onIdle: () => {},           // nothing new; the stream is alive, not wedged
});

console.error(`job ${outcome.status}`);
```

Over SSE, resumable, and readable by several viewers at once. Three things worth
knowing before you build on it:

- **The offset is what you were shown**, not what the executor read. A tail is
  withheld while more can arrive, so a credential falling across the end of a
  window is masked on the read that completes it rather than half-sent. Resume
  from the offset in the last chunk, never from a count of your own.
- **It ends by saying so.** `followOutput` resolves with the job's status, which
  is how a finished run is distinguishable from a dropped connection.
- **It lives as long as the container.** The parsed log outlives the job; this
  does not. And there is no ANSI in it: commands run without a TTY, so tools
  print no colour and redraw nothing.

There is no input channel, and there will not be one. What you want to change,
say in the conversation and continue the job.

## Another repository

A deployment has one configured repository and will run against others when it
is set up to (`ALLOW_CUSTOM_REPO=true`) — and then only for repositories its
GitHub App installation can actually reach. It confirms that with GitHub before
starting anything, so a repository nobody granted it access to fails on this
call rather than minutes later on clone:

```ts
await rc.startJob({ prompt: 'Add a health endpoint', repo: 'https://github.com/acme/app.git' });
// ExecutorError (400): this executor's GitHub App installation cannot reach acme/app...
```

`ExecutorError` carries `status`, which is worth branching on: 401/403 means the
token, 400 means the request or that deployment's configuration (the message
says which), 404 means the job is unknown to it.

## Checking a connection

```ts
if (!(await rc.health())) throw new Error('nothing is answering there');
await rc.listJobs(1); // /health is unauthenticated, so this is what proves the token
```

## The rest of the surface

| Call | What it does |
| --- | --- |
| `startJob(input)` | Queue a job. Returns as soon as it is accepted |
| `getJob(id)` | The full record, including `result` and `usage` |
| `listJobs(limit?)` | Recent jobs, newest first, without step output |
| `getLogs(id, since?)` | One page of logs; feed `nextSince` back in |
| `getDiff(id)` | The patch, or `null` while there is not one |
| `continueJob(id, input)` | A follow-up turn on a finished job: same branch, same conversation |
| `cancelJob(id)` | Ask the executor to stop |
| `waitForJob(id, opts?)` | Poll until it finishes |
| `followOutput(id, opts?)` | Follow what the commands print, as they print it |
| `checkAuth()` | Whether Claude Code on that deployment can authenticate |
| `listSandboxes()` | What it has allocated and whether it got it back |

Every operation is also exported as a function taking the config first
(`startJob(config, input)`), for callers that hold a config rather than a client.

## Layout

Layered the same way the executor is:

```text
src/
  domain/          what a job is, which statuses are final, what an endpoint is
  application/     the use cases, against a JobGateway port
  infrastructure/  that port over HTTP
```

To speak to an executor over something other than HTTP, implement `JobGateway`
and pass it to `waitForJob`; nothing above the port knows the difference.
