# Operating remote-claude

Standing a deployment up, and keeping it up. For submitting jobs to one that
already exists, see [Using it](usage.md).

- [What you need](#what-you-need)
- [First-time setup](#first-time-setup)
- [Deploying](#deploying)
- [Configuration](#configuration)
- [Pushing and pull requests](#pushing-and-pull-requests)
- [Sandbox lifecycle](#sandbox-lifecycle)
- [Security](#security)
- [Cost](#cost)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)

## What you need

| | |
| --- | --- |
| Plan | **Workers Paid** ($5/month). Containers and the Sandbox SDK are not on the free plan |
| Cloudflare | An account ID, and an API token for CI |
| Resources | One Worker, three Durable Object classes, one container, one R2 bucket for artifacts |
| Locally | Node 22+. **Docker is not needed** for day-to-day work — CI builds the image |
| Anthropic | A Claude Pro or Max subscription. **No API key**: this environment authenticates by subscription OAuth only |

`wrangler deploy` creates the Worker, the Durable Objects and the container. The
only manual pieces are the API token, the account ID, and the GitHub App.

## First-time setup

### 1. A Claude token

```bash
claude setup-token
```

Keep the value. It never goes into the repository or the image.

### 2. A GitHub App

Cloning uses a GitHub App rather than a personal access token: its tokens are
short-lived (an hour at most) and scoped to the App, so nothing borrows your own
account's reach.

1. GitHub → Settings → Developer settings → **GitHub Apps** → **New GitHub App**
   - **Webhook**: uncheck **Active**
   - **Repository permissions → Contents**: **Read-only** to start with
     (**Read and write** if jobs will push — see
     [Pushing and pull requests](#pushing-and-pull-requests))
2. **Generate a private key**, then convert it once — GitHub issues PKCS#1 and
   the Workers runtime needs PKCS#8:

   ```bash
   openssl pkcs8 -topk8 -nocrypt -in original-key.pem -out pkcs8-key.pem
   ```

3. **Install the App** on the repositories it should reach. Note three values:
   the **App ID** (General), the **Installation ID** (the number at the end of
   `https://github.com/settings/installations/<id>`), and the converted key.

   What this installation can reach is also what jobs may run against
   ([ADR 0010](adr/0010-the-credential-defines-the-repositories.md)). To narrow
   that, remove repositories here rather than adding a list to the configuration.

### 3. A token for the API

```bash
openssl rand -hex 32
```

### 4. Load the secrets

```bash
npm install

npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN     # step 1
npx wrangler secret put REMOTE_CLAUDE_TOKEN         # step 3
npx wrangler secret put GITHUB_APP_ID               # step 2
npx wrangler secret put GITHUB_APP_INSTALLATION_ID  # step 2
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < pkcs8-key.pem
```

Redirecting the key from the file avoids pasting a multi-line PEM by hand. Delete
`pkcs8-key.pem` and `original-key.pem` afterwards; `*.pem` is gitignored, but a
key that is gone cannot be committed by accident.

| Secret | Needed for |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Running the agent at all |
| `REMOTE_CLAUDE_TOKEN` | Guarding this API. **Unset means every request is refused with 503** |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` | Cloning, and pushing |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Only the workspace cache, which is [not wired](#known-limits) |

### 5. Point the CLI at it

The connection describes a deployment, not a repository, so the default place is
global:

```bash
mkdir -p ~/.config/remote-claude
cat > ~/.config/remote-claude/config.json <<'JSON'
{
  "url": "https://remote-claude.<subdomain>.workers.dev",
  "token": "<the same value as REMOTE_CLAUDE_TOKEN>"
}
JSON
chmod 600 ~/.config/remote-claude/config.json
```

Lookup order: `REMOTE_CLAUDE_URL` / `REMOTE_CLAUDE_TOKEN` in the environment,
then `.remote-claude.json` in the current directory or any parent, then the file
above. The per-directory file is for pointing one repository at a different
deployment.

### 6. Put it behind Cloudflare Access

The bearer token means it is never open, but it should not be the only thing in
front of it.

Dashboard → Zero Trust → Access → Applications → Add an application →
**Self-hosted**, with a policy allowing only your own email. For CLI use, add a
Service Auth policy and send `CF-Access-Client-Id` / `CF-Access-Client-Secret`.

## Deploying

Pushing to `main` runs `.github/workflows/deploy.yml`, which typechecks, tests,
builds the SDK, builds the container image on the runner, and deploys. Day-to-day
that is the whole procedure, and **no Docker runs on your machine**.

It needs two repository secrets:

```text
CLOUDFLARE_API_TOKEN    # Dashboard → My Profile → API Tokens → "Edit Cloudflare Workers"
CLOUDFLARE_ACCOUNT_ID   # npx wrangler whoami
```

Both must be there. A deployment with the account ID and no token fails in about
thirty seconds with wrangler refusing to run non-interactively — and since the
name still appears in the log with an empty value, it reads like something else.
Every deployment for two days failed that way, unnoticed, because the last
working version had been deployed by hand.

Deploying by hand needs Docker running locally:

```bash
npx wrangler login
npx wrangler deploy
```

**Deploying restarts the object that coordinates jobs.** Jobs themselves survive
— they run in containers and are re-adopted — but a client watching one sees a
500 in the moment. The CLI and the SDK wait that out.

## Configuration

`wrangler.jsonc`, under `vars`:

| Variable | Default | |
| --- | --- | --- |
| `REPO_URL` | — | The repository a job works on when it names none |
| `DEFAULT_BASE_BRANCH` | `main` | |
| `CLAUDE_AUTH_MODE` | `proxy` | `proxy` keeps the real token out of the container. `direct` passes it in — a fallback |
| `MAX_CONCURRENCY` | `3` | Jobs at once. Keep `max_instances` at least this high |
| `JOB_TIMEOUT_MS` | `1800000` | Whole job |
| `CLAUDE_TIMEOUT_MS` | `1500000` | The agent step alone |
| `SANDBOX_SLEEP_AFTER` | `5m` | Idle before the platform may reclaim a container |
| `ALLOW_PUSH` | `false` | Whether any job may push |
| `ALLOW_CUSTOM_REPO` | `true` | Whether a job may name another repository |
| `SANDBOX_ALLOWED_HOSTS` | see below | Everything else is blocked |
| `INSTALL_COMMAND`, `LINT_COMMAND`, `TEST_COMMAND`, `BUILD_COMMAND` | `""` | Defaults for `REPO_URL`; any job may override them |

Default allowed hosts: `github.com`, `codeload.github.com`, `api.github.com`,
`objects.githubusercontent.com`, `api.anthropic.com`, `registry.npmjs.org`.
`api.anthropic.com` is added even if you leave it out, because nothing works
without it.

Timeouts for liveness are not configurable: the heartbeat window (90s) and the
no-output window (8 minutes) describe how the runner reports, not a preference.

Because the commands belong to `REPO_URL` and any job may name another
repository, **a job against another repository should carry its own**
([per-job commands](usage.md#per-job-commands)).

## Pushing and pull requests

Three things have to line up, and each is checked when a job is submitted rather
than discovered later:

1. `ALLOW_PUSH: "true"` in `wrangler.jsonc`, deployed
2. The App's **Contents: Read and write** — and the permission change
   **accepted on the installation**. Changing it in the App's settings is not
   enough
3. `--push`, or `--pr` for a pull request as well (which needs
   **Pull requests: Read and write** too)

The executor asks GitHub what the installation may actually do rather than
trusting the switch, so a missing permission is a 400 naming it. Pushing happens
only when something was committed, and a push that fails does not fail the job —
the patch is still there.

## Continuing a job

A job that stops to ask a question is answered by continuing it, not by starting
over — see [ADR 0011](adr/0011-continue-a-job-rather-than-steer-it.md). That
needs the tree it left and the conversation that produced it, so when a job
settles its workspace is stored and the record points at it.

**Four things, and no flag.** Storing a workspace uploads it from the container
over a presigned URL, so the sandbox needs the bucket by name as well as by
binding, and credentials of its own:

| | |
| --- | --- |
| `BACKUP_BUCKET` | the binding, in `r2_buckets` |
| `BACKUP_BUCKET_NAME` | the same bucket by name, in `vars` |
| `CLOUDFLARE_ACCOUNT_ID` | a secret |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | secrets, from Dashboard → R2 → Manage API tokens |

```bash
npx wrangler r2 bucket create remote-claude-workspaces
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID       # from Dashboard → R2 → Manage API tokens
npx wrangler secret put R2_SECRET_ACCESS_KEY   # the S3 pair, not the "Token value"
```

Those two are the **S3-compatible** credentials shown once when an R2 API token is
created, with **Object Read & Write** (read is what a restore needs). The token
value on the same page is for Cloudflare's own API and is not one of these.

`wrangler secret put` reports success on empty input, and the sandbox treats an
empty value exactly like a missing one — so a secret that looks set can still be
absent as far as this feature is concerned. Piping from a file avoids it:

```bash
npx wrangler secret put R2_ACCESS_KEY_ID < key.txt && rm key.txt
```

With all of them, workspaces are kept for as long as the job record is (seven
days). With none, jobs run exactly as before and simply cannot be continued.
There is no separate on/off flag, because a flag and a binding can disagree — and
the one that used to be here did, for as long as it existed.

The container's own upload host is opened automatically: a deployment that has an
account id gets `<account>.r2.cloudflarestorage.com` added to its allowed hosts,
because a deployment that keeps workspaces has to be able to reach the bucket it
keeps them in. Enabling one feature should not require remembering to open a hole
for it somewhere else — the first upload that got that far failed with a 520 from
a host nobody had allowed.

Two of those four are read by the sandbox SDK rather than by this Worker, which
is why they can look unused when you grep for them. A sweep for dead
configuration flagged both as suspicious and left them alone; they turned out to
be exactly what this feature needs.

Getting it wrong is quiet in the wrong way: a job runs perfectly, keeps no
workspace, and the refusal arrives later when somebody tries to continue it. The
job's log now names what was missing at the moment it failed.

This deployment has one. Another would need:

```bash
npx wrangler r2 bucket create remote-claude-workspaces
# and in wrangler.jsonc, alongside ARTIFACTS:
#   { "binding": "BACKUP_BUCKET", "bucket_name": "remote-claude-workspaces" }
```

What travels is the working tree and the conversation beside it, with
`node_modules` excluded by name — a continuation reinstalls it. (Excluded by name
rather than by `.gitignore`, which the sandbox applies only when the directory is
itself inside a repository, and `/workspace` is one level above it.)

Restoring produces an overlay mount that lives as long as the container, so a
continuation restores and runs; it does not hold a workspace open between turns.
Failing to keep a workspace never fails a job that has already produced its diff.
Failing to *restore* one does fail the job that asked for it, because continuing
from a fresh clone would look like continuing and behave like starting over.

## Sandbox lifecycle

One job, one container, destroyed when the job settles — `--keep` holds it for
thirty minutes so it can be inspected, not forever. `max_instances: 3` is a hard
ceiling on cost, independent of `MAX_CONCURRENCY`.

Containers can be orphaned by an eviction, so the executor keeps a ledger of
every sandbox it allocated and sweeps for ones whose job is over, at start-up and
every minute after. `remote-claude sandboxes` shows it; anything in `outstanding`
was allocated and not confirmed reclaimed, and it consumes the concurrency limit.
That ledger exists because the platform's instance count reports provisioned
capacity rather than running containers, so no external metric can answer the
question.

## Security

| | |
| --- | --- |
| Isolation | One job per container, destroyed afterwards |
| Credentials | In `proxy` mode the real tokens never enter the container ([ADR 0002](adr/0002-no-credentials-inside-the-container.md)) |
| Secret masking | Everything is redacted before storage: known values, plus patterns. The list is checked at compile time, so adding a secret and forgetting to mask it does not build |
| API-key fallback | Refused three ways: `x-api-key` is stripped on the way out, the variables are unset for every command, and each job proves they are absent before running |
| Repository access | `https` on `github.com`, no embedded credentials, and within the App installation — confirmed with GitHub before the job starts |
| Authentication | A bearer token, compared in constant time. **No token configured means 503, never open** |
| Network | Deny by default; only the allowlist, over ports 80 and 443 |

This is a personal deployment. Do not arrange for it to serve other people's
requests on your subscription credential — that is what the Anthropic terms
forbid, and the guard for it is the token and Cloudflare Access, not the number
of repositories it can see.

## Cost

Beyond the $5/month plan:

| | | Keeping it down |
| --- | --- | --- |
| **Container time** | vCPU, memory and disk per second. **The dominant cost** | Destroyed at settle, `SANDBOX_SLEEP_AFTER`, `max_instances: 3` |
| Image storage | The built container image | Keep the Dockerfile small |
| Durable Objects | Requests and SQLite | Jobs pruned after 7 days, logs capped at 20,000 lines |
| Worker requests | Including polling | Follow polls between 0.4s and 1.5s |
| R2 | Storage and operations | Artifacts only; the cache is off |
| **Anthropic** | **Nothing.** The subscription is flat, and no API key is used | |

The first three settings to reach for: `MAX_CONCURRENCY: "1"`,
`SANDBOX_SLEEP_AFTER: "2m"`, and leaving `instance_type` alone.

## Troubleshooting

**`unauthorized`** — the CLI's token and the Worker's `REMOTE_CLAUDE_TOKEN`
disagree. Re-set with `npx wrangler secret put REMOTE_CLAUDE_TOKEN`.

**`REMOTE_CLAUDE_TOKEN is not configured` (503)** — no secret. Failing closed is
the intended behaviour.

**Deploy fails in ~30 seconds** with wrangler asking for `CLOUDFLARE_API_TOKEN` —
the repository secret is missing. Until it is set, `git push` does not deploy and
what is live is whatever was last deployed by hand. `gh secret list` shows it.

**`health --auth` fails** — the OAuth token is wrong or expired
(`claude setup-token` again), or `api.anthropic.com` is missing from
`SANDBOX_ALLOWED_HOSTS`.

**A job fails at `verify-no-api-key`** — an Anthropic API key is present inside
the container. Look for it in the Dockerfile or in `vars`.

**Cloning a private repository fails** — the App is not installed on it, or the
private key is not PKCS#8. Both say so.

**A job sits in `running`** — check `remote-claude logs -f`. The executor decides
for itself after 90 seconds without a heartbeat, or 8 minutes without output.

**The Worker's own logs** — `npx wrangler tail`.

## Known limits

- Queued jobs do not survive a Worker restart; they are not a durable queue
- Job history is kept for 7 days; logs are capped at 20,000 lines
- The agent runs non-interactively with permissions bypassed. Approval prompts
  are not available
- Following a job is polling, not long polling
- One failure mode is unexplained: a runner that starts, writes nothing and
  stops. It is retried, and a launch marker was added so the next occurrence
  distinguishes "the shell never ran" from "the runner said nothing" (RC-15)
