/**
 * Shared helpers for NutriDaily OAuth BFF (refresh token in httpOnly cookie).
 * Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET
 */
'use strict';

const crypto = require('crypto');

const SCOPE = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

const REFRESH_COOKIE = 'nd_grefresh';
const OAUTH_COOKIE = 'nd_oauth';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function envOk() {
  return !!(
    String(process.env.GOOGLE_CLIENT_ID || '').trim() &&
    String(process.env.GOOGLE_CLIENT_SECRET || '').trim() &&
    String(process.env.AUTH_SECRET || '').trim()
  );
}

function clientId() {
  return String(process.env.GOOGLE_CLIENT_ID || '').trim();
}

function clientSecret() {
  return String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
}

function authKey() {
  return crypto.createHash('sha256').update(String(process.env.AUTH_SECRET || '')).digest();
}

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', authKey(), iv);
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function openSealed(token) {
  const buf = Buffer.from(String(token || ''), 'base64url');
  if (buf.length < 29) throw new Error('bad cookie');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', authKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

function isHttps(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (xf === 'https') return true;
  if (xf === 'http') return false;
  return !!(req.headers.host && String(req.headers.host).includes('vercel.app'));
}

function originOf(req) {
  const proto = isHttps(req) ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return proto + '://' + host;
}

function redirectUri(req) {
  return originOf(req) + '/api/auth/callback';
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function cookieHeader(name, value, req, opts) {
  const parts = [name + '=' + encodeURIComponent(value)];
  parts.push('Path=' + ((opts && opts.path) || '/'));
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (isHttps(req)) parts.push('Secure');
  if (opts && opts.maxAge != null) parts.push('Max-Age=' + opts.maxAge);
  if (opts && opts.clear) {
    return name + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (isHttps(req) ? '; Secure' : '');
  }
  return parts.join('; ');
}

function setCookies(res, headers) {
  const list = Array.isArray(headers) ? headers : [headers];
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', list);
  else res.setHeader('Set-Cookie', (Array.isArray(prev) ? prev : [prev]).concat(list));
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function randomState() {
  return b64url(crypto.randomBytes(16));
}

function hasDriveScope(scopeStr) {
  return String(scopeStr || '').split(/\s+/).indexOf(DRIVE_SCOPE) !== -1;
}

async function exchangeCode(req, code, verifier) {
  const body = new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code',
    code_verifier: verifier
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((j.error_description || j.error || 'token exchange failed').toString());
    err.status = res.status;
    err.payload = j;
    throw err;
  }
  return j;
}

async function refreshAccess(refreshToken) {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((j.error_description || j.error || 'refresh failed').toString());
    err.status = res.status;
    err.payload = j;
    throw err;
  }
  return j;
}

async function fetchEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (!res.ok) return '';
  const j = await res.json().catch(() => ({}));
  return j.email || '';
}

function json(res, status, obj) {
  noStore(res);
  res.status(status).json(obj);
}

module.exports = {
  SCOPE,
  REFRESH_COOKIE,
  OAUTH_COOKIE,
  DRIVE_SCOPE,
  envOk,
  clientId,
  originOf,
  redirectUri,
  parseCookies,
  cookieHeader,
  setCookies,
  noStore,
  pkcePair,
  randomState,
  hasDriveScope,
  seal,
  openSealed,
  exchangeCode,
  refreshAccess,
  fetchEmail,
  json
};
