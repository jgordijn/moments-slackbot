/**
 * Entry point — starts the Slack bot in socket mode.
 */

import { app } from "./bot";

// ---------------------------------------------------------------------------
// Add timestamps to all log output
// ---------------------------------------------------------------------------
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

function timestamp(): string {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

console.log = (...args: any[]) => origLog(`[${timestamp()}]`, ...args);
console.error = (...args: any[]) => origError(`[${timestamp()}]`, ...args);
console.warn = (...args: any[]) => origWarn(`[${timestamp()}]`, ...args);

async function main() {
  await app.start();
  console.log("⚡ Moments Bot is running!");
  console.log(`   Timezone: Europe/Amsterdam`);
  console.log(`   Mode: Socket Mode (private, DM only)`);
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
