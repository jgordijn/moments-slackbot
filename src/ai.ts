/**
 * AI layer — checks spelling, decides if a moment needs editing,
 * and can help craft better posts.
 */

import OpenAI from "openai";
import { config } from "./config";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.openrouterApiKey,
});

export interface ReviewResult {
  /** "publish" if good to go, "suggest" if changes were made */
  action: "publish" | "suggest";
  /** The (possibly corrected) text */
  text: string;
  /** Explanation of what changed (empty if nothing) */
  explanation: string;
}

// ---------------------------------------------------------------------------
// Intent classification — moment vs instruction
// ---------------------------------------------------------------------------

export interface ClassifyResult {
  /** "moment" = content to publish, "instruction" = request/command, "unclear" = could be either */
  intent: "moment" | "instruction" | "unclear";
  /** Brief explanation of why this classification was chosen */
  reason: string;
  /** If intent is "instruction", a helpful response to the user */
  response: string;
}

const CLASSIFY_SYSTEM_PROMPT = `You classify messages sent to a personal microblog bot called "Moments".

The bot publishes short thoughts to a website. Users send it text and it posts it.

Your job: determine if the message is:
1. **moment** — content the user wants to publish (a thought, discovery, observation, link, quote)
2. **instruction** — a command or request TO the bot (edit something, delete something, change settings, replace an image, etc.)
3. **unclear** — genuinely ambiguous, could be either

Guidelines:
- Most messages are moments. Default to "moment" when in doubt.
- Instructions typically address the bot directly: "can you...", "please change...", "replace the...", "delete...", "edit the previous...", "undo..."
- A message like "I love this new tool" is a moment. A message like "Can you fix the typo in my last post?" is an instruction.
- Questions about what the bot can do are instructions.
- If the message references a previous post and asks for changes, it's an instruction.
- Only use "unclear" when it's genuinely 50/50 — not as a safe default.

If the intent is "instruction", write a helpful response explaining what you can and can't do.
The bot CAN: publish new moments, help craft moments, show today's entries.
The bot CANNOT: edit previous posts, delete entries, replace images in existing posts, search old posts.
For things the bot can't do, suggest the user edit the file directly on GitHub.

Respond ONLY with valid JSON:
{
  "intent": "moment" | "instruction" | "unclear",
  "reason": "brief explanation",
  "response": "helpful response to user (only needed for instruction/unclear, empty string for moment)"
}`;

export async function classifyIntent(userText: string): Promise<ClassifyResult> {
  const response = await openai.chat.completions.create({
    model: config.aiModel,
    temperature: 0.1,
    max_tokens: 300,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
  });

  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) throw new Error("Empty AI response for classification");

  const content = rawContent.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  const parsed = JSON.parse(content) as ClassifyResult;

  if (!["moment", "instruction", "unclear"].includes(parsed.intent)) {
    throw new Error(`Invalid intent: ${parsed.intent}`);
  }

  return parsed;
}

const SYSTEM_PROMPT = `You are a writing assistant for a personal microblog called "Moments".
Moments are short thoughts, discoveries, or observations the author wants to share with the world.
They are casual, authentic, and personal — the voice matters.

Your job:
1. Fix obvious typos and minor spelling errors silently.
2. Validate and fix markdown formatting issues. Common problems:
   - Blockquotes (lines starting with >) MUST have a blank line after them before regular text.
     Wrong: "> quote\ntext"  Correct: "> quote\n\ntext"
   - The same applies before blockquotes: there should be a blank line before a > line.
   - Lists need blank lines before/after them to render correctly.
   - Headings need a blank line after them.
   Fix these silently (they count as minor formatting fixes, like typos).
3. If only minor spelling/formatting was fixed, return action "publish" with the corrected text.
4. If you think the text needs more significant changes (grammar restructuring, clarity, tone),
   return action "suggest" with your improved version AND an explanation of what you changed and why.
5. NEVER change the meaning, links, or personal voice.
6. Keep formatting (markdown links, quotes, etc.) intact — but DO fix structural whitespace issues.
7. Moments can contain markdown links like [text](url) — preserve them exactly.

Respond ONLY with valid JSON matching this schema:
{
  "action": "publish" | "suggest",
  "text": "the final or suggested text",
  "explanation": "what was changed (empty string if action is publish with only minor fixes)"
}`;

export async function reviewMoment(userText: string): Promise<ReviewResult> {
  const response = await openai.chat.completions.create({
    model: config.aiModel,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Review this moment for my microblog:\n\n${userText}`,
      },
    ],
  });

  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) throw new Error("Empty AI response");

  // Strip markdown code fences the model sometimes wraps around JSON
  const content = rawContent.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  const parsed = JSON.parse(content) as ReviewResult;

  // Validate structure
  if (!["publish", "suggest"].includes(parsed.action)) {
    throw new Error(`Invalid action: ${parsed.action}`);
  }

  return parsed;
}

const CRAFT_SYSTEM_PROMPT = `You are a writing assistant for a personal microblog called "Moments".
The author wants help turning a rough idea into a nice, polished moment.
Moments are short (1-4 sentences typically), casual, and personal.
They can include markdown links.
Keep the author's voice — don't make it corporate or overly formal.
Return ONLY the polished moment text, nothing else.`;

export async function craftMoment(roughIdea: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: config.aiModel,
    temperature: 0.7,
    messages: [
      { role: "system", content: CRAFT_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Help me turn this into a nice moment:\n\n${roughIdea}`,
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() || roughIdea;
}
