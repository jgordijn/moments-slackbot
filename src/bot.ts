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
import { reviewMoment, craftMoment, classifyIntent } from "./ai";
import { addMoment, getTodayEntries, todaySlug, uploadImage } from "./github";
import { convertSlackEmoji } from "./slack-emoji";
import { extractImageFiles, processMessageImages, type ProcessedImage } from "./images";

export const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

// In-memory store of pending proposals per user (there's only one user, but still clean)
interface PendingProposal {
  text: string;
  /** Markdown embed strings for uploaded images (already on GitHub) */
  imageEmbeds: string[];
}
const pendingProposals = new Map<string, PendingProposal>();

// Store for messages where intent was unclear — needed when user clicks "Publish as moment"
interface PendingUnclear {
  text: string;
  message: any;
}
const pendingUnclear = new Map<string, PendingUnclear>();

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
  // Only handle user messages (not bot messages, not edits).
  // Allow "file_share" subtype — these are messages with image attachments
  // that still contain text (e.g. "Image from iOS").
  if (message.subtype && message.subtype !== "file_share") return;

  const hasText = "text" in message && !!message.text;
  const hasImages = "files" in message && extractImageFiles(message).length > 0;

  // Need at least text or images to proceed
  if (!hasText && !hasImages) return;

  const userId = (message as any).user;
  const textPreview = hasText ? (message as any).text.slice(0, 50) : "(no text)";
  console.log(`[message] from=${userId} text="${textPreview}..." images=${hasImages}`);

  if (!userId || !isAuthorized(userId)) {
    console.log(`[auth] rejected user=${userId}`);
    await rejectUnauthorized(say);
    return;
  }

  const text = hasText ? (message as any).text.trim() : "";

  // --- Command: show today's entries (text-only commands) ---
  if (text && /^(show\s+today|today|what.?s\s+today)/i.test(text)) {
    await handleShowToday(say);
    return;
  }

  // --- Command: help me write / craft ---
  if (text && /^(help\s+me\s+(write|craft|post)|make\s+(this\s+)?a?\s*(nice\s+)?post)/i.test(text)) {
    const idea = text.replace(/^(help\s+me\s+(write|craft|post)\s*(about)?|make\s+(this\s+)?a?\s*(nice\s+)?post\s*(about|of)?)\s*/i, "").trim();
    if (!idea) {
      await say("💡 Tell me what you'd like to write about! e.g.\n> help me write about discovering a cool new tool");
      return;
    }
    await handleCraft(convertSlackEmoji(idea), say);
    return;
  }

  // --- Command: help ---
  if (text && /^help$/i.test(text)) {
    await say(
      "👋 *Moments Bot* — your private microblog assistant\n\n" +
      "Just send me a thought and I'll post it to your moments page.\n\n" +
      "• *Send any text* → I'll review it and publish (or suggest edits)\n" +
      "• *Send an image* (with or without text) → I'll include it in your moment\n" +
      "• *help me write about <topic>* → I'll craft a nice moment for you\n" +
      "• *show today* → see what's been posted today\n" +
      "• *help* → this message"
    );
    return;
  }

  // --- Default: treat as a new moment (with optional images) ---
  await handleNewMoment(text ? convertSlackEmoji(text) : "", message, say);
});

