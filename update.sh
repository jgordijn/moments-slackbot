#!/bin/sh
set -e
cd /opt/moments-bot
curl -sL https://github.com/jgordijn/moments-slackbot/releases/latest/download/moments-bot.tar.gz | tar xz
chown -R moments:moments /opt/moments-bot
VERSION=$(grep -o '"version": "[^"]*"' package.json | head -1 | cut -d'"' -f4)
rc-service moments-bot restart
echo "✅ Updated and restarted — v${VERSION}"
