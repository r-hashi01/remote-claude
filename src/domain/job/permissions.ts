/**
 * What a GitHub App installation is allowed to do.
 *
 * The rule is one line; it is here because getting it wrong is not visible from
 * the outside. The first version of this check asked
 * `GET /repos/{owner}/{repo}` for a `permissions.push` flag — a field GitHub
 * returns to user-to-server tokens and not to installation tokens. It was
 * therefore always false, and the check **refused a job the credential could
 * actually have delivered**. A guard that blocks correct work is worse than the
 * failure it was written to prevent, because the failure at least says what
 * happened.
 *
 * Installation permissions arrive with the token itself, which is the only
 * source that describes the credential being used.
 */

/** The permissions an installation token reports for itself. */
export interface InstallationPermissions {
  /** "read" | "write", or absent when the App does not ask for it at all. */
  contents?: string;
  pull_requests?: string;
  [permission: string]: string | undefined;
}

/** Whether a job may push a branch with this credential. */
export function canPush(permissions: InstallationPermissions | undefined): boolean {
  return permissions?.contents === 'write';
}

/** Whether the executor could open a pull request with this credential. */
export function canOpenPullRequests(permissions: InstallationPermissions | undefined): boolean {
  return permissions?.pull_requests === 'write';
}
