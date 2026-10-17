import { createHash } from "node:crypto";

/** Normalizes a repository URL so `.git` and trailing-slash variants match. */
export function projectRepositoryIdentity(url: string) {
  return url.trim().replace(/\.git\/?$/, "").replace(/\/$/, "");
}

export function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const trimmed = repoUrl?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName =
      cleanedPath
        .split("/")
        .filter(Boolean)
        .pop()
        ?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}

/**
 * Directory name of a project repository's managed checkout under
 * `.paperclip-repositories/`. It is derived from the project workspace row,
 * so the same row always maps to the same checkout, and a checkout name maps
 * back to the row it was cloned from.
 */
export function managedProjectCheckoutName(workspace: {
  id: string; repoUrl: string; repoRef: string | null; cwd?: string | null;
}) {
  const name = (deriveRepoNameFromRepoUrl(workspace.repoUrl) ?? "repo").replace(/[^a-zA-Z0-9_-]/g, "-");
  const hash = createHash("sha256")
    .update(JSON.stringify([workspace.id, projectRepositoryIdentity(workspace.repoUrl), workspace.repoRef, workspace.cwd ?? null]))
    .digest("hex").slice(0, 12);
  return `${name}-${hash}`;
}
