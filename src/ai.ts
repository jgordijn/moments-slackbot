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

function parseJsonResponse<T>(rawContent: string, context: string): T {
  const trimmed = rawContent.trim();
  const candidates: string[] = [];

  const pushCandidate = (value?: string) => {
    if (!value) return;
    const candidate = value.trim();
    if (!candidate) return;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };

  // Try the raw response first.
  pushCandidate(trimmed);

  // Common case: single fenced JSON block.
  pushCandidate(trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));

  // Sometimes the model wraps JSON in additional text/fences — extract all fenced blocks.
  const fencedBlocks = trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fencedBlocks) {
    pushCandidate(match[1]);
  }

  // Last resort: grab everything between the first "{" and last "}".
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    pushCandidate(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next candidate
    }
  }

  throw new Error(
    `Invalid JSON in AI response for ${context}. Raw response: ${trimmed.slice(0, 300)}${trimmed.length > 300 ? "..." : ""}`,
  );
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
The bot can also edit existing moments: fix text, replace images, add sentences, etc.

Your job: determine if the message is:
1. **moment** — content the user wants to publish (a thought, discovery, observation, link, quote)
2. **instruction** — a command or request TO the bot (edit something, fix a typo, replace an image, add a sentence, delete an entry, etc.)
3. **unclear** — genuinely ambiguous, could be either

Guidelines:
- Most messages are moments. Default to "moment" when in doubt.
- Instructions typically address the bot directly: "can you...", "please change...", "replace the...", "delete...", "edit the previous...", "fix the typo...", "add a link to...", "undo..."
- A message like "I love this new tool" is a moment. A message like "Can you fix the typo in my last post?" is an instruction.
- Questions about what the bot can do are instructions.
- If the message references a previous post and asks for changes, it's an instruction.
- Only use "unclear" when it's genuinely 50/50 — not as a safe default.
- If conversation history is provided, use it for context. Short replies like "2", "the second one", "yes", "that one" are follow-ups to the previous bot question and should be classified as "instruction".

For "instruction" intent, the response field can be empty — the bot will handle execution.

Respond ONLY with valid JSON:
{
  "intent": "moment" | "instruction" | "unclear",
  "reason": "brief explanation",
  "response": ""
}`;

export async function classifyIntent(userText: string, conversationHistory?: string): Promise<ClassifyResult> {
  let userMessage = userText;
  if (conversationHistory) {
    userMessage = `Recent conversation:\n${conversationHistory}\n\nClassify the LATEST user message above.`;
  }

  const response = await openai.chat.completions.create({
    model: config.aiModel,
    temperature: 0.1,
    max_tokens: 300,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });

  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) throw new Error("Empty AI response for classification");

  const parsed = parseJsonResponse<ClassifyResult>(rawContent, "classification");

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

  const parsed = parseJsonResponse<ReviewResult>(rawContent, "moment review");

  // Validate structure
  if (!["publish", "suggest"].includes(parsed.action)) {
    throw new Error(`Invalid action: ${parsed.action}`);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Instruction execution — edit existing moments
// ---------------------------------------------------------------------------

export interface InstructionResult {
  /** "edit" = a specific edit to a moment, "unclear" = need clarification, "unsupported" = can't do this */
  action: "edit" | "unclear" | "unsupported";
  /** The date slug of the file being edited (e.g., "2026-02-11") */
  dateSlug: string;
  /** The full updated file content (complete file, not just the changed entry) */
  updatedContent: string;
  /** Human-readable summary of what was changed */
  explanation: string;
  /** If action is "unclear", a question to ask the user for clarification */
  clarification: string;
  /** If action is "unsupported", explain why */
  unsupportedReason: string;
  /** Warning if the edit targets a file more than 2 days old */
  warning: string;
}

const INSTRUCTION_SYSTEM_PROMPT = `You are a writing assistant for a personal microblog called "Moments".
The user wants to edit an existing moment. You will receive their instruction and the recent moment files.

Moment files are markdown files with YAML frontmatter, one file per day. Entries within a day are separated by "---" (horizontal rule).

Your job:
1. Identify which moment file and which entry the user is referring to.
2. Apply the requested change (fix text, replace an image reference, add a sentence, etc.).
3. Return the COMPLETE updated file content (not just the changed part).

Guidelines:
- Preserve the YAML frontmatter exactly.
- Preserve all entries you're NOT modifying exactly as they are.
- Preserve the "---" separators between entries exactly.
- When the user wants to replace an image, a new image has already been uploaded by the system. The new image path will be provided in the instruction. Simply replace the old image reference with the new path.
- "The previous post" or "the last post" means the most recent entry in the most recent file.
- If the instruction is genuinely ambiguous about WHICH entry to edit (e.g., multiple entries match), return action "unclear" with a clarification question.
- Do NOT ask the user for file paths or technical details — that's handled by the system.
- If the edit targets a file more than 2 days old, set a warning like "This edit targets a moment from {date}, which is X days ago. Are you sure?"
- If the instruction asks for something you can't do (delete the entire file, change dates, etc.), return action "unsupported".
- Keep the author's voice — don't rewrite things they didn't ask you to change.

Respond ONLY with valid JSON matching this schema:
{
  "action": "edit" | "unclear" | "unsupported",
  "dateSlug": "YYYY-MM-DD of the file being edited (empty if unclear/unsupported)",
  "updatedContent": "the full updated file content (empty if unclear/unsupported)",
  "explanation": "human-readable summary of the change",
  "clarification": "question for the user (only if action is unclear, keep it simple and non-technical)",
  "unsupportedReason": "why this can't be done (only if action is unsupported)",
  "warning": "warning message if editing old content (empty if none)"
}`;

export async function executeInstruction(
  userInstruction: string,
  recentMoments: { dateSlug: string; content: string }[],
  newImagePath?: string,
): Promise<InstructionResult> {
  // Build the context with recent moment files
  const momentsContext = recentMoments
    .map((m) => `=== File: ${m.dateSlug}.md ===\n${m.content}`)
    .join("\n\n");

  let instruction = userInstruction;
  if (newImagePath) {
    instruction += `\n\n(The user attached a new image which has been uploaded to: ${newImagePath} — use this path to replace the old image reference.)`;
  }

  const userMessage = `Instruction: ${instruction}\n\nRecent moment files:\n\n${momentsContext}`;

  const response = await openai.chat.completions.create({
    model: config.aiModel,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: INSTRUCTION_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });

  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) throw new Error("Empty AI response for instruction");

  const parsed = parseJsonResponse<InstructionResult>(rawContent, "instruction execution");

  if (!["edit", "unclear", "unsupported"].includes(parsed.action)) {
    throw new Error(`Invalid instruction action: ${parsed.action}`);
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
