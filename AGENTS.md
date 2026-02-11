# AGENTS.md — Moments Slackbot

## What This Project Is

This is **Moments Bot** — a private Slack bot that publishes short microblog entries ("moments") to the [Moments page](https://inspired.it/moments/) on Jeroen's personal website. The workflow is simple: send a DM to the bot in Slack, it reviews the text with AI (fixing typos, checking markdown formatting), and then commits the entry to a GitHub repository. The website rebuilds automatically from that commit.

Moments are short, casual, personal thoughts — a discovery, an observation, a link worth sharing. They live as markdown files in a GitHub repo (`content/moments/YYYY-MM-DD.md`), one file per day, with entries separated by `---`.

### How It Works (End to End)

1. Jeroen sends a DM to the Slack bot with a thought or short text
2. The bot passes it through AI review (via OpenRouter) which either:
   - **Publishes directly** if only minor typos/formatting were fixed
   - **Proposes edits** with accept/reject/publish-original buttons if bigger changes are suggested
3. On publish, the bot commits the moment to the `main` branch of the website's GitHub repo
4. The website (a static site) rebuilds automatically from the new commit
5. The bot can also **help craft** a moment from a rough idea (`help me write about ...`)

### File Format

Each day's moments file looks like:

```markdown
---
date: "2026-02-11"
---

First moment of the day.

---

Second moment, separated by a horizontal rule.
```

## Technology Stack

| What | Technology |
|------|-----------|
| **Runtime** | [Bun](https://bun.sh) (not Node.js) |
| **Language** | TypeScript (ESNext, bundler module resolution) |
| **Slack SDK** | `@slack/bolt` v4 — Socket Mode (outbound WebSocket, no public URL needed) |
| **AI** | OpenRouter API via the `openai` npm package (compatible client) — default model is `anthropic/claude-sonnet-4` |
| **GitHub** | `@octokit/rest` v21 — commits directly to `main` branch |
| **Deployment** | Proxmox LXC container running Alpine Linux, or Docker (`docker compose up -d`) |
| **CI/CD** | GitHub Actions — tags (`v*`) trigger a release that packages `src/`, `package.json`, `bun.lock` as a tarball |
| **Timezone** | Hardcoded to `Europe/Amsterdam` (for date slugs and daily file boundaries) |

### Key Details

- **Bun, not Node**: Use `bun run`, `bun install`, etc. The `package.json` scripts use `bun`. There is no `node` or `npm` usage in production.
- **No tests**: There is currently no test framework or test files. This is a small personal project.
- **No build step**: Bun runs TypeScript directly (`bun run src/index.ts`). No `tsc` compilation needed.
- **Single user**: The bot is locked to one Slack user ID (`AUTHORIZED_SLACK_USER_ID`). All other users are rejected.
- **Socket Mode**: No incoming webhooks, no public URLs, no exposed ports. The bot connects outbound to Slack.

## Source Structure

```
src/
├── index.ts         # Entry point — starts the Slack bot, adds log timestamps
├── config.ts        # Environment variable loading and validation
├── bot.ts           # Slack message/action handlers, all bot logic and flows
├── ai.ts            # AI review and craft functions (OpenRouter via openai SDK)
├── github.ts        # GitHub file read/create/append/image upload via Octokit
├── images.ts        # Slack image extraction, download, and processing
└── slack-emoji.ts   # Converts Slack :emoji: shortcodes to Unicode
```

- **`bot.ts`** is the largest file and contains all Slack interaction logic: message routing, button handlers, proposal flows, image handling, and publishing.
- **`ai.ts`** has two AI functions: `reviewMoment()` (structured JSON output with publish/suggest action) and `craftMoment()` (freeform text output).
- **`github.ts`** handles reading existing day files, appending/creating moment entries with proper frontmatter, and uploading images to `public/images/moments/`.
- **`images.ts`** extracts image files from Slack messages, downloads them via Slack API, and prepares them for GitHub upload.
- **`slack-emoji.ts`** has a hardcoded map of ~200 common emoji shortcodes. Unknown ones pass through unchanged.

## Working With Microblog Entries

### Creating a Moment Entry

When helping to write a new moment, keep these rules in mind:

- Moments are **short** — typically 1–4 sentences, sometimes a paragraph
- The voice is **casual and personal** — not corporate, not overly formal
- They can contain **markdown**: links `[text](url)`, bold, quotes, etc.
- **Blockquotes** (`>`) must have blank lines before and after them
- The AI review system will catch typos and markdown formatting issues, but getting it right helps

### Validating a Moment Before Suggesting It

Before proposing a moment to publish, do these minimal checks:

1. **Markdown links** are well-formed: `[display text](https://url)` — no broken brackets or missing URLs
2. **Blockquotes** have blank lines around them (the AI system prompt enforces this, respect it)
3. **Length** — if it's getting beyond a couple of paragraphs, it's probably a blog post, not a moment
4. **No sensitive information** — moments are public on the website
5. **Tone** — should sound like a person sharing a thought, not a press release

### Discussing and Refining Moments

When asked to help draft, refine, or discuss a moment:

- Ask clarifying questions if the idea is vague — "What's the key thing you want people to take away?"
- Offer 2–3 variations when the tone isn't clear
- Keep suggestions concise; don't over-explain
- Preserve the author's voice — if they wrote it casually, keep it casual
- It's fine to suggest adding a link if the moment references something specific
- Emoji are welcome (they're part of the voice) — use Unicode directly, not Slack shortcodes

## Environment Variables

All configuration is via environment variables (see `.env.example`):

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | App-level token for Socket Mode (`xapp-...`) |
| `AUTHORIZED_SLACK_USER_ID` | Yes | The single allowed Slack user ID |
| `GITHUB_TOKEN` | Yes | Fine-grained PAT with repo contents read/write |
| `GITHUB_OWNER` | Yes | GitHub username/org owning the website repo |
| `GITHUB_REPO` | Yes | Repository name for the website |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key |
| `MOMENTS_PATH` | No | Path inside repo for moment files (default: `content/moments`) |
| `MOMENTS_IMAGES_PATH` | No | Path in repo for moment images (default: `public/images/moments`) |
| `MOMENTS_IMAGES_URL_PREFIX` | No | URL prefix in markdown embeds (default: `/images/moments`) |
| `AI_MODEL` | No | OpenRouter model ID (default: `anthropic/claude-sonnet-4`) |

## Running Locally

```bash
cp .env.example .env
# Fill in real values in .env
bun install
bun run dev          # watches for changes
# or: bun run start  # single run
```

## Releasing

Use the `release.sh` script to create a new release. **Do not tag manually.**

```bash
./release.sh patch   # Bug fixes, minor tweaks (0.4.0 → 0.4.1)
./release.sh minor   # New features, behavioral changes (0.4.0 → 0.5.0)
./release.sh major   # Breaking changes (0.4.0 → 1.0.0) — only when explicitly requested
```

The script:
1. Validates you're on `main` with a clean working tree
2. Bumps the version in `package.json`
3. Commits with message "Release vX.Y.Z"
4. Creates an annotated tag `vX.Y.Z`
5. Pushes both the commit and the tag

The tag push triggers GitHub Actions which packages and publishes the release.

**When choosing the bump type:**
- **patch**: Typo fixes, config changes, minor bug fixes, logging improvements
- **minor**: New features, new integrations, behavioral changes
- **major**: Only when explicitly sure — breaking changes, major rewrites

If it's unclear whether a change is minor or patch, **ask the user** before releasing.

## Deployment

- **Docker**: `docker compose up -d` — builds from `Dockerfile` (Bun Alpine image, non-root user, read-only filesystem, 256MB memory limit)
- **Proxmox LXC**: See `docs/proxmox-setup.md` — Alpine container with OpenRC service, deployed via GitHub releases
- **Updating**: After a release, run `./update.sh` on the server to pull the latest version
