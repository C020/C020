#!/usr/bin/env node
// Prints random secrets to paste into .env
import { randomBytes } from 'node:crypto';

const secret = (bytes = 32) => randomBytes(bytes).toString('hex');
console.log(`SESSION_SECRET=${secret()}`);
console.log(`TWITCH_EVENTSUB_SECRET=${secret(24)}`);
console.log(`YOUTUBE_WEBSUB_SECRET=${secret(24)}`);
