# Sandbox image for remote-claude.
#
# IMPORTANT: no credential is ever baked into this image. The Anthropic OAuth
# token and the GitHub token are injected at request time by the Worker's
# outbound handlers (see src/sandbox.ts), so nothing sensitive reaches the
# container filesystem or the image layers.
FROM docker.io/cloudflare/sandbox:0.12.4

# --- Claude Code (official Anthropic CLI) --------------------------------
RUN npm install -g @anthropic-ai/claude-code

# --- Toolchain needed to prepare/build/test the target repository --------
# The base image already ships Python 3.11, Node.js 20, git, curl and bash.
# Add anything this repository needs on top of that here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        jq \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# If this repository adopts a package manager other than npm, add it here,
# e.g.  RUN npm install -g pnpm@10
# (corepack is not present in the base image, so `corepack enable` will fail.)

# --- Claude Code runtime behaviour ---------------------------------------
# Outbound network is locked down to an allowlist, so telemetry/auto-update
# endpoints are unreachable. Disable them explicitly to avoid slow retries
# and noisy stderr in the task logs.
ENV DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_BUG_COMMAND=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    IS_SANDBOX=1

# Long-running builds/tests: raise the per-command ceiling of the bridge.
# Per-task timeouts are still enforced by the Worker.
ENV COMMAND_TIMEOUT_MS=1800000

EXPOSE 3000