// ---------------------------------------------------------------------------
// Button actions
// ---------------------------------------------------------------------------
app.action<BlockAction<ButtonAction>>("accept_suggestion", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  if (!isAuthorized(userId)) return;

  const proposal = pendingProposals.get(userId);
  if (!proposal) {
    await client.chat.postMessage({
      channel: body.channel?.id || userId,
      text: "⚠️ No pending proposal found. Send a new moment!",
    });
    return;
  }

  pendingProposals.delete(userId);
  const fullText = combineTextAndImages(proposal.text, proposal.imageEmbeds);
  await publishAndConfirm(fullText, body.channel?.id || userId, client);
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

app.action<BlockAction<ButtonAction>>("treat_as_moment", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  if (!isAuthorized(userId)) return;

  const pending = pendingUnclear.get(userId);
  if (!pending) {
    await client.chat.postMessage({
      channel: body.channel?.id || userId,
      text: "⚠️ Couldn't find the original message. Please send it again.",
    });
    return;
  }

  pendingUnclear.delete(userId);
  const hasImages = "files" in pending.message && extractImageFiles(pending.message).length > 0;

  // Use a wrapper that posts to the channel via client (since we don't have `say`)
  const sayViaClient = async (msg: any) => {
    const channel = body.channel?.id || userId;
    if (typeof msg === "string") {
      await client.chat.postMessage({ channel, text: msg });
    } else {
      await client.chat.postMessage({ channel, ...msg });
    }
  };

  await processAsMoment(pending.text, pending.message, hasImages, sayViaClient);
});

app.action<BlockAction<ButtonAction>>("treat_as_instruction", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  if (!isAuthorized(userId)) return;

  pendingUnclear.delete(userId);
  await client.chat.postMessage({
    channel: body.channel?.id || userId,
    text: "💬 Got it! I can't do that directly, but here's what I can help with:\n\n" +
      "• *Send any text* → I'll review and publish it as a moment\n" +
      "• *help me write about <topic>* → I'll craft a moment for you\n" +
      "• *show today* → see today's entries\n\n" +
      "To edit or delete existing moments, you'll need to edit the file directly on GitHub.",
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

  // Get image embeds from the pending proposal (images are already uploaded)
  const proposal = pendingProposals.get(userId);
  const imageEmbeds = proposal?.imageEmbeds || [];

  pendingProposals.delete(userId);
  const fullText = combineTextAndImages(convertSlackEmoji(originalText), imageEmbeds);
  await publishAndConfirm(fullText, body.channel?.id || userId, client);
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleNewMoment(text: string, message: any, say: Function) {
  const hasImages = "files" in message && extractImageFiles(message).length > 0;
  const hasText = text.length > 0;

  // Image-only messages skip classification and go straight to publish
  if (!hasText && hasImages) {
    await say("🔍 Processing your image(s)...");
    try {
      const imageEmbeds = await processAndUploadImages(message);
      if (imageEmbeds.length === 0) {
        await say("❌ Couldn't process the image(s). Please try again.");
        return;
      }
      await publishAndNotify(imageEmbeds.join("\n\n"), say);
    } catch (err: any) {
      console.error("Error processing images:", err);
      await say(`❌ Something went wrong: ${err.message}`);
    }
    return;
  }

  // Classify intent: is this a moment to publish or an instruction?
  try {
    console.log(`[ai] classifying intent...`);
    const start = Date.now();
    const classification = await classifyIntent(text);
    console.log(`[ai] classified in ${Date.now() - start}ms — intent=${classification.intent}`);

    if (classification.intent === "instruction") {
      await say(`💬 ${classification.response}`);
      return;
    }

    if (classification.intent === "unclear") {
      // Store the message so we can process it if the user clicks "Publish as moment"
      pendingUnclear.set(config.authorizedUserId, { text, message });
      await say({
        text: "I'm not sure if this is a moment to publish or an instruction for me",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "🤔 *Not sure what you'd like me to do:*\n\n" +
                `> ${text.split("\n").join("\n> ")}\n\n` +
                "Is this a moment to publish, or an instruction for me?",
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "📝 Publish as moment", emoji: true },
                style: "primary",
                action_id: "treat_as_moment",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "💬 It's an instruction", emoji: true },
                action_id: "treat_as_instruction",
              },
            ],
          },
        ],
      });
      return;
    }

    // Intent is "moment" — proceed with the normal flow
  } catch (err: any) {
    // If classification fails, default to treating it as a moment
    console.error(`[ai] classification failed, defaulting to moment: ${err.message}`);
  }

  // Process as a moment
  await processAsMoment(text, message, hasImages, say);
}

