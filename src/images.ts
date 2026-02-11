/**
 * Image processing — extracts images from Slack messages,
 * downloads them, and prepares them for GitHub upload.
 */

import { config } from "./config";

const SUPPORTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private_download: string;
}

export interface ProcessedImage {
  /** Generated filename, e.g. "2026-02-11-084037-1.png" */
  filename: string;
  /** Raw image data */
  buffer: Buffer;
  /** Markdown embed string, e.g. "![image](/images/moments/2026-02-11-084037-1.png)" */
  markdownEmbed: string;
}

/**
 * Extract image files from a Slack message.
 * Returns only files with supported image MIME types.
 */
export function extractImageFiles(message: any): SlackFile[] {
  const files = message.files;
  if (!Array.isArray(files) || files.length === 0) return [];

  return files
    .filter((f: any) => f.mimetype && SUPPORTED_MIME_TYPES.has(f.mimetype) && f.url_private_download)
    .map((f: any) => ({
      id: f.id,
      name: f.name || "image",
      mimetype: f.mimetype,
      url_private_download: f.url_private_download,
    }));
}

/**
 * Download a file from Slack using the bot token for authentication.
 *
 * Slack's url_private_download can redirect across origins, which causes
 * fetch() to strip the Authorization header on the redirect. To handle this,
 * we disable automatic redirect following and manually follow redirects while
 * preserving the auth header.
 *
 * Throws on non-200 response or if the response is not an image.
 */
export async function downloadSlackFile(file: SlackFile): Promise<Buffer> {
  // Slack file downloads require authentication. The Authorization header
  // approach doesn't always work because Slack redirects to the workspace
  // login page. Using the token as a query parameter is more reliable.
  const separator = file.url_private_download.includes("?") ? "&" : "?";
  const url = `${file.url_private_download}${separator}t=${config.slackBotToken}`;

  console.log(`[images] download: fetching ${file.url_private_download} (with token param)`);

  const response = await fetch(url);

  console.log(`[images] download: HTTP ${response.status} (content-type: ${response.headers.get("content-type") || "none"})`);

  if (!response.ok) {
    throw new Error(`Failed to download ${file.name}: HTTP ${response.status}`);
  }

  // Verify we got an actual image, not an HTML auth page
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const body = await response.text();
    console.error(`[images] download: got HTML instead of image. First 200 chars: ${body.slice(0, 200)}`);
    throw new Error(`Got HTML instead of image for ${file.name} — check that the Slack app has the files:read scope`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Generate a timestamp string (HHmmss) in Europe/Amsterdam timezone.
 */
function timestampNow(): string {
  const now = new Date();
  const parts = now.toLocaleString("en-GB", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  // "HH:MM:SS" → "HHMMSS"
  return parts.replace(/:/g, "");
}

/**
 * Process all images in a Slack message:
 * extract, download, and prepare for upload.
 *
 * Returns an empty array if no images found.
 * Individual download failures are logged and skipped.
 */
export async function processMessageImages(message: any, dateSlug: string): Promise<ProcessedImage[]> {
  const imageFiles = extractImageFiles(message);
  if (imageFiles.length === 0) return [];

  const timestamp = timestampNow();
  const results: ProcessedImage[] = [];

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const index = i + 1;
    const ext = MIME_TO_EXT[file.mimetype] || "png";
    const filename = `${dateSlug}-${timestamp}-${index}.${ext}`;

    try {
      console.log(`[images] downloading ${file.name} (${file.mimetype})...`);
      const buffer = await downloadSlackFile(file);
      console.log(`[images] downloaded ${filename} (${buffer.length} bytes)`);

      const markdownEmbed = `![image](${config.momentsImagesUrlPrefix}/${filename})`;

      results.push({ filename, buffer, markdownEmbed });
    } catch (err: any) {
      console.error(`[images] failed to download ${file.name}: ${err.message}`);
      // Skip this image, continue with others
    }
  }

  return results;
}
