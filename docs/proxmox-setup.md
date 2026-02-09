# Deploying Moments Bot on Proxmox LXC (Alpine)

## Step 1: Download the Alpine template (on Proxmox host)

```bash
pveam update
pveam available --section system | grep alpine
pveam download local alpine-3.23-default_20260116_amd64.tar.xz
```

> Pick the latest version from the list if the filename differs.
> If `local` doesn't support templates, enable it: `pvesm set local --content images,vztmpl`

## Step 2: Create the LXC container

```bash
pct create 200 local:vztmpl/alpine-3.23-default_20260116_amd64.tar.xz \
  --hostname moments-bot \
  --memory 128 \
  --swap 0 \
  --cores 1 \
  --storage local-lvm \
  --rootfs local-lvm:1 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 \
  --features nesting=0 \
  --start 1 \
  --onboot 1 \
  --password
```

> Change CT ID `200` if already taken.

## Step 3: Set up the container

```bash
pct enter 200
```

### Install dependencies and Bun

```bash
apk update && apk upgrade
apk add curl unzip bash

# Bun needs glibc on Alpine
apk add gcompat libstdc++

# Install Bun
curl -fsSL https://bun.sh/install | bash
cp /usr/local/bin/bun /usr/local/bin/bun
chmod 755 /usr/local/bin/bun
bun --version
```

### Create a dedicated user

```bash
addgroup -S moments
adduser -S -G moments -h /opt/moments-bot -s /sbin/nologin moments
```

### Deploy the bot

```bash
mkdir -p /opt/moments-bot
cd /opt/moments-bot
curl -L https://github.com/jgordijn/moments-slackbot/releases/latest/download/moments-bot.tar.gz | tar xz
bun install --production
chown -R moments:moments /opt/moments-bot
```

### Create the .env file

```bash
cat > /opt/moments-bot/.env << 'EOF'
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
AUTHORIZED_SLACK_USER_ID=U_YOUR_USER_ID
GITHUB_OWNER=jgordijn
GITHUB_REPO=inspired-it-website
GITHUB_TOKEN=ghp_your_token
OPENROUTER_API_KEY=sk-or-v1-your-key
# AI_MODEL=anthropic/claude-sonnet-4
EOF

chown moments:moments /opt/moments-bot/.env
chmod 600 /opt/moments-bot/.env
```

### Create the OpenRC service

```bash
cat > /etc/init.d/moments-bot << 'SCRIPT'
#!/sbin/openrc-run

name="moments-bot"
description="Moments Slack Bot"

command="/usr/local/bin/bun"
command_args="run src/index.ts"
command_user="moments:moments"
directory="/opt/moments-bot"

pidfile="/run/${RC_SVCNAME}.pid"
command_background=true

# Load environment from .env file
start_pre() {
    export $(grep -v '^#' /opt/moments-bot/.env | xargs)
}

depend() {
    need net
    after firewall
}
SCRIPT

chmod +x /etc/init.d/moments-bot
rc-update add moments-bot default
rc-service moments-bot start
```

### Verify it's running

```bash
rc-service moments-bot status
tail -f /var/log/messages | grep moments
```

## Updating the bot

```bash
pct enter 200
cd /opt/moments-bot
curl -L https://github.com/jgordijn/moments-slackbot/releases/latest/download/moments-bot.tar.gz | tar xz
bun install --production
chown -R moments:moments /opt/moments-bot
rc-service moments-bot restart
```

## Troubleshooting

```bash
# Enter the container
pct enter 200

# Check service status
rc-service moments-bot status

# Check logs
tail -50 /var/log/messages

# Run manually to see output
cd /opt/moments-bot
export $(grep -v '^#' .env | xargs)
/usr/local/bin/bun run src/index.ts

# Restart
rc-service moments-bot restart
```
