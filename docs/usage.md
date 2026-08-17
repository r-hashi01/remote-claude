# Using remote-claude

The reference for running jobs. If you are setting a deployment up or keeping it
running, see [Operating it](operating.md) instead.

- [A job, end to end](#a-job-end-to-end)
- [Three ways in](#three-ways-in)
- [Job options](#job-options)
- [Reading the result](#reading-the-result)
- [Getting the change out](#getting-the-change-out)
- [Another repository](#another-repository)
- [Writing a prompt that survives one shot](#writing-a-prompt-that-survives-one-shot)
- [When something fails](#when-something-fails)
- [HTTP API](#http-api)

## A job, end to end

```text
queued → starting → running → completed
                            ↘ failed
                            ↘ cancelled
```

`queued` means the concurrency limit is full; the queue is served oldest first.
Everything after that happens inside one container, which is destroyed when the
job settles:

| Step | What it is |
| --- | --- |
| clone | Done by the Worker, because it needs a credential the container must never see |
| `verify-environment` | Refuses to run unless the container is as promised: none of the credentials belonging to the *other* auth scheme (a subscription deployment must hold no API key, and an API-key deployment must hold no subscription token), and no GitHub credential — the Worker attaches those outside the container |
| `git-branch` | `claude/<job-id>`, cut from the base branch. `main` is never touched |
| `install` | Your install command. **Runs even with `skipChecks`**. Retried while the failure looks like the network's — a reset socket here used to lose the whole run before the agent had said anything |
| `claude-code` | The agent, non-interactive, with permissions bypassed |
| `lint`, `test`, `build` | Your commands. Failures are reported, not fatal — the diff is still worth having |
| `git-commit` | Only if something changed |
| `git-push` | Only when asked, and only if something was committed |
| collect | `git status`, `git diff --stat`, and the patch |

The agent is told not to commit, push, or rewrite history: the pipeline around it
does that, so that what it changed and what was recorded cannot disagree.

## Three ways in

**The CLI**, for a person at a terminal:

```bash
remote-claude "<prompt>"              # start a job and follow it
remote-claude run "<prompt>" [opts]   # the same, explicitly
remote-claude continue <job-id> "<reply>"   # answer a finished job, same conversation
remote-claude status <job-id>
remote-claude logs <job-id> [-f]
remote-claude terminal <job-id>       # watch what the commands print, live
remote-claude diff <job-id>
remote-claude apply <job-id>          # apply the patch to the working tree
remote-claude cancel <job-id>
remote-claude list
remote-claude sandboxes               # what is allocated and not reclaimed
remote-claude health [--auth]
```

**The SDK**, for a program — see [sdk/README.md](../sdk/README.md):

```bash
npm i @r-hashi01/remote-claude-client
```

```ts
const rc = createClient({ url, token });
const job = await rc.startJob({ prompt: 'fix the flaky test' });
const finished = await rc.waitForJob(job.id, { onLog: (lines) => … });
```

`waitForJob` resolves on failure and cancellation too — those are outcomes, not
exceptions. It waits out transient failures (5xx, 429, a dropped connection),
which matters because deploying the executor restarts the object coordinating
jobs while the jobs themselves keep running.

**HTTP**, if you must — see [below](#http-api). Every call carries
`Authorization: Bearer $REMOTE_CLAUDE_TOKEN` except `/health`.

## Job options

| Option | CLI | Default | What it does |
| --- | --- | --- | --- |
| `prompt` | positional | — | Required. Up to 20,000 characters |
| `baseBranch` | `--base` | the deployment's `DEFAULT_BASE_BRANCH` | What to branch from |
| `branch` | `--branch` | `claude/<job-id>` | Work on a named branch instead |
| `repo` | `--repo` | the deployment's `REPO_URL` | [Another repository](#another-repository) |
| `commands` | `--install` `--lint` `--test` `--build` | the deployment's | [Per-job commands](#per-job-commands) |
| `model` | `--model` | the deployment's `CLAUDE_MODEL` | [Choosing a model](#choosing-a-model) |
| `skipChecks` | `--skip-checks` | `false` | Skip lint/test/build. **Not install** |
| `push` | `--push` | `false` | Push the work branch |
| `pullRequest` | `--pr` | — | Push and open a pull request |
| `keepSandbox` | `--keep` | `false` | Leave the container up for 30 minutes to look at |

### Choosing a model

```bash
remote-claude --model haiku "bump the version in package.json and the lockfile"
remote-claude --model opus "work out why the login 500s under concurrency"
```

An alias (`opus`, `sonnet`, `haiku`) or a full model id
(`claude-opus-4-5-20251101`). Leaving it out runs the deployment's `CLAUDE_MODEL`,
and a deployment that has not set one runs Claude Code's own default — which is
the right answer for most jobs and moves as models are released.

The executor keeps no list of valid models, deliberately: a list here would be
stale the week a model ships. What it checks is that the value is shaped like a
model name, so a sentence gets a `400` immediately rather than a container and
twenty seconds. Whether the name means anything is Anthropic's answer, and it
arrives as the agent step failing with a message that names the model.

Two things follow from that:

- On an API-key deployment this is the cost lever. `remote-claude status <id>`
  reports `usage` — tokens and dollars — per job, so the comparison is available
  rather than assumed.
- A follow-up turn keeps the model the previous turn ran unless it names another.
  `remote-claude continue <id> --model opus "..."` is the escalation: the same
  branch, the same conversation, a larger model reading it.

### Per-job commands

The deployment configures install/lint/test/build for the repository it is
pointed at. Any job may replace them, and a job against another repository
effectively has to:

```jsonc
{
  "prompt": "...",
  "commands": {
    "install": "npm ci --no-audit --no-fund",
    "lint": "npm run typecheck",
    "test": "npm test",
    "build": ""            // an empty string means "skip this step"
  }
}
```

Keys you leave out inherit the deployment's. An empty string is an instruction —
skip — while an absent key is not one.

This exists because `skipChecks` does not cover `install`, so a job carrying the
wrong install command fails no matter what. That was found by the first job this
executor ran against a repository other than its own.

## Reading the result

```bash
remote-claude status <job-id>
```

```text
status   completed
usage    28 in / 9719 out, 21 turns, $0.6438
branch   claude/msngvwat-27d64bed (pushed)
pr       https://github.com/owner/repo/pull/14
changed  yes (a78ec21b)
lint     ok
test     skip

  packages/spindle-core/drizzle.config.ts | 4 ++--

--- claude ---
<the agent's closing message>
```

Four surfaces, in increasing detail: `status` for the summary above, `diff` for
the patch, `logs` for everything the container printed, and `terminal` for
watching it as it happens.

**The agent's closing message is a summary, not an audit.** It is what the thing
under review said about itself. What actually changed is only in the diff, and
whether the checks passed is in the steps, which the executor ran itself.

Every line is redacted before it is stored: known secret values, plus patterns
for `sk-ant-*`, `ghp_*` / `ghs_*` / `github_pat_*`, `Authorization:` headers, and
credentials embedded in URLs. Logs are capped at 20,000 lines per job and kept
for seven days.

## Getting the change out

By default the executor commits inside the sandbox and hands back a patch:

```bash
remote-claude diff <job-id>            # read it
remote-claude apply <job-id> --check   # would it apply?
remote-claude apply <job-id>           # apply it
```

With `--push` it pushes `claude/<job-id>`. With `--pr` it pushes and opens a pull
request, which is the only route where seeing the result needs nothing installed
locally:

```jsonc
{ "pullRequest": {} }
{ "pullRequest": { "title": "P0-4: wire a Task to a sandbox run", "draft": true } }
```

Every field is optional. Omitted, the executor writes the title from the prompt's
first line and the body from the request, the diffstat, and the checks that
actually ran — deliberately not from the agent's closing message.

A pull request that cannot be opened does not fail the job: the branch is pushed,
so the work exists, and the log says to open one by hand.

Both need the deployment to allow pushing *and* the credential to permit it; see
[Operating it](operating.md#pushing-and-pull-requests). Missing either is a 400
at submission, naming which one.

## Watching a run

Two views, answering different questions. `logs` gives parsed lines — the step
markers, and which stream each line came from — and answers **where a run is up
to**. The terminal gives the bytes the commands produced, unsplit and
untruncated, and answers **what is happening**.

```bash
remote-claude terminal <job-id>              # follow it, live
remote-claude terminal <job-id> --from 4096  # resume from a byte offset
```

```ts
await rc.followOutput(job.id, {
  onChunk: (text, offset) => write(text),   // `offset` is what to resume from
  onStart: (offset, skipped) => …,          // where this stream began
});
```

Over SSE, at `GET /jobs/:id/output/stream?offset=N`, with the same bearer token
as everything else. Events are `start`, `chunk`, `idle`, `end` and `error`; `end`
carries the job's status, so a finished run and a dropped connection are
distinguishable. A reader who arrives late starts near the end and is told how
much was skipped.

Three things it deliberately is not ([ADR 0012](adr/0012-two-views-of-a-running-job.md)):

- **No input channel.** Not now and not later. What you want to change, say in
  the conversation and continue the job.
- **No ANSI.** Commands run without a TTY, so tools emit no colour and redraw
  nothing. The bytes are what they printed.
- **Not a record.** It lives as long as the container. The parsed log outlives
  the job; this does not.

The offset you are given is **what you have been shown**, not what the executor
read: a tail is withheld while more can arrive, so that a credential falling
across the end of a window is masked on the read that completes it rather than
half-sent. Resume from the offset in the last `chunk`, never from a count of
your own.

## Continuing a job

A job runs once and cannot be steered while it runs. What it can do is stop and
ask — which is the right behaviour when the answer changes what should be built —
and the answer goes back as a follow-up turn:

```bash
remote-claude continue <job-id> "use the interface stub"
```

```bash
curl -X POST .../jobs/<job-id>/continue -d '{"prompt": "use the interface stub"}'
```

```ts
const next = await rc.continueJob(job.id, { prompt: 'use the interface stub' });
```

The turn **restores that job's workspace and resumes its conversation**, and runs
on **the same branch**, so the diff keeps growing in one place and a pull request
opened for it stays the right one. Only the prompt is required; the repository,
base, branch and commands are inherited, and the job options override rather than
reset ([ADR 0011](adr/0011-continue-a-job-rather-than-steer-it.md)).

A job that was **cancelled while the agent was working** can be continued too,
and that is the most useful form of it: the reason to cancel is usually that the
run needed steering, and by then there is a conversation to steer. `cancel`
followed by `continue` is a supported move.

It is refused, rather than quietly turned into a fresh start, when:

| | |
| --- | --- |
| the job has not finished | there is nothing stored yet. A job that reports itself finished always has its workspace — that is enforced |
| the deployment kept no workspace | no bucket is bound, or it has expired — they live as long as the job record |
| the job never started a conversation | it stopped before the agent ran. The tree is untouched, so a new job loses nothing |

In practice, the executor prints two lines the job itself never sees:

```text
[system] restoring the workspace of the job this continues
[system] continuing job msongqis-a3d49fe9 on claude/msongqis-a3d49fe9
```

That confirms the workspace was restored and the run picked up the same job id
on the same branch — nothing about the conversation. Whether it actually
resumed is a different claim, and log lines cannot carry it: it only checks out
if the second turn answers what the first one asked, without being re-told.
This paragraph is that check. The job that wrote this section stopped to offer
two ways to show continuation and asked which one to write; the answer came
back as a follow-up turn that picked the question back up on its own — the
same job id as the log lines above.

## Another repository

A deployment has one configured repository and will work on others when
`ALLOW_CUSTOM_REPO` is on — which it is by default:

```jsonc
{ "prompt": "...", "repo": "https://github.com/acme/app.git", "commands": { "install": "npm ci" } }
```

What may be worked on is not a list in the configuration. It is **whatever the
deployment's GitHub App installation can reach**, and the executor asks GitHub
before accepting the job, so a repository nobody granted it fails immediately
rather than during the clone ([ADR 0010](adr/0010-the-credential-defines-the-repositories.md)).
The URL must still be `https` on `github.com` with no embedded credentials.

To narrow what a deployment can touch, remove repositories from the App
installation.

`--repo` and `--install` go together. A deployment's install command was written
for the repository it is configured with, and install runs even when checks are
skipped, so `--repo` on its own runs the wrong install against the right
repository:

```bash
remote-claude run "<prompt>" \
  --repo https://github.com/owner/name.git --base main \
  --install "npm ci --no-audit --no-fund" --lint "npm run typecheck" --test "npm test"
```

## Writing a prompt that survives one shot

A job runs once. Nobody can answer a question halfway through, and the agent
cannot change direction after it starts. Three things make the difference:

1. **What to change** — name files, or at least a layer.
2. **What "done" means** — something the agent can check inside the sandbox.
   Prefer stating it as commands: if `test` is configured, the executor runs it
   and records the result, so "the tests pass" becomes an observation rather
   than a claim.
3. **What not to touch** — the cheapest way to avoid a diff you have to unpick.

The repository's own `AGENTS.md` or `CLAUDE.md` is read by the agent, so house
rules belong there rather than in every prompt.

Work that does not survive one shot: anything needing a decision you have not
made, anything where discovering the answer changes the plan, and anything
requiring a credential the sandbox deliberately lacks — deploying, for one.

## When something fails

The executor's messages are written to say what to do about them. They are worth
passing on verbatim.

| Message | What happened | What to do |
| --- | --- | --- |
| `runner stopped responding during "<phase>"` | The process in the container died. The runner's own output follows, if it produced any | Read the output. Out of memory means a smaller job |
| `no output for N minutes during "<phase>"; presumed stuck` | Alive but producing nothing | Usually a very long step. The runner reports steps that go quiet for a minute, so real silence means it stopped |
| `job exceeded <n>ms` | Past the total budget | Split the work |
| `step "install" failed` | The install command does not fit this repository | Pass `commands.install` |
| `this executor is pinned to <A> and will not run against <B>` | `ALLOW_CUSTOM_REPO` is off **on the deployment** | Not a bug in whatever called it. Change the deployment or the target |
| `installation cannot reach <owner/name>` | The GitHub App was never given that repository | Add it: GitHub → Settings → Applications → Configure → Repository access |
| `pushing is disabled on it` | `ALLOW_PUSH` is off on the deployment | Fetch the diff, or turn it on |
| `cannot write to <owner/name>` | The App's Contents permission is read-only | Raise it, and accept the change on the installation |
| `cloning ... at branch "<x>" failed` | No such branch, or no access | Check the base branch |
| `"<x>" is not a model name` | `model` was something else — a sentence, a path | Pass an alias or a model id. Refused before anything was allocated |
| `no Claude credential is configured` / `both ... are configured` | The deployment holds neither credential, or both | Store exactly one on the Worker — see [Operating it](operating.md#1-a-claude-credential) |
| `this environment must use ... only` (in `verify-environment`) | The container held the other scheme's credential | A deployment misconfiguration, not a job. The step names which variable |

Platform hiccups are retried by the executor before the runner starts, and only
there: once the runner is up, retrying would re-run your prompt. A job that
starts, reports nothing at all and stops is also retried, because a runner that
wrote neither a status nor a line of output cannot have executed anything.

A failed job keeps everything a successful one does apart from the diff: the
steps that ran, with the command each one used and what it printed, plus the
usage and the agent's closing message. `status` shows them, and `result.steps`
carries them over the API — a failure is where that detail is worth most.

## HTTP API

Every call needs `Authorization: Bearer $REMOTE_CLAUDE_TOKEN` except `/health`.

| Method | Path | |
| --- | --- | --- |
| `POST` | `/jobs` | Start a job. Returns the record with `202` |
| `GET` | `/jobs?limit=20&summary=1` | Recent jobs. `summary=1` drops each step's captured output |
| `GET` | `/jobs/:id` | One job, including `result` and `usage` |
| `GET` | `/jobs/:id/logs?since=<seq>` | Logs. `format=text` for plain text |
| `GET` | `/jobs/:id/diff` | The patch, or `404` while there is none |
| `GET` | `/jobs/:id/output?offset=<n>` | One window of what the commands printed |
| `GET` | `/jobs/:id/output/stream?offset=<n>` | The same, as SSE, as it is produced |
| `POST` | `/jobs/:id/continue` | A follow-up turn: same branch, same workspace, same conversation |
| `POST` | `/jobs/:id/cancel` | Cancel |
| `GET` | `/sandboxes` | What this deployment allocated, and whether it got it back |
| `GET` | `/health` | Unauthenticated liveness |
| `GET` | `/health/auth` | Runs one prompt to prove Claude authentication works |

```bash
curl -X POST https://remote-claude.<subdomain>.workers.dev/jobs \
  -H "authorization: Bearer $REMOTE_CLAUDE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt": "fix the flaky test", "pullRequest": {}}'
```

The create response is the whole job record. It also carries `jobId`, which is
what this endpoint has always called the id; **new code should read `id`**, the
name every other endpoint uses. `GET /jobs` likewise returns the same array under
both `jobs` and `tasks`.

Errors are `{"error": "..."}`. A 400 means the request or the deployment's
configuration — the message says which — a 404 means this executor has no such
job, and a 401 means the token. A 500 is this executor's own fault, and the
distinction is carried by the error rather than inferred from its wording.