/** Process text (and optional images) as a moment — review with AI and publish. */
async function processAsMoment(text: string, message: any, hasImages: boolean, say: Function) {
  const hasText = text.length > 0;

  if (hasImages && hasText) {
    await say("🔍 Reviewing your moment and processing image(s)...");
  } else if (hasImages) {
    await say("🔍 Processing your image(s)...");
  } else {
    await say("🔍 Reviewing your moment...");
  }

  try {
    // Process images and AI review in parallel
    const imagePromise = hasImages
      ? processAndUploadImages(message)
      : Promise.resolve([] as string[]);

    const reviewPromise = hasText
      ? (async () => {
          console.log(`[ai] reviewing moment...`);
          const start = Date.now();
          const review = await reviewMoment(text);
          console.log(`[ai] review done in ${Date.now() - start}ms — action=${review.action}`);
          return review;
        })()
      : Promise.resolve(null);

    const [imageEmbeds, review] = await Promise.all([imagePromise, reviewPromise]);

    // Check if all images failed
    if (hasImages && imageEmbeds.length === 0) {
      if (hasText) {
        console.warn(`[images] all images failed, publishing text only`);
        if (review && review.action === "publish") {
          await publishAndNotify(review.text, say);
          await say("⚠️ Couldn't include the image(s), but your text was published.");
        } else if (review) {
          await proposeSuggestion(text, review.text, review.explanation, [], say);
          await say("⚠️ Couldn't process the image(s). They won't be included.");
        }
      } else {
        await say("❌ Couldn't process the image(s). Please try again.");
      }
      return;
    }

    // Image-only moment (no text, no AI review)
    if (!hasText) {
      const fullText = imageEmbeds.join("\n\n");
      await publishAndNotify(fullText, say);
      return;
    }

    // Text + optional images
    if (review!.action === "publish") {
      const fullText = combineTextAndImages(review!.text, imageEmbeds);
      await publishAndNotify(fullText, say);
    } else {
      await proposeSuggestion(text, review!.text, review!.explanation, imageEmbeds, say);
    }
  } catch (err: any) {
    console.error("Error processing moment:", err);
    await say(`❌ Something went wrong: ${err.message}`);
  }
}

/** Process images from a message: download from Slack, upload to GitHub. Returns markdown embed strings. */
async function processAndUploadImages(message: any): Promise<string[]> {
  const slug = todaySlug();
  const images = await processMessageImages(message, slug);
  console.log(`[images] found ${images.length} image(s)`);

  const embeds: string[] = [];
  for (const img of images) {
    try {
      console.log(`[images] uploading ${img.filename}...`);
      const start = Date.now();
      await uploadImage(img.buffer, img.filename);
      console.log(`[images] uploaded ${img.filename} in ${Date.now() - start}ms`);
      embeds.push(img.markdownEmbed);
    } catch (err: any) {
      console.error(`[images] failed to upload ${img.filename}: ${err.message}`);
    }
  }
  return embeds;
}

/** Combine text and image markdown embeds into a single moment entry. */
function combineTextAndImages(text: string, imageEmbeds: string[]): string {
  if (imageEmbeds.length === 0) return text;
  if (!text) return imageEmbeds.join("\n\n");
  return text + "\n\n" + imageEmbeds.join("\n\n");
}

async function handleCraft(idea: string, say: Function) {
  await say("✨ Crafting your moment...");

  try {
    console.log(`[ai] crafting moment...`);
    const start = Date.now();
    const crafted = await craftMoment(idea);
    console.log(`[ai] craft done in ${Date.now() - start}ms`);
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
  console.log(`[github] publishing moment...`);
  const start = Date.now();
  const result = await addMoment(text);
  console.log(`[github] done in ${Date.now() - start}ms — created=${result.created}`);
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

async function proposeSuggestion(original: string, suggested: string, explanation: string, imageEmbeds: string[], say: Function) {
  // Store the suggestion and image embeds for the accept/publish-original actions
  // We use the authorized user ID since there's only one user
  pendingProposals.set(config.authorizedUserId, { text: suggested, imageEmbeds });

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
  pendingProposals.set(config.authorizedUserId, { text: crafted, imageEmbeds: [] });

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
