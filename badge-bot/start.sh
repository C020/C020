#!/bin/sh
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
nohup node index.js > bot.log 2>&1 &
echo "Bot started in background (PID $!)"
