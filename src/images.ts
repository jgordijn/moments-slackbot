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

  // Log raw file objects for debugging
  for (const f of files) {
    console.log(`[images] raw file: id=${f.id} name=${f.name} mimetype=${f.mimetype} mode=${f.mode} url_private=${f.url_private} url_private_download=${f.url_private_download}`);
  }

  return files
    .filter((f: any) => f.mimetype && SUPPORTED_MIME_TYPES.has(f.mimetype) && (f.url_private_download || f.url_private))
    .map((f: any) => ({
      id: f.id,
      name: f.name || "image",
      mimetype: f.mimetype,
      url_private_download: f.url_private_download || f.url_private,
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
  // Try multiple download strategies — Slack's file API is inconsistent
  const strategies = [
    // Strategy 1: url_private with Authorization header
    { url: file.url_private_download.replace("/download/", "/"), method: "Bearer header (url_private)" },
    // Strategy 2: url_private_download with Authorization header
    { url: file.url_private_download, method: "Bearer header (url_private_download)" },
    // Strategy 3: url_private with token query param
    { url: `${file.url_private_download.replace("/download/", "/")}?t=${config.slackBotToken}`, method: "token param (url_private)" },
    // Strategy 4: url_private_download with token query param
    { url: `${file.url_private_download}?t=${config.slackBotToken}`, method: "token param (url_private_download)" },
  ];

  for (const strategy of strategies) {
    try {
      const headers: Record<string, string> = {};
      if (!strategy.url.includes("?t=")) {
        headers["Authorization"] = `Bearer ${config.slackBotToken}`;
      }

      console.log(`[images] download: trying ${strategy.method}`);
      const response = await fetch(strategy.url, { headers, redirect: "follow" });
      console.log(`[images] download: ${strategy.method} → HTTP ${response.status} (content-type: ${response.headers.get("content-type") || "none"})`);

      if (!response.ok) continue;

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        console.log(`[images] download: ${strategy.method} returned HTML, skipping`);
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      console.log(`[images] download: success with ${strategy.method} (${buffer.length} bytes)`);
      return buffer;
    } catch (err: any) {
      console.log(`[images] download: ${strategy.method} failed: ${err.message}`);
    }
  }

  throw new Error(`All download strategies failed for ${file.name} — check that the Slack app has the files:read scope`);
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
