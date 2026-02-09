# 💭 Moments Bot

A private Slack bot that publishes short thoughts and discoveries to your [Moments](https://inspired.it/moments/) microblog. Send a message, and it appears on your website.

## How it works

1. **Send a DM** to the bot with your thought
2. **AI reviews** the text — fixes minor typos silently, proposes edits for bigger changes
3. **Publishes** directly to your website by committing to GitHub
4. You can also ask it to **help craft** a nice moment from a rough idea

### Commands

| What you type | What happens |
|---|---|
| Any text | Reviews and publishes (or suggests edits) |
| `help me write about <topic>` | AI crafts a polished moment for you |
| `show today` | Shows today's published moments |
| `help` | Shows available commands |

### Security

- **Private**: Only your Slack user ID can interact with the bot
- **Sandboxed**: Docker container with read-only filesystem, no privileges, no open ports
- **Socket Mode**: No incoming webhooks needed, no public URLs
- **Scoped**: Only has access to the moments repo, nothing else

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it **Moments** (or `Moment Catcher`, `Thought Drop` — your call)
3. Pick your workspace

#### Enable Socket Mode
- Go to **Socket Mode** → toggle it **ON**
- Create an app-level token with `connections:write` scope → save the `xapp-...` token

#### Bot Token Scopes
Go to **OAuth & Permissions** → **Bot Token Scopes** and add:
- `chat:write` — send messages
- `im:history` — read DM messages
- `im:read` — access DM channel info
- `im:write` — open DMs

### 3. Get an OpenRouter API key

Go to [openrouter.ai/keys](https://openrouter.ai/keys) and create a key. You can switch models anytime via the `AI_MODEL` env var (e.g. `anthropic/claude-sonnet-4`, `google/gemini-2.5-pro`, `openai/gpt-4o`).

#### Enable Events
Go to **Event Subscriptions** → toggle **ON**, then under **Subscribe to bot events** add:
- `message.im` — receive DM messages

#### App Home
Go to **App Home**:
- Toggle **Messages Tab** → ON
- Check **"Allow users to send Slash commands and messages from the messages tab"**

#### Install the App
Go to **Install App** → **Install to Workspace** → authorize it.

Copy the **Bot User OAuth Token** (`xoxb-...`).

### 2. Get your Slack User ID

In Slack, click your profile picture → **Profile** → click the **⋯** → **Copy member ID**.

### 4. Create a GitHub Token

Go to [github.com/settings/tokens](https://github.com/settings/tokens?type=beta) → **Fine-grained tokens**:
- **Repository access**: Only your moments repository
- **Permissions**: Contents → **Read and write**

### 5. Configure

```bash
cp .env.example .env
# Edit .env with your tokens
```

### 6. Run with Docker

```bash
docker compose up -d
```

That's it. Open a DM with the bot in Slack and start posting moments.

### Alternative: Run locally (dev)

```bash
npm install
npm run dev
```

## Slack App Manifest

For quick setup, you can use this manifest when creating the app:

```yaml
display_information:
  name: Moments
  description: Post moments to your microblog
  background_color: "#1a1a2e"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Moments
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - im:read
      - im:write
settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

## Architecture

```
You (Slack DM)
    ↓
Moments Bot (Socket Mode — outbound only)
    ├── AI Review (OpenRouter → any model)
    │   ├── Minor fixes → publish directly
    │   └── Bigger changes → propose with buttons
    └── GitHub API
        └── Commit to main → content/moments/YYYY-MM-DD.md
            → Website rebuilds automatically
```

## Name suggestions for Slack

Pick what feels right:
- **Moments** — clean and obvious
- **Thought Drop** — captures the quick-post nature
- **Moment Catcher** — playful
- **Quick Ink** — short and punchy
- **Jot** — minimal, like the moments themselves
