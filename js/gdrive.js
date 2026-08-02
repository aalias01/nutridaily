/* NutriDaily — Google account + Drive storage (BYO cloud).
 * Primary auth: Vercel OAuth BFF (/api/auth/*) with refresh token in httpOnly cookie.
 * Fallback: Google Identity Services token client when BFF is not configured (local/forks).
 * Scope drive.file: the app can ONLY see files it created — one JSON doc
 * in a visible "NutriDaily" folder in the USER'S OWN Drive.
 *
 * Token rules: background paths never open a sign-in UI. Silent re-auth via
 * /api/auth/refresh (or GIS prompt:none fallback). Visible auth redirects to
 * /api/auth/start (or GIS popup when BFF unavailable).
 */
const GDrive = (() => {
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const SCOPE = DRIVE_SCOPE + " https://www.googleapis.com/auth/userinfo.email";
  const FILE_NAME = "nutridaily-data.json";
  const FOLDER_NAME = "NutriDaily";
  const TOKEN_KEY = "nd_gtoken_v1"; // sessionStorage: short-lived access token cache
  const LEGACY_TOKEN = "nc_gtoken_v1"; // NutriChat
  const CLIENT_KEY = "nd_gclient";
  const LEGACY_CLIENT = "nc_gclient";
  const EMAIL_KEY = "nd_gemail_v1";
  const AUTH_REFRESH = "/api/auth/refresh";
  const AUTH_START = "/api/auth/start";
  const AUTH_LOGOUT = "/api/auth/logout";
  const SILENT_COOLDOWN_MS = 15 * 1000;
  const NEEDS_AUTH = "needs-auth";
  const BFF_UNAVAILABLE = "auth-bff-unavailable";
  const MISSING_DRIVE =
    "Google Drive permission was not granted. Sign in again and allow Drive access.";

  let tokenClient = null;
  let pending = null;
  let memToken = null; // { token, exp }
  let lastSilentAt = 0;
  let refreshInflight = null;
  let bffKnown = null; // null unknown, true/false after first refresh probe

  /** Google granular consent: email can succeed while Drive stays unchecked. */
  function hasDriveScope(resp) {
    if (libReady() && typeof google.accounts.oauth2.hasGrantedAllScopes === "function") {
      try {
        return google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE);
      } catch (e) { /* fall through */ }
    }
    const s = (resp && resp.scope) || "";
    return s.split(/\s+/).indexOf(DRIVE_SCOPE) !== -1;
  }

  function isInsufficientScopeMsg(msg) {
    return /insufficient.*scope/i.test(msg || "");
  }

  function migrateClientPref() {
    try {
      if (localStorage.getItem(CLIENT_KEY) == null && localStorage.getItem(LEGACY_CLIENT) != null) {
        localStorage.setItem(CLIENT_KEY, localStorage.getItem(LEGACY_CLIENT));
        localStorage.removeItem(LEGACY_CLIENT);
      }
    } catch (e) { /* ignore */ }
  }

  function clientId() {
    migrateClientPref();
    return (localStorage.getItem(CLIENT_KEY) || "").trim() || ((window.ND_CONFIG || {}).googleClientId || "").trim();
  }
  const libReady = () => !!(window.google && google.accounts && google.accounts.oauth2);
  const onHttp = () => location.protocol === "http:" || location.protocol === "https:";
  const configured = () => !!clientId() || bffKnown === true;
  const canUse = () => onHttp() && (configured() || bffKnown !== false);

  function unavailableReason() {
    if (!onHttp()) return "Google sign-in needs the app served over http(s). Run: python3 -m http.server 8080, or open the hosted URL.";
    if (!configured() && bffKnown === false) {
      return "No OAuth Client ID yet. Open Advanced below to paste one, or use a deploy that sets GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / AUTH_SECRET.";
    }
    if (!configured() && !clientId()) {
      return "No OAuth Client ID yet. Open Advanced below to paste one, or use a deploy that sets GOOGLE_CLIENT_ID.";
    }
    return null;
  }

  function cacheToken(accessToken, expiresIn) {
    const exp = Date.now() + (Number(expiresIn || 3500) - 60) * 1000;
    memToken = { token: accessToken, exp };
    try {
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(memToken));
      sessionStorage.removeItem(LEGACY_TOKEN);
    } catch (e) {}
    return accessToken;
  }

  function clearCachedToken() {
    memToken = null;
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(LEGACY_TOKEN);
    } catch (e) {}
  }

  function readSessionToken() {
    try {
      let t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
      if (!t) {
        t = JSON.parse(sessionStorage.getItem(LEGACY_TOKEN) || "null");
        if (t) {
          sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t));
          sessionStorage.removeItem(LEGACY_TOKEN);
        }
      }
      return t && t.exp > Date.now() ? t : null;
    } catch (e) { return null; }
  }

  /** Passive only — never calls network or GIS. */
  function cachedToken() {
    if (memToken && memToken.exp > Date.now()) return memToken.token;
    const t = readSessionToken();
    if (t) {
      memToken = t;
      return t.token;
    }
    memToken = null;
    return null;
  }

  function initClient() {
    if (tokenClient || !libReady() || !clientId()) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPE,
      callback: (resp) => {
        const p = pending; pending = null;
        if (!p) return;
        if (resp && resp.access_token) {
          if (!hasDriveScope(resp)) {
            p.reject(new Error(MISSING_DRIVE));
            return;
          }
          p.resolve(cacheToken(resp.access_token, resp.expires_in));
        } else p.reject(new Error((resp && resp.error) || "Sign-in failed"));
      },
      error_callback: (err) => {
        const p = pending; pending = null;
        if (p) p.reject(new Error((err && err.type) === "popup_closed" ? "Sign-in cancelled" : "Sign-in failed: " + ((err && err.type) || "unknown")));
      },
    });
  }

  function requestToken(prompt) {
    const reason = unavailableReason();
    if (reason && !clientId()) return Promise.reject(new Error(reason));
    if (!libReady()) return Promise.reject(new Error("Google sign-in library is still loading. Try again in a moment."));
    initClient();
    if (!tokenClient) return Promise.reject(new Error("Sign-in not ready"));
    if (pending) return Promise.reject(new Error("Sign-in already in progress"));
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      try { tokenClient.requestAccessToken({ prompt: prompt }); }
      catch (e) { pending = null; reject(e); }
    });
  }

  async function refreshFromServer() {
    if (refreshInflight) return refreshInflight;
    refreshInflight = (async () => {
      let res;
      try {
        res = await fetch(AUTH_REFRESH, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
      } catch (e) {
        bffKnown = false;
        throw new Error(BFF_UNAVAILABLE);
      }
      /* Static hosts return 404/405/501 — that is not a BFF. */
      if (res.status === 503 || res.status === 404 || res.status === 405 ||
          res.status === 501 || res.status === 502) {
        bffKnown = false;
        throw new Error(BFF_UNAVAILABLE);
      }
      let j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (!j || typeof j !== "object") {
        bffKnown = false;
        throw new Error(BFF_UNAVAILABLE);
      }
      if (res.status === 403 || j.error === "missing-drive-scope") {
        bffKnown = true;
        clearCachedToken();
        throw new Error(MISSING_DRIVE);
      }
      if (res.status === 401 || j.error === "needs-auth") {
        bffKnown = true;
        clearCachedToken();
        throw new Error(NEEDS_AUTH);
      }
      if (!res.ok || !j.access_token) {
        bffKnown = false;
        throw new Error(BFF_UNAVAILABLE);
      }
      bffKnown = true;
      if (j.scope && j.scope.split(/\s+/).indexOf(DRIVE_SCOPE) === -1) {
        clearCachedToken();
        throw new Error(MISSING_DRIVE);
      }
      if (j.email) {
        try { sessionStorage.setItem(EMAIL_KEY, j.email); } catch (e) {}
      }
      return cacheToken(j.access_token, j.expires_in);
    })().finally(() => { refreshInflight = null; });
    return refreshInflight;
  }

  /** Access token via BFF/cache without silentBoot cooldown (post-redirect connect). */
  async function refreshSession() {
    const t = cachedToken();
    if (t) return t;
    return refreshFromServer();
  }

  /** Full-page redirect to Google via BFF. Does not return. */
  function beginLogin() {
    location.href = AUTH_START;
  }

  /**
   * interactive true: may redirect to Google or show GIS UI.
   * interactive false: cached token or silent BFF refresh only (no GIS UI).
   * forceConsent: re-ask scopes (BFF start always uses consent; GIS uses prompt=consent).
   */
  async function getToken(interactive, forceConsent) {
    const t = cachedToken();
    if (t && !forceConsent) return t;

    if (forceConsent) {
      if (!interactive) throw new Error(NEEDS_AUTH);
      if (bffKnown !== false) {
        beginLogin();
        return new Promise(() => {});
      }
      if (!clientId()) throw new Error(unavailableReason() || NEEDS_AUTH);
      return requestToken("consent");
    }

    try {
      return await refreshFromServer();
    } catch (e) {
      const msg = (e && e.message) || "";
      if (msg === MISSING_DRIVE) {
        if (!interactive) throw new Error(MISSING_DRIVE);
        beginLogin();
        return new Promise(() => {});
      }
      if (msg === BFF_UNAVAILABLE) {
        if (!interactive) throw new Error(NEEDS_AUTH);
        if (!clientId()) throw new Error(unavailableReason() || NEEDS_AUTH);
        return requestToken("");
      }
      if (!interactive) throw new Error(NEEDS_AUTH);
      beginLogin();
      return new Promise(() => {});
    }
  }

  /** Silent re-auth: BFF refresh, then GIS prompt:none if BFF unavailable. */
  async function silentBoot() {
    const t = cachedToken();
    if (t) return t;
    if (typeof document !== "undefined" && document.visibilityState && document.visibilityState !== "visible") {
      return Promise.reject(new Error(NEEDS_AUTH));
    }
    if (Date.now() - lastSilentAt < SILENT_COOLDOWN_MS) {
      return Promise.reject(new Error(NEEDS_AUTH));
    }
    lastSilentAt = Date.now();
    try {
      return await refreshFromServer();
    } catch (e) {
      if ((e && e.message) === BFF_UNAVAILABLE && clientId() && libReady()) {
        return requestToken("none").catch(() => Promise.reject(new Error(NEEDS_AUTH)));
      }
      return Promise.reject(new Error((e && e.message) === MISSING_DRIVE ? MISSING_DRIVE : NEEDS_AUTH));
    }
  }

  function signOut() {
    clearCachedToken();
    try { sessionStorage.removeItem(EMAIL_KEY); } catch (e) {}
    try {
      fetch(AUTH_LOGOUT, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        keepalive: true,
      }).catch(() => {});
    } catch (e) {}
  }

  // ---------- authorized fetch ----------
  async function readErrorMessage(res, fallback) {
    let msg = fallback || ("Drive error " + res.status);
    try {
      const j = await res.json();
      if (j.error && j.error.message) msg = j.error.message;
    } catch (e) { /* ignore */ }
    return msg;
  }

  async function gfetch(url, opts, interactive) {
    const wantInteractive = !!interactive;
    let token = await getToken(wantInteractive);
    let res = await fetch(url, withAuth(opts, token));
    if (res.status === 401 || res.status === 403) {
      let msg = "";
      let scopeIssue = false;
      if (res.status === 403) {
        msg = await readErrorMessage(res.clone(), "");
        scopeIssue = isInsufficientScopeMsg(msg);
      }
      if (res.status === 401 || scopeIssue) {
        clearCachedToken();
        if (!wantInteractive) {
          throw new Error(scopeIssue ? (msg || MISSING_DRIVE) : NEEDS_AUTH);
        }
        token = await getToken(true, scopeIssue);
        res = await fetch(url, withAuth(opts, token));
      }
    }
    if (!res.ok) {
      const msg = await readErrorMessage(res, "Drive error " + res.status);
      if (isInsufficientScopeMsg(msg)) clearCachedToken();
      throw new Error(msg);
    }
    return res;
  }
  const withAuth = (opts = {}, token) => ({ ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });

  async function userEmail() {
    try {
      const cached = sessionStorage.getItem(EMAIL_KEY);
      if (cached) return cached;
    } catch (e) {}
    try {
      const res = await gfetch("https://www.googleapis.com/oauth2/v3/userinfo", undefined, false);
      const j = await res.json();
      const email = j.email || "";
      if (email) {
        try { sessionStorage.setItem(EMAIL_KEY, email); } catch (e) {}
      }
      return email;
    } catch (e) {
      /* Email scope is optional; Drive sync still works. */
      return "";
    }
  }

  // ---------- Drive file ops (drive.file scope) ----------
  const API = "https://www.googleapis.com/drive/v3";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

  async function findByName(name, mime, interactive) {
    const q = encodeURIComponent(`name='${name}' and trashed=false` + (mime ? ` and mimeType='${mime}'` : ""));
    const res = await gfetch(`${API}/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=5`, undefined, interactive);
    const j = await res.json();
    return (j.files || [])[0] || null;
  }

  async function ensureFolder(interactive) {
    const found = await findByName(FOLDER_NAME, "application/vnd.google-apps.folder", interactive);
    if (found) return found.id;
    const res = await gfetch(`${API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    }, interactive);
    return (await res.json()).id;
  }

  /** Find the data file, or create it with initialDoc. Returns { fileId, created }. */
  async function ensureFile(initialDoc, interactive) {
    const found = await findByName(FILE_NAME, null, interactive);
    if (found) return { fileId: found.id, created: false };
    const folderId = await ensureFolder(interactive);
    const meta = { name: FILE_NAME, parents: [folderId], mimeType: "application/json" };
    const boundary = "ncb" + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(initialDoc)}\r\n--${boundary}--`;
    const res = await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }, interactive);
    return { fileId: (await res.json()).id, created: true };
  }

  async function readFile(fileId, interactive) {
    const res = await gfetch(`${API}/files/${fileId}?alt=media`, undefined, interactive);
    return res.json();
  }

  async function writeFile(fileId, doc, interactive) {
    await gfetch(`${UPLOAD}/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    }, interactive);
  }

  return {
    canUse, configured, onHttp, unavailableReason, getToken, silentBoot, refreshSession,
    cachedToken, beginLogin, signOut, userEmail, ensureFile, readFile, writeFile,
    storedToken: cachedToken, clientId, NEEDS_AUTH, BFF_UNAVAILABLE,
  };
})();

if (typeof module !== "undefined") module.exports = GDrive;
