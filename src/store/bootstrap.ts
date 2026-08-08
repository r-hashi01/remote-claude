import type { Config } from '../config';
import type { Project, Repository, SpindleStore } from './types';

/**
 * Bridge from the single-repository configuration this environment started
 * with to the Project model the product needs.
 *
 * Tasks require a project, so one is materialised from REPO_URL on first use.
 * This is a stepping stone, not the destination: once projects can be created
 * through the UI (P0-2), REPO_URL and this file both go away. Keeping it in
 * one place makes that deletion obvious rather than archaeological.
 */

export interface ProjectContext {
  project: Project;
  repository: Repository;
}

/** `https://github.com/owner/name.git` → `{ owner, name }`. */
export function parseGitHubUrl(repoUrl: string): { owner: string; name: string } {
  const url = new URL(repoUrl);
  const parts = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`cannot parse owner/name from repository URL: ${url.pathname}`);
  }
  return { owner: parts[0], name: parts[1] };
}

/**
 * Get — or create on first call — the project backing the configured repo.
 *
 * Concurrent callers race here. The slug is UNIQUE, so the loser's insert
 * fails and it re-reads; that is why the catch re-fetches rather than
 * rethrowing. D1 has no interactive transaction to do this more elegantly.
 */
export async function ensureDefaultProject(
  store: SpindleStore,
  config: Config
): Promise<ProjectContext> {
  const { owner, name } = parseGitHubUrl(config.repoUrl);
  const slug = `${owner}-${name}`.toLowerCase();

  let project = await store.projects.getBySlug(slug);
  if (!project) {
    try {
      project = await store.projects.create({
        name,
        slug,
        description: `Auto-created from REPO_URL (${owner}/${name})`,
      });
    } catch {
      project = await store.projects.getBySlug(slug);
      if (!project) throw new Error(`failed to create or load project ${slug}`);
    }
  }

  let repository = await store.repositories.getPrimary(project.id);
  if (!repository) {
    try {
      repository = await store.repositories.create({
        projectId: project.id,
        owner,
        name,
        defaultBranch: config.defaultBaseBranch,
        isPrimary: true,
        installationId: null,
      });
    } catch {
      repository = await store.repositories.getPrimary(project.id);
      if (!repository) throw new Error(`failed to create or load repository for ${slug}`);
    }
  }

  return { project, repository };
}
