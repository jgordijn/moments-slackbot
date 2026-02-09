/**
 * Slack bot logic — handles messages in DMs only, from the authorized user.
 *
 * Flows:
 * 1. User sends a message → AI reviews → publish directly (minor fixes) or propose (bigger changes)
 * 2. User says "help me write about X" → AI crafts a moment → proposes it
 * 3. User says "show today" → shows today's entries
 * 4. Pending proposals are accepted/rejected via buttons
 */

import { App, BlockAction, ButtonAction } from "@slack/bolt";
import { config } from "./config";
import { reviewMoment, craftMoment } from "./ai";
import { addMoment, getTodayEntries, todaySlug } from "./github";

export const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

// In-memory store of pending proposals per user (there's only one user, but still clean)
const pendingProposals = new Map<string, string>();

/** Guard: only allow the authorized user. */
function isAuthorized(userId: string): boolean {
  return userId === config.authorizedUserId;
}

/** Send an unauthorized message. */
async function rejectUnauthorized(say: Function) {
  await say("🔒 Sorry, I'm a private bot. I only work for my owner.");
}

// ---------------------------------------------------------------------------
// Message handler (DMs only)
// ---------------------------------------------------------------------------
app.message(async ({ message, say }) => {
  // Only handle user messages (not bot messages, not edits)
  if (message.subtype || !("text" in message) || !message.text) return;

  const userId = message.user;
  if (!userId || !isAuthorized(userId)) {
    await rejectUnauthorized(say);
    return;
  }

  const text = message.text.trim();

  // --- Command: show today's entries ---
  if (/^(show\s+today|today|what.?s\s+today)/i.test(text)) {
    await handleShowToday(say);
    return;
  }

  // --- Command: help me write / craft ---
  if (/^(help\s+me\s+(write|craft|post)|make\s+(this\s+)?a?\s*(nice\s+)?post)/i.test(text)) {
    const idea = text.replace(/^(help\s+me\s+(write|craft|post)\s*(about)?|make\s+(this\s+)?a?\s*(nice\s+)?post\s*(about|of)?)\s*/i, "").trim();
    if (!idea) {
      await say("💡 Tell me what you'd like to write about! e.g.\n> help me write about discovering a cool new tool");
      return;
    }
    await handleCraft(idea, say);
    return;
  }

  // --- Command: help ---
  if (/^help$/i.test(text)) {
    await say(
      "👋 *Moments Bot* — your private microblog assistant\n\n" +
      "Just send me a thought and I'll post it to your moments page.\n\n" +
      "• *Send any text* → I'll review it and publish (or suggest edits)\n" +
      "• *help me write about <topic>* → I'll craft a nice moment for you\n" +
      "• *show today* → see what's been posted today\n" +
      "• *help* → this message"
    );
    return;
  }

  // --- Default: treat as a new moment ---
  await handleNewMoment(text, say);
});

// ---------------------------------------------------------------------------
// Button actions
// ---------------------------------------------------------------------------
app.action<BlockAction<ButtonAction>>("accept_suggestion", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  if (!isAuthorized(userId)) return;

  const proposed = pendingProposals.get(userId);
  if (!proposed) {
    await client.chat.postMessage({
      channel: body.channel?.id || userId,
      text: "⚠️ No pending proposal found. Send a new moment!",
    });
    return;
  }

  pendingProposals.delete(userId);
  await publishAndConfirm(proposed, body.channel?.id || userId, client);
});

app.action<BlockAction<ButtonAction>>("reject_suggestion", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  if (!isAuthorized(userId)) return;

  pendingProposals.delete(userId);
  await client.chat.postMessage({
    channel: body.channel?.id || userId,
    text: "👍 No worries! Send me the text you'd like to publish, or ask me to help you write it.",
  });
});

