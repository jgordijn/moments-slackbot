/**
 * Configuration — all from environment variables.
 * The bot is locked to a single authorized Slack user.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  /** Slack Bot Token (xoxb-...) */
  slackBotToken: requireEnv("SLACK_BOT_TOKEN"),

  /** Slack App Token for Socket Mode (xapp-...) */
  slackAppToken: requireEnv("SLACK_APP_TOKEN"),

  /** The single Slack user ID allowed to use this bot */
  authorizedUserId: requireEnv("AUTHORIZED_SLACK_USER_ID"),

  /** GitHub personal access token with repo contents write scope */
  githubToken: requireEnv("GITHUB_TOKEN"),

  /** GitHub repository owner */
  githubOwner: requireEnv("GITHUB_OWNER"),

  /** GitHub repository name */
  githubRepo: requireEnv("GITHUB_REPO"),

  /** Path inside the repo where moment files live */
  momentsPath: process.env.MOMENTS_PATH || "content/moments",

  /** OpenRouter API key for AI features */
  openrouterApiKey: requireEnv("OPENROUTER_API_KEY"),

  /** Model to use via OpenRouter (any model on openrouter.ai) */
  aiModel: process.env.AI_MODEL || "anthropic/claude-sonnet-4",
} as const;
