# Deploying Moments Bot on Proxmox LXC (Alpine)

## Step 1: Download the Alpine template (on Proxmox host)

```bash
ssh root@<proxmox-ip>

pveam update
pveam available --section system | grep alpine
pveam download local template alpine-3.23-default_20260116_amd64.tar.xz
```

> Pick the latest version from the list if the filename differs.

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

> Adjust: CT ID `200`, `--storage`, `--net0` bridge/IP to match your setup.
> 1GB disk is plenty.

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
source /root/.bashrc
bun --version
```

### Create a dedicated user

```bash
addgroup -S moments
adduser -S -G moments -h /opt/moments-bot -s /sbin/nologin moments
```

### Deploy the bot

Exit the container (`exit`), then from your Mac:

```bash
cd ~/projects/playground-projects/moments-slackbot
tar czf /tmp/moments-bot.tar.gz src/ package.json bun.lock

scp /tmp/moments-bot.tar.gz root@<proxmox-ip>:/tmp/

ssh root@<proxmox-ip> "
  pct exec 200 -- mkdir -p /opt/moments-bot
  pct push 200 /tmp/moments-bot.tar.gz /opt/moments-bot/moments-bot.tar.gz
  pct exec 200 -- sh -c 'cd /opt/moments-bot && tar xzf moments-bot.tar.gz && rm moments-bot.tar.gz'
  pct exec 200 -- chown -R moments:moments /opt/moments-bot
"
```

### Install node modules

```bash
pct enter 200
cd /opt/moments-bot
/root/.bun/bin/bun install --production
chown -R moments:moments /opt/moments-bot
```

### Create the .env file

```bash
cat > /opt/moments-bot/.env << 'EOF'
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
AUTHORIZED_SLACK_USER_ID=U_YOUR_USER_ID
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

command="/root/.bun/bin/bun"
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

From your Mac:

```bash
cd ~/projects/playground-projects/moments-slackbot
tar czf /tmp/moments-bot.tar.gz src/ package.json bun.lock

scp /tmp/moments-bot.tar.gz root@<proxmox-ip>:/tmp/

ssh root@<proxmox-ip> "
  pct push 200 /tmp/moments-bot.tar.gz /opt/moments-bot/moments-bot.tar.gz
  pct exec 200 -- sh -c 'cd /opt/moments-bot && tar xzf moments-bot.tar.gz && rm moments-bot.tar.gz'
  pct exec 200 -- chown -R moments:moments /opt/moments-bot
  pct exec 200 -- rc-service moments-bot restart
"
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
/root/.bun/bin/bun run src/index.ts

# Restart
rc-service moments-bot restart
```
