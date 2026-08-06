#!/usr/bin/env node
/**
 * Vercel (or local) build step: inject deploy env into js/config.js.
 * Committed file stays empty so public forks never copy secrets.
 *
 * Env vars (all optional for inject; auth BFF also needs secrets server-side):
 *   GOOGLE_CLIENT_ID     — Google OAuth Web Client ID (injected into client config)
 *   GOOGLE_CLIENT_SECRET — server-only; used by /api/auth/* (not written to config.js)
 *   AUTH_SECRET          — server-only; encrypts refresh cookie (not written to config.js)
 *   DISCORD_WEBHOOK_URL  — server-only Discord webhook (used by /api/feedback).
 *                          When set, client feedbackEndpoint becomes "/api/feedback".
 *   FEEDBACK_ENDPOINT    — override client endpoint (e.g. direct webhook for local tests)
 *   FEEDBACK_MAILTO      — email for mailto fallback when send fails
 */
'use strict';
const fs = require('fs');
const path = require('path');

const id = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const discord = String(process.env.DISCORD_WEBHOOK_URL || '').trim();
const explicit = String(process.env.FEEDBACK_ENDPOINT || '').trim();
const feedback = explicit || (discord ? '/api/feedback' : '');
const mailto = String(process.env.FEEDBACK_MAILTO || '').trim();
const out = path.join(__dirname, '..', 'js', 'config.js');

const body =
  '/* NutriDaily deployment config.\n' +
  ' * Committed copy keeps secrets empty. At deploy, scripts/inject-client-id.js\n' +
  ' * may fill this from GOOGLE_CLIENT_ID / DISCORD_WEBHOOK_URL / FEEDBACK_*.\n' +
  ' * Forks: leave empty, or set your own env / paste Client ID in Settings.\n' +
  ' */\n' +
  'window.ND_CONFIG = {\n' +
  '  googleClientId: ' + JSON.stringify(id) + ',\n' +
  '  feedbackEndpoint: ' + JSON.stringify(feedback) + ',\n' +
  '  feedbackMailto: ' + JSON.stringify(mailto) + '\n' +
  '};\n';

fs.writeFileSync(out, body);
const parts = [];
parts.push(id ? 'googleClientId set' : 'googleClientId empty');
parts.push(feedback ? ('feedbackEndpoint=' + feedback) : 'feedbackEndpoint empty');
parts.push(mailto ? 'feedbackMailto set' : 'feedbackMailto empty');
parts.push(discord ? 'DISCORD_WEBHOOK_URL present (server)' : 'DISCORD_WEBHOOK_URL unset');
console.log('inject-client-id: ' + parts.join('; '));
