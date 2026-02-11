/**
 * GitHub integration — reads/creates/updates moment files
 * in the configured GitHub repository.
 */

import { Octokit } from "@octokit/rest";
import { config } from "./config";

const octokit = new Octokit({ auth: config.githubToken });

const { githubOwner: owner, githubRepo: repo, momentsPath } = config;

/** Today's date as YYYY-MM-DD in the local timezone (Europe/Amsterdam). */
export function todaySlug(): string {
  return new Date()
    .toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" })
    // en-CA gives YYYY-MM-DD
    .slice(0, 10);
}

/** Full path inside the repo for today's moment file. */
function filePath(dateSlug: string): string {
  return `${momentsPath}/${dateSlug}.md`;
}

interface FileInfo {
  content: string;
  sha: string;
}

/** Try to fetch an existing file. Returns null if 404. */
async function getFile(dateSlug: string): Promise<FileInfo | null> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: filePath(dateSlug),
      ref: "main",
    });

    if ("content" in data && typeof data.content === "string") {
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      return { content, sha: (data as any).sha };
    }
    return null;
  } catch (err: any) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Append a moment to today's file.
 * - If the file doesn't exist, create it with the YAML frontmatter.
 * - If it exists, append a `---` separator and the new entry.
 */
export async function addMoment(text: string, dateSlug?: string): Promise<{ created: boolean; url: string }> {
  const slug = dateSlug || todaySlug();
  const path = filePath(slug);
  const existing = await getFile(slug);

  let newContent: string;
  let message: string;

  if (existing) {
    // Append to existing file
    newContent = existing.content.trimEnd() + "\n\n---\n\n" + text.trim() + "\n";
    message = `Add moment for ${slug}`;
  } else {
    // Create new file with frontmatter
    newContent = `---\ndate: "${slug}"\n---\n\n${text.trim()}\n`;
    message = `Create moments for ${slug}`;
  }

  const params: any = {
    owner,
    repo,
    path,
    message,
    content: Buffer.from(newContent, "utf-8").toString("base64"),
    branch: "main",
  };

  if (existing) {
    params.sha = existing.sha;
  }

  await octokit.repos.createOrUpdateFileContents(params);

  const url = `https://github.com/${owner}/${repo}/blob/main/${path}`;
  return { created: !existing, url };
}

/**
 * Upload an image to the repository's images directory.
 * Returns the markdown-ready URL path (e.g., "/images/moments/2026-02-11-084037-1.png").
 */
export async function uploadImage(imageBuffer: Buffer, filename: string): Promise<string> {
  const path = `${config.momentsImagesPath}/${filename}`;

  // Check if the file already exists (to get SHA for update)
  let sha: string | undefined;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref: "main" });
    if ("sha" in data) {
      sha = (data as any).sha;
    }
  } catch (err: any) {
    if (err.status !== 404) throw err;
    // 404 = file doesn't exist yet, which is expected
  }

  const params: any = {
    owner,
    repo,
    path,
    message: `Add moment image ${filename}`,
    content: imageBuffer.toString("base64"),
    branch: "main",
  };

  if (sha) {
    params.sha = sha;
  }

  await octokit.repos.createOrUpdateFileContents(params);

  return `${config.momentsImagesUrlPrefix}/${filename}`;
}

/** Read all entries from today's file (for context). */
export async function getTodayEntries(dateSlug?: string): Promise<string | null> {
  const slug = dateSlug || todaySlug();
  const file = await getFile(slug);
  return file?.content || null;
}

/** Date slug for N days ago in Europe/Amsterdam timezone. */
function dateSlugDaysAgo(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" }).slice(0, 10);
}

export interface MomentFile {
  dateSlug: string;
  content: string;
  sha: string;
}

/**
 * Read recent moment files (today + up to `days` days back).
 * Returns files that exist, most recent first.
 */
export async function getRecentMoments(days: number = 3): Promise<MomentFile[]> {
  const results: MomentFile[] = [];

  for (let i = 0; i <= days; i++) {
    const slug = dateSlugDaysAgo(i);
    const file = await getFile(slug);
    if (file) {
      results.push({ dateSlug: slug, content: file.content, sha: file.sha });
    }
  }

  return results;
}

/**
 * Update an existing moment file with new content.
 * Requires the SHA of the current version to prevent conflicts.
 */
export async function updateMomentFile(
  dateSlug: string,
  newContent: string,
  sha: string,
  commitMessage: string,
): Promise<string> {
  const path = filePath(dateSlug);

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message: commitMessage,
    content: Buffer.from(newContent, "utf-8").toString("base64"),
    sha,
    branch: "main",
  });

  return `https://github.com/${owner}/${repo}/blob/main/${path}`;
}
