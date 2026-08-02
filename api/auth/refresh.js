/**
 * Mint a short-lived access token from the httpOnly refresh cookie.
 */
'use strict';

const lib = require('./_lib');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    lib.noStore(res);
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    lib.json(res, 405, { error: 'Method not allowed' });
    return;
  }
  if (!lib.envOk()) {
    lib.json(res, 503, { error: 'auth-not-configured' });
    return;
  }

  const cookies = lib.parseCookies(req);
  const raw = cookies[lib.REFRESH_COOKIE];
  if (!raw) {
    lib.json(res, 401, { error: 'needs-auth' });
    return;
  }

  let payload;
  try {
    payload = lib.openSealed(raw);
  } catch (e) {
    lib.setCookies(res, lib.cookieHeader(lib.REFRESH_COOKIE, '', req, { clear: true }));
    lib.json(res, 401, { error: 'needs-auth' });
    return;
  }
  if (!payload || !payload.rt) {
    lib.json(res, 401, { error: 'needs-auth' });
    return;
  }

  try {
    const tokens = await lib.refreshAccess(payload.rt);
    if (tokens.scope && !lib.hasDriveScope(tokens.scope)) {
      lib.json(res, 403, { error: 'missing-drive-scope' });
      return;
    }
    let email = payload.email || '';
    if (!email && tokens.access_token) {
      email = await lib.fetchEmail(tokens.access_token);
      if (email) {
        const sealed = lib.seal({ rt: payload.rt, email });
        lib.setCookies(res, lib.cookieHeader(lib.REFRESH_COOKIE, sealed, req, { maxAge: 365 * 24 * 60 * 60 }));
      }
    }
    lib.json(res, 200, {
      access_token: tokens.access_token,
      expires_in: tokens.expires_in || 3600,
      email: email || '',
      scope: tokens.scope || ''
    });
  } catch (e) {
    const code = e && e.payload && e.payload.error;
    const invalid = code === 'invalid_grant' ||
      /invalid_grant|revoked|expired/i.test((e && e.message) || '');
    if (invalid) {
      lib.setCookies(res, lib.cookieHeader(lib.REFRESH_COOKIE, '', req, { clear: true }));
    }
    lib.json(res, 401, { error: 'needs-auth', detail: String((e && e.message) || e).slice(0, 120) });
  }
};
