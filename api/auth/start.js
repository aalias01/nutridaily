/**
 * Begin Google OAuth (authorization code + PKCE). Redirects the browser to Google.
 */
'use strict';

const lib = require('./_lib');

module.exports = async function handler(req, res) {
  lib.noStore(res);
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!lib.envOk()) {
    res.status(503).send('Google Drive sign-in is not configured on this deploy (need GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET).');
    return;
  }

  const { verifier, challenge } = lib.pkcePair();
  const state = lib.randomState();
  const oauth = lib.seal({ v: verifier, s: state, t: Date.now() });
  lib.setCookies(res, lib.cookieHeader(lib.OAUTH_COOKIE, oauth, req, { maxAge: 600 }));

  const params = new URLSearchParams({
    client_id: lib.clientId(),
    redirect_uri: lib.redirectUri(req),
    response_type: 'code',
    scope: lib.SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });

  res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
  res.end();
};
