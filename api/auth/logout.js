/**
 * Clear this browser's refresh cookie. Does not revoke at Google —
 * other devices stay signed in.
 */
'use strict';

const lib = require('./_lib');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    lib.noStore(res);
    res.status(204).end();
    return;
  }
  /* POST only — GET would allow cross-site top-level logout via SameSite=Lax. */
  if (req.method !== 'POST') {
    lib.json(res, 405, { error: 'Method not allowed' });
    return;
  }

  lib.setCookies(res, [
    lib.cookieHeader(lib.REFRESH_COOKIE, '', req, { clear: true }),
    lib.cookieHeader(lib.OAUTH_COOKIE, '', req, { clear: true })
  ]);
  lib.json(res, 200, { ok: true });
};
