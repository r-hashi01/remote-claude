import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import type { DurableObject } from 'cloudflare:workers';
import { claudeCredential } from '../../domain/agent/credential';
import { parseAllowedHosts } from '../config';
import { getInstallationToken } from '../github/app';
import type { Env } from '../env';

/**
 * Sandbox container for remote-claude.
 *
 * Network posture: deny-by-default. `enableInternet = false` drops everything
 * that is not in `allowedHosts`, and only ports 80/443 route through the
 * outbound handlers below.
 *
 * Credential posture: the handlers run in the Workers runtime, *outside* the
 * container. In the default `proxy` auth mode the container only ever holds
 * the sentinel string `proxy-injected`; the real Claude credential — a
 * subscription OAuth token or an API key, whichever this deployment holds — and
 * the GitHub App installation token are attached here, on the way out. That
 * means no credential is present on the sandbox filesystem, in the image, in a
 * process environment that Claude Code could print, or in any R2 backup.
 */
export class Sandbox extends BaseSandbox<Env> {
  interceptHttps = true;
  enableInternet = false;
  allowedHosts: string[] = parseAllowedHosts({});

  constructor(ctx: DurableObject['ctx'], env: Env) {
    super(ctx, env);
    // Subclass field initializers have already run at this point, so this
    // overrides the module default with the deployment's configured list.
    this.allowedHosts = parseAllowedHosts(env);
  }
}

/** Forward a request to `origin`, preserving method/headers/body. */
function forward(origin: string, request: Request, headers: Headers): Promise<Response> {
  const url = new URL(request.url);
  return fetch(`${origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.body,
  });
}

function configError(message: string): Response {
  return Response.json({ type: 'remote_claude_config_error', error: message }, { status: 500 });
}

Sandbox.outboundByHost = {
  /**
   * Claude credential injection.
   *
   * Whichever credential this deployment holds — a subscription OAuth token or a
   * Claude API key — is attached here, and the *other* scheme's header is
   * stripped unconditionally. That matters in both directions: a stray
   * `x-api-key` under a subscription deployment moves the bill to
   * pay-as-you-go, and a stray `Authorization` under an API-key deployment
   * routes a paying request through a subscription credential. Neither is
   * visible in the response, so neither is left to chance.
   *
   * The container never holds either credential in proxy mode; it sends the
   * sentinel and this replaces it (ADR 0002).
   */
  'api.anthropic.com': async (request: Request, env: Env) => {
    const credential = claudeCredential({
      oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
      apiKey: env.ANTHROPIC_API_KEY,
    });
    if (credential.problem) return configError(credential.problem);

    const headers = new Headers(request.headers);
    if (credential.scheme === 'subscription') {
      headers.delete('x-api-key');
      headers.set('Authorization', `Bearer ${(env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim()}`);
    } else {
      headers.delete('Authorization');
      headers.set('x-api-key', (env.ANTHROPIC_API_KEY ?? '').trim());
    }

    return forward('https://api.anthropic.com', request, headers);
  },

  /**
   * GitHub App auth injection for git-over-HTTPS.
   *
   * The token is attached as a Basic credential here rather than embedded in
   * the clone URL, so it never appears in `git remote -v`, `.git/config`, a
   * process listing, or the task logs. It is a short-lived (~1h) installation
   * access token minted from the App's private key — see github-app.ts.
   */
  'github.com': async (request: Request, env: Env) => {
    return withInstallationToken(env, (token) => {
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Basic ${btoa(`x-access-token:${token}`)}`);
      return forward('https://github.com', request, headers);
    });
  },

  'codeload.github.com': async (request: Request, env: Env) => {
    return withInstallationToken(env, (token) => {
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Basic ${btoa(`x-access-token:${token}`)}`);
      return forward('https://codeload.github.com', request, headers);
    });
  },

  'api.github.com': async (request: Request, env: Env) => {
    return withInstallationToken(env, (token) => {
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return forward('https://api.github.com', request, headers);
    });
  },
};

async function withInstallationToken(
  env: Env,
  send: (token: string) => Promise<Response>
): Promise<Response> {
  let token: string;
  try {
    token = await getInstallationToken(env);
  } catch (error) {
    return configError(error instanceof Error ? error.message : String(error));
  }
  return send(token);
}