app.action<BlockAction<ButtonAction>>("publish_original", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  if (!isAuthorized(userId)) return;

  // The original text is stored in the action value
  const action = (body.actions[0] as ButtonAction);
  const originalText = action.value;

  if (!originalText) {
    await client.chat.postMessage({
      channel: body.channel?.id || userId,
      text: "⚠️ Couldn't find the original text. Please send it again.",
    });
    return;
  }

  pendingProposals.delete(userId);
  await publishAndConfirm(originalText, body.channel?.id || userId, client);
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleNewMoment(text: string, say: Function) {
  await say("🔍 Reviewing your moment...");

  try {
    const review = await reviewMoment(text);

    if (review.action === "publish") {
      // Minor fixes only — publish directly
      await publishAndNotify(review.text, say);
    } else {
      // Bigger changes suggested — ask the user
      await proposeSuggestion(text, review.text, review.explanation, say);
    }
  } catch (err: any) {
    console.error("Error reviewing moment:", err);
    await say(`❌ Something went wrong: ${err.message}`);
  }
}

async function handleCraft(idea: string, say: Function) {
  await say("✨ Crafting your moment...");

  try {
    const crafted = await craftMoment(idea);
    await proposeCrafted(crafted, say);
  } catch (err: any) {
    console.error("Error crafting moment:", err);
    await say(`❌ Something went wrong: ${err.message}`);
  }
}

async function handleShowToday(say: Function) {
  try {
    const entries = await getTodayEntries();
    if (!entries) {
      await say(`📭 No moments yet for ${todaySlug()}. Send me one!`);
    } else {
      await say(`📝 *Moments for ${todaySlug()}:*\n\n\`\`\`\n${entries}\n\`\`\``);
    }
  } catch (err: any) {
    console.error("Error fetching today:", err);
    await say(`❌ Couldn't fetch today's entries: ${err.message}`);
  }
}

async function publishAndNotify(text: string, say: Function) {
  const result = await addMoment(text);
  const verb = result.created ? "Created" : "Added to";
  await say(
    `✅ ${verb} today's moments!\n\n` +
    `> ${text.split("\n").join("\n> ")}\n\n` +
    `🔗 ${result.url}`
  );
}

async function publishAndConfirm(text: string, channel: string, client: any) {
  try {
    const result = await addMoment(text);
    const verb = result.created ? "Created" : "Added to";
    await client.chat.postMessage({
      channel,
      text:
        `✅ ${verb} today's moments!\n\n` +
        `> ${text.split("\n").join("\n> ")}\n\n` +
        `🔗 ${result.url}`,
    });
  } catch (err: any) {
    console.error("Error publishing moment:", err);
    await client.chat.postMessage({
      channel,
      text: `❌ Failed to publish: ${err.message}`,
    });
  }
}

async function proposeSuggestion(original: string, suggested: string, explanation: string, say: Function) {
  // Store the suggestion for the accept action
  // We use the authorized user ID since there's only one user
  pendingProposals.set(config.authorizedUserId, suggested);

  await say({
    text: "I have a suggestion for your moment",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "📝 *Your original:*\n>" + original.split("\n").join("\n>"),
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "✨ *Suggested version:*\n>" + suggested.split("\n").join("\n>"),
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "💬 *Why:* " + explanation,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅ Use suggestion", emoji: true },
            style: "primary",
            action_id: "accept_suggestion",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "📤 Publish original", emoji: true },
            action_id: "publish_original",
            value: original,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "❌ Discard", emoji: true },
            style: "danger",
            action_id: "reject_suggestion",
          },
        ],
      },
    ],
  });
}

async function proposeCrafted(crafted: string, say: Function) {
  pendingProposals.set(config.authorizedUserId, crafted);

  await say({
    text: "Here's a crafted moment for you",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "✨ *Here's what I came up with:*\n\n>" + crafted.split("\n").join("\n>"),
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅ Publish", emoji: true },
            style: "primary",
            action_id: "accept_suggestion",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "❌ Discard", emoji: true },
            style: "danger",
            action_id: "reject_suggestion",
          },
        ],
      },
    ],
  });
}
