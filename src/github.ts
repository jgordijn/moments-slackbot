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

/** Read all entries from today's file (for context). */
export async function getTodayEntries(dateSlug?: string): Promise<string | null> {
  const slug = dateSlug || todaySlug();
  const file = await getFile(slug);
  return file?.content || null;
}
