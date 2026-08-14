# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/r-hashi01/remote-claude/security/advisories/new)**.

Please do not open a public issue for anything exploitable. There is no bounty
and one maintainer, so the honest expectation is a first reply within a week and
no guaranteed timeline after that.

Include the deployment's configuration if you can — auth mode, which credential
scheme it holds, whether `ALLOW_CUSTOM_REPO` is on, and which commands the job was
allowed to run. Most of this project's behaviour depends on them.

## What this thing is, as a threat model

An agent writes and runs code inside a container, against a repository, using
credentials that belong to whoever deployed it. Three assets are worth naming:

| | |
| --- | --- |
| The Claude credential | A subscription OAuth token **or** a Claude API key — one per deployment ([ADR 0014](docs/adr/0014-two-credentials-one-at-a-time.md)). In `proxy` mode neither enters the container ([ADR 0002](docs/adr/0002-no-credentials-inside-the-container.md)). An API key is the more attractive asset of the two: it has no session to expire and spends per token |
| The GitHub App credential | Reaches exactly the repositories its installation covers, and no others ([ADR 0010](docs/adr/0010-the-credential-defines-the-repositories.md)) |
| The API bearer token | Anything holding it can spend the two above |

## In scope

- Getting a real credential out of the container, or out of stored logs,
  results, or diffs
- Reaching the API without the bearer token, or getting past it with a wrong one
- Making a job touch a repository outside the GitHub App installation
- Escaping the network allowlist
- One job reading another's workspace, logs, or results

## Not vulnerabilities

These are decisions, documented where they are made. Reporting them is welcome
as a discussion, but they will not be treated as reports.

- **The agent runs with permissions bypassed inside the container.** That is the
  point of the container. The isolation boundary is the sandbox, not the agent's
  own prompt-level guardrails
- **A prompt can make the agent write hostile code.** It runs in a throwaway
  container on a dedicated branch, and the result is a diff a person reads. The
  answer to a bad diff is not merging it
- **The deployer's own commands run with the repository checked out.** Install,
  lint, and test are yours; the executor runs what it is configured to run
- **No token configured means the API refuses everything with 503.** Fail-closed
  is intended, not an availability bug

## Operating it safely

`docs/operating.md` has the details. Two things carry most of the weight:

1. **Put the Worker behind Cloudflare Access.** The bearer token is the last line
   of defence, not the only one
2. **On a subscription, keep it to one person.** The container signs in as you,
   and Anthropic's consumer terms say you "may not make your Account available to
   anyone else". An API-key deployment is not bound by that, but nothing about it
   is safer to leave reachable: set a spend limit in the Claude Console, because
   this executor cannot enforce one

## Supported versions

The deployed `main`, and the most recent `@r-hashi01/remote-claude-client` on
npm. Older client versions are not patched; upgrade instead.

**From 0.3.3 onward** releases are published from CI through npm's trusted
publishing, so a tarball carries provenance tying it to the workflow and the
commit that built it. 0.1.0 through 0.3.2 were published by hand and carry none —
absence of provenance on those is expected and says nothing either way.
