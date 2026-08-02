#!/usr/bin/env node
/**
 * Vercel (or local) build step: inject GOOGLE_CLIENT_ID into js/config.js.
 * Committed file stays empty so public forks never copy secrets.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const id = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const out = path.join(__dirname, '..', 'js', 'config.js');

const body =
  '/* NutriChat deployment config.\n' +
  ' * Committed copy keeps googleClientId empty. At deploy, scripts/inject-client-id.js\n' +
  ' * may fill this from GOOGLE_CLIENT_ID. Forks: leave empty, or paste Client ID in Settings.\n' +
  ' */\n' +
  'window.NC_CONFIG = {\n' +
  '  googleClientId: ' + JSON.stringify(id) + '\n' +
  '};\n';

fs.writeFileSync(out, body);
console.log('inject-client-id: ' + (id ? 'googleClientId set' : 'googleClientId empty'));
