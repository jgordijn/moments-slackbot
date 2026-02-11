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
import { reviewMoment, craftMoment, classifyIntent, executeInstruction } from "./ai";
import { addMoment, getTodayEntries, todaySlug, uploadImage, getRecentMoments, updateMomentFile, type MomentFile } from "./github";
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

// Store for pending edits awaiting user approval
interface PendingEdit {
  dateSlug: string;
  updatedContent: string;
  sha: string;
  explanation: string;
}
const pendingEdits = new Map<string, PendingEdit>();

// Conversation context for instruction follow-ups (clarification loops)
interface ConversationContext {
  originalInstruction: string;
  originalMessage: any;
  clarificationQuestion: string;
  newImagePath?: string;
  timestamp: number;
}
const conversationContext = new Map<string, ConversationContext>();

/** Check if a message is likely a follow-up to a clarification question */
function hasActiveConversation(userId: string): boolean {
  const ctx = conversationContext.get(userId);
  if (!ctx) return false;
  // Expire after 5 minutes
  if (Date.now() - ctx.timestamp > 5 * 60 * 1000) {
    conversationContext.delete(userId);
    return false;
  }
  return true;
}

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

  // --- Check for active conversation (follow-up to clarification) ---
  if (text && hasActiveConversation(userId)) {
    await handleFollowUp(userId, convertSlackEmoji(text), message, say);
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

  const pending = pendingUnclear.get(userId);
  pendingUnclear.delete(userId);

  if (!pending) {
    await client.chat.postMessage({
      channel: body.channel?.id || userId,
      text: "⚠️ Couldn't find the original message. Please send it again.",
    });
    return;
  }

  const sayViaClient = async (msg: any) => {
    const channel = body.channel?.id || userId;
    if (typeof msg === "string") {
      await client.chat.postMessage({ channel, text: msg });
    } else {
      await client.chat.postMessage({ channel, ...msg });
    }
  };

  await handleInstruction(pending.text, pending.message, sayViaClient);
});

app.action<BlockAction<ButtonAction>>("approve_edit", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  if (!isAuthorized(userId)) return;

  const edit = pendingEdits.get(userId);
  if (!edit) {
    await client.chat.postMessage({
      channel: body.channel?.id || userId,
      text: "⚠️ No pending edit found. Send a new instruction!",
    });
    return;
  }

  pendingEdits.delete(userId);

  try {
    console.log(`[github] applying edit to ${edit.dateSlug}...`);
    const start = Date.now();
    const url = await updateMomentFile(
      edit.dateSlug,
      edit.updatedContent,
      edit.sha,
      `Edit moment for ${edit.dateSlug}`,
    );
    console.log(`[github] edit applied in ${Date.now() - start}ms`);

    await client.chat.postMessage({
      channel: body.channel?.id || userId,
      text: `✅ Edit applied to ${edit.dateSlug}!\n\n${edit.explanation}\n\n🔗 ${url}`,
    });
  } catch (err: any) {
    console.error("Error applying edit:", err);
    await client.chat.postMessage({
      channel: body.channel?.id || userId,
      text: `❌ Failed to apply edit: ${err.message}`,
    });
  }
});

