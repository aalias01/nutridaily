/**
 * OAuth redirect target: exchange code, set encrypted refresh cookie, return to app.
 */
'use strict';

const lib = require('./_lib');

function redirectHome(res, req, auth, errMsg) {
  const u = new URL(lib.originOf(req) + '/');
  u.searchParams.set('auth', auth);
  if (errMsg) u.searchParams.set('err', String(errMsg).slice(0, 160));
  lib.setCookies(res, lib.cookieHeader(lib.OAUTH_COOKIE, '', req, { clear: true }));
  res.writeHead(302, { Location: u.toString() });
  res.end();
}

module.exports = async function handler(req, res) {
  lib.noStore(res);
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!lib.envOk()) {
    redirectHome(res, req, 'error', 'Sign-in is not configured on this deploy.');
    return;
  }

  const url = new URL(req.url, lib.originOf(req));
  const err = url.searchParams.get('error');
  if (err) {
    redirectHome(res, req, 'error', err === 'access_denied' ? 'Sign-in cancelled' : err);
    return;
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    redirectHome(res, req, 'error', 'Missing OAuth code');
    return;
  }

  const cookies = lib.parseCookies(req);
  let oauth;
  try {
    oauth = lib.openSealed(cookies[lib.OAUTH_COOKIE]);
  } catch (e) {
    redirectHome(res, req, 'error', 'Sign-in session expired. Try again.');
    return;
  }
  if (!oauth || oauth.s !== state || !oauth.v) {
    redirectHome(res, req, 'error', 'Invalid sign-in state. Try again.');
    return;
  }
  if (Date.now() - (oauth.t || 0) > 10 * 60 * 1000) {
    redirectHome(res, req, 'error', 'Sign-in session expired. Try again.');
    return;
  }

  try {
    const tokens = await lib.exchangeCode(req, code, oauth.v);
    if (!lib.hasDriveScope(tokens.scope)) {
      redirectHome(res, req, 'error', 'Google Drive permission was not granted. Sign in again and allow Drive access.');
      return;
    }
    if (!tokens.refresh_token) {
      redirectHome(res, req, 'error', 'Google did not return a refresh token. Remove NutriDaily from your Google Account connections, then Sign in again.');
      return;
    }
    const email = tokens.access_token ? await lib.fetchEmail(tokens.access_token) : '';
    const sealed = lib.seal({ rt: tokens.refresh_token, email: email || '' });
    lib.setCookies(res, [
      lib.cookieHeader(lib.REFRESH_COOKIE, sealed, req, { maxAge: 365 * 24 * 60 * 60 }),
      lib.cookieHeader(lib.OAUTH_COOKIE, '', req, { clear: true })
    ]);
    const u = new URL(lib.originOf(req) + '/');
    u.searchParams.set('auth', 'ok');
    res.writeHead(302, { Location: u.toString() });
    res.end();
  } catch (e) {
    redirectHome(res, req, 'error', (e && e.message) || 'Sign-in failed');
  }
};
