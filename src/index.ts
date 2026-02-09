/**
 * Entry point — starts the Slack bot in socket mode.
 */

import { app } from "./bot";

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
