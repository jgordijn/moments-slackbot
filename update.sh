#!/bin/sh
set -e
cd /opt/moments-bot
curl -sL https://github.com/jgordijn/moments-slackbot/releases/latest/download/moments-bot.tar.gz | tar xz
chown -R moments:moments /opt/moments-bot
rc-service moments-bot restart
echo "✅ Updated and restarted"