app.action<BlockAction<ButtonAction>>("reject_edit", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  if (!isAuthorized(userId)) return;

  pendingEdits.delete(userId);
  await client.chat.postMessage({
    channel: body.channel?.id || userId,
    text: "👍 Edit discarded. Let me know if you'd like to try something else.",
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
      await handleInstruction(text, message, say);
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

/** Handle an instruction to edit existing moments. */
async function handleInstruction(text: string, message: any, say: Function) {
  await say("🔧 Working on your request...");

  try {
    // If the message has images, upload them first (for image replacement)
    const hasImages = "files" in message && extractImageFiles(message).length > 0;
    let newImagePath: string | undefined;

    if (hasImages) {
      console.log(`[images] instruction includes image(s), uploading...`);
      const embeds = await processAndUploadImages(message);
      if (embeds.length > 0) {
        // Extract the path from the markdown embed: ![image](/images/moments/...) → /images/moments/...
        const match = embeds[0].match(/\!\[.*?\]\((.*?)\)/);
        newImagePath = match ? match[1] : undefined;
        console.log(`[images] new image path for instruction: ${newImagePath}`);
      } else {
        // Image upload failed — tell the user directly
        await say("⚠️ I couldn't process the image you attached. Please try sending your request again with the image.");
        return;
      }
    }

    // Fetch recent moments for context
    console.log(`[github] fetching recent moments...`);
    const recentMoments = await getRecentMoments(5);

    if (recentMoments.length === 0) {
      await say("📭 No recent moments found to edit. Send me a new moment instead!");
      return;
    }

    console.log(`[github] found ${recentMoments.length} recent file(s): ${recentMoments.map(m => m.dateSlug).join(", ")}`);

    // Ask AI to execute the instruction
    console.log(`[ai] executing instruction...`);
    const start = Date.now();
    const result = await executeInstruction(
      text,
      recentMoments.map(m => ({ dateSlug: m.dateSlug, content: m.content })),
      newImagePath,
    );
    console.log(`[ai] instruction done in ${Date.now() - start}ms — action=${result.action}`);

    if (result.action === "unsupported") {
      await say(`😔 ${result.unsupportedReason}`);
      return;
    }

    if (result.action === "unclear") {
      // Store conversation context so the user's reply is understood as a follow-up
      conversationContext.set(config.authorizedUserId, {
        originalInstruction: text,
        originalMessage: message,
        clarificationQuestion: result.clarification,
        newImagePath,
        timestamp: Date.now(),
      });
      await say(`🤔 ${result.clarification}`);
      return;
    }

    // action === "edit" — propose the change
    const targetFile = recentMoments.find(m => m.dateSlug === result.dateSlug);
    if (!targetFile) {
      await say(`⚠️ Couldn't find the moment file for ${result.dateSlug}. Something went wrong.`);
      return;
    }

    // Store the pending edit
    pendingEdits.set(config.authorizedUserId, {
      dateSlug: result.dateSlug,
      updatedContent: result.updatedContent,
      sha: targetFile.sha,
      explanation: result.explanation,
    });

    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✏️ *Proposed edit to ${result.dateSlug}:*\n\n${result.explanation}`,
        },
      },
    ];

    // Show a warning if editing old content
    if (result.warning) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `⚠️ ${result.warning}`,
        },
      });
    }

    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Apply edit", emoji: true },
          style: "primary",
          action_id: "approve_edit",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Discard", emoji: true },
          style: "danger",
          action_id: "reject_edit",
        },
      ],
    });

    await say({
      text: `Proposed edit to ${result.dateSlug}`,
      blocks,
    });
  } catch (err: any) {
    console.error("Error handling instruction:", err);
    await say(`❌ Something went wrong: ${err.message}`);
  }
}

/** Handle a follow-up message in an active clarification conversation. */
async function handleFollowUp(userId: string, reply: string, message: any, say: Function) {
  const ctx = conversationContext.get(userId)!;
  conversationContext.delete(userId);

  console.log(`[conversation] follow-up to: "${ctx.originalInstruction.slice(0, 50)}..." reply: "${reply.slice(0, 50)}..."`);

  await say("🔧 Working on your request...");

  try {
    // Check if the follow-up message has new images
    const hasImages = "files" in message && extractImageFiles(message).length > 0;
    let newImagePath = ctx.newImagePath;

    if (hasImages && !newImagePath) {
      console.log(`[images] follow-up includes image(s), uploading...`);
      const embeds = await processAndUploadImages(message);
      if (embeds.length > 0) {
        const match = embeds[0].match(/\!\[.*?\]\((.*?)\)/);
        newImagePath = match ? match[1] : undefined;
      }
    }

    // Fetch recent moments
    const recentMoments = await getRecentMoments(5);
    if (recentMoments.length === 0) {
      await say("📭 No recent moments found to edit.");
      return;
    }

    // Build a combined instruction with context
    const combinedInstruction =
      `Original request: ${ctx.originalInstruction}\n` +
      `Bot asked: ${ctx.clarificationQuestion}\n` +
      `User replied: ${reply}`;

    console.log(`[ai] executing instruction with context...`);
    const start = Date.now();
    const result = await executeInstruction(
      combinedInstruction,
      recentMoments.map(m => ({ dateSlug: m.dateSlug, content: m.content })),
      newImagePath,
    );
    console.log(`[ai] instruction done in ${Date.now() - start}ms — action=${result.action}`);

    if (result.action === "unsupported") {
      await say(`😔 ${result.unsupportedReason}`);
      return;
    }

    if (result.action === "unclear") {
      // Still unclear — store context again for another round
      conversationContext.set(userId, {
        originalInstruction: ctx.originalInstruction,
        originalMessage: ctx.originalMessage,
        clarificationQuestion: result.clarification,
        newImagePath,
        timestamp: Date.now(),
      });
      await say(`🤔 ${result.clarification}`);
      return;
    }

    // action === "edit" — propose the change
    const targetFile = recentMoments.find(m => m.dateSlug === result.dateSlug);
    if (!targetFile) {
      await say(`⚠️ Couldn't find the moment file for ${result.dateSlug}.`);
      return;
    }

    pendingEdits.set(userId, {
      dateSlug: result.dateSlug,
      updatedContent: result.updatedContent,
      sha: targetFile.sha,
      explanation: result.explanation,
    });

    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✏️ *Proposed edit to ${result.dateSlug}:*\n\n${result.explanation}`,
        },
      },
    ];

    if (result.warning) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `⚠️ ${result.warning}` },
      });
    }

    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Apply edit", emoji: true },
          style: "primary",
          action_id: "approve_edit",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Discard", emoji: true },
          style: "danger",
          action_id: "reject_edit",
        },
      ],
    });

    await say({ text: `Proposed edit to ${result.dateSlug}`, blocks });
  } catch (err: any) {
    console.error("Error handling follow-up:", err);
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
