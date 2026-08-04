/* NutriDaily — Google account + Drive storage (BYO cloud).
 * Primary auth: Vercel OAuth BFF (/api/auth/*) with refresh token in httpOnly cookie.
 * Fallback: Google Identity Services token client when BFF is not configured (local/forks).
 * Scope drive.file: the app can ONLY see files it created. Each installation
 * owns one JSON shard in a visible "NutriDaily" folder; shards are merged by
 * the sync engine, so different devices never update the same Drive file.
 *
 * Token rules: background paths never open a sign-in UI. Silent re-auth via
 * /api/auth/refresh (or GIS prompt:none fallback). Visible auth redirects to
 * /api/auth/start (or GIS popup when BFF unavailable).
 */
const GDrive = (() => {
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const SCOPE = DRIVE_SCOPE + " https://www.googleapis.com/auth/userinfo.email";
  const LEGACY_FILE_NAME = "nutridaily-data.json";
  const SHARD_PREFIX = "nutridaily-shard-v4-";
  const SHARD_SUFFIX = ".json";
  const FILE_MIME = "application/json";
  const FOLDER_NAME = "NutriDaily";
  const TOKEN_KEY = "nd_gtoken_v1"; // sessionStorage: short-lived access token cache
  const LEGACY_TOKEN = "nc_gtoken_v1"; // NutriChat
  const CLIENT_KEY = "nd_gclient";
  const LEGACY_CLIENT = "nc_gclient";
  const EMAIL_KEY = "nd_gemail_v1";
  const AUTH_REFRESH = "/api/auth/refresh";
  const AUTH_START = "/api/auth/start";
  const AUTH_LOGOUT = "/api/auth/logout";
  const LOGOUT_PENDING_KEY = "nd_server_logout_pending_v1";
  const WRITER_KEY = "nd_drive_writer_v4";
  const MAX_SHARDS = 32;
  const MAX_LIST_PAGES = 10;
  const MAX_DOC_BYTES = 3 * 1024 * 1024;
  const MAX_AGGREGATE_BYTES = 12 * 1024 * 1024;
  const MAX_COLLECTION_ITEMS = 50000;
  const APP_SCHEMA_KEY = "nutridailySchema";
  const APP_WRITER_KEY = "nutridailyWriter";
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
  let runtimeWriterId = null;
  let logoutRetryPending = false;
  // Incremented synchronously when sign-out begins. Any token request that was
  // already in flight must not be allowed to repopulate the credential cache.
  let credentialEpoch = 0;

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

  function cacheToken(accessToken, expiresIn, requestEpoch) {
    if ((requestEpoch != null && requestEpoch !== credentialEpoch) || logoutPending()) {
      clearCachedToken();
      throw new Error(NEEDS_AUTH);
    }
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
    if (logoutPending()) {
      clearCachedToken();
      return null;
    }
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
          try { p.resolve(cacheToken(resp.access_token, resp.expires_in, p.credentialEpoch)); }
          catch (error) { p.reject(error); }
        } else p.reject(new Error((resp && resp.error) || "Sign-in failed"));
      },
      error_callback: (err) => {
        const p = pending; pending = null;
        if (p) p.reject(new Error((err && err.type) === "popup_closed" ? "Sign-in cancelled" : "Sign-in failed: " + ((err && err.type) || "unknown")));
      },
    });
  }

  function requestToken(prompt) {
    if (logoutPending()) return Promise.reject(new Error(NEEDS_AUTH));
    const reason = unavailableReason();
    if (reason && !clientId()) return Promise.reject(new Error(reason));
    if (!libReady()) return Promise.reject(new Error("Google sign-in library is still loading. Try again in a moment."));
    initClient();
    if (!tokenClient) return Promise.reject(new Error("Sign-in not ready"));
    if (pending) return Promise.reject(new Error("Sign-in already in progress"));
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, credentialEpoch };
      try { tokenClient.requestAccessToken({ prompt: prompt }); }
      catch (e) { pending = null; reject(e); }
    });
  }

  async function refreshFromServer() {
    if (logoutPending()) {
      clearCachedToken();
      throw new Error(NEEDS_AUTH);
    }
    if (refreshInflight) return refreshInflight;
    const requestEpoch = credentialEpoch;
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
      if (requestEpoch !== credentialEpoch || logoutPending()) {
        clearCachedToken();
        throw new Error(NEEDS_AUTH);
      }
      if (j.email) {
        try { sessionStorage.setItem(EMAIL_KEY, j.email); } catch (e) {}
      }
      return cacheToken(j.access_token, j.expires_in, requestEpoch);
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

  function setLogoutPending(pending) {
    logoutRetryPending = !!pending;
    try {
      if (pending) localStorage.setItem(LOGOUT_PENDING_KEY, "1");
      else localStorage.removeItem(LOGOUT_PENDING_KEY);
    } catch (e) { /* best effort when browser storage is unavailable */ }
  }

  function logoutPending() {
    if (logoutRetryPending) return true;
    try { return localStorage.getItem(LOGOUT_PENDING_KEY) === "1"; }
    catch (e) { return logoutRetryPending; }
  }

  async function requestServerLogout() {
    // Static/GIS deployments have no refresh cookie or logout endpoint.
    if (bffKnown === false) return true;
    try {
      const response = await fetch(AUTH_LOGOUT, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        keepalive: true,
      });
      if (response && response.ok) return true;
      if (bffKnown !== true && response && [404, 405, 501].includes(response.status)) {
        bffKnown = false;
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async function signOut() {
    // Credential caches are cleared synchronously before any fallible durable
    // preference write in Sync.disconnect or any network request here.
    credentialEpoch += 1;
    clearCachedToken();
    try { sessionStorage.removeItem(EMAIL_KEY); } catch (e) {}
    const tokenRequest = pending;
    pending = null;
    if (tokenRequest) tokenRequest.reject(new Error(NEEDS_AUTH));
    // Block every refresh path immediately, including while the logout POST is
    // still in flight. The durable marker remains set if that request fails.
    setLogoutPending(true);
    const ok = await requestServerLogout();
    setLogoutPending(!ok);
    return ok;
  }

  /** Retry a cookie logout recorded while offline, including after a reload. */
  async function retryPendingLogout() {
    if (!logoutPending()) return true;
    credentialEpoch += 1;
    clearCachedToken();
    try { sessionStorage.removeItem(EMAIL_KEY); } catch (e) {}
    const ok = await requestServerLogout();
    if (ok) setLogoutPending(false);
    return ok;
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
      const err = new Error(msg);
      err.status = res.status;
      if (res.status === 412) err.code = "drive-precondition-failed";
      throw err;
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

  function hasWebLocks() {
    return typeof navigator !== "undefined" && navigator.locks &&
      typeof navigator.locks.request === "function";
  }

  function randomWriterId() {
    const c = typeof crypto !== "undefined" ? crypto : null;
    if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "");
    if (c && typeof c.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    const err = new Error("Secure randomness is unavailable; Drive sync cannot safely create a writer shard.");
    err.code = "drive-secure-random-unavailable";
    throw err;
  }

  const validWriterId = (value) => /^[a-f0-9]{32}$/.test(String(value || ""));

  /** Share a persisted writer only when tabs can serialize the whole cycle. */
  function writerId() {
    if (runtimeWriterId) return runtimeWriterId;
    if (hasWebLocks()) {
      try {
        const saved = localStorage.getItem(WRITER_KEY);
        if (validWriterId(saved)) runtimeWriterId = saved;
        if (!runtimeWriterId) {
          runtimeWriterId = randomWriterId();
          localStorage.setItem(WRITER_KEY, runtimeWriterId);
        }
      } catch (e) {
        runtimeWriterId = randomWriterId();
      }
    } else {
      // Correctness beats shard count: pages without Web Locks never share a
      // file, and this random id remains stable for the life of this page.
      runtimeWriterId = randomWriterId();
    }
    return runtimeWriterId;
  }

  function shardName(id) {
    if (!validWriterId(id)) throw new Error("Invalid Drive writer id");
    return SHARD_PREFIX + id + SHARD_SUFFIX;
  }

  function recognizedName(name) {
    if (name === LEGACY_FILE_NAME) return { legacy: true, writerId: null };
    const match = /^nutridaily-shard-v4-([a-f0-9]{32})\.json$/.exec(String(name || ""));
    return match ? { legacy: false, writerId: match[1] } : null;
  }

  async function withWriterLock(callback) {
    const id = writerId();
    if (!hasWebLocks()) return callback(id);
    return navigator.locks.request(`nutridaily-drive-v4-${id}`, { mode: "exclusive" }, () => callback(id));
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).byteLength;
    return unescape(encodeURIComponent(text)).length;
  }

  function driveDataError(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function validateDoc(doc, name) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw driveDataError(`Drive file ${name} is not a JSON object. Nothing was changed.`, "drive-malformed-shard");
    }
    const version = doc.version == null ? 1 : Number(doc.version);
    if (!Number.isInteger(version) || version < 1) {
      throw driveDataError(`Drive file ${name} has an invalid schema version. Nothing was changed.`, "drive-malformed-shard");
    }
    if (version > 4) {
      const err = driveDataError("Drive data uses a newer app version. Update this app before syncing; local changes are preserved.", "drive-newer-schema");
      err.docVersion = version;
      throw err;
    }
    if (String(name).startsWith(SHARD_PREFIX) && version !== 4) {
      throw driveDataError(`Drive shard ${name} has the wrong schema version. Nothing was changed.`, "drive-malformed-shard");
    }
    const arrays = ["events", "personalFoods", "phases"];
    const objects = ["dayGoals", "dayPlans", "gapDrafts", "weights", "profile", "goals"];
    if (arrays.some((key) => doc[key] != null && !Array.isArray(doc[key])) ||
        objects.some((key) => doc[key] != null && (typeof doc[key] !== "object" || Array.isArray(doc[key])))) {
      throw driveDataError(`Drive file ${name} is malformed. Nothing was changed.`, "drive-malformed-shard");
    }
    for (const key of arrays) {
      if ((doc[key] || []).length > MAX_COLLECTION_ITEMS) {
        throw driveDataError(`Drive file ${name} has too many records. Nothing was changed.`, "drive-malformed-shard");
      }
    }
    for (const event of (doc.events || [])) {
      if (!event || typeof event !== "object" || Array.isArray(event) ||
          typeof event.id !== "string" || !event.id ||
          typeof event.ts !== "number" || !Number.isFinite(event.ts) || event.ts < 0) {
        throw driveDataError(`Drive file ${name} has an invalid event. Nothing was changed.`, "drive-malformed-shard");
      }
    }
    for (const key of ["personalFoods", "phases"]) {
      for (const item of (doc[key] || [])) {
        if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id) {
          throw driveDataError(`Drive file ${name} has an invalid ${key} record. Nothing was changed.`, "drive-malformed-shard");
        }
      }
    }
    for (const key of ["dayGoals", "dayPlans", "gapDrafts", "weights"]) {
      for (const item of Object.values(doc[key] || {})) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw driveDataError(`Drive file ${name} has an invalid ${key} record. Nothing was changed.`, "drive-malformed-shard");
        }
      }
    }
    for (const key of objects) {
      if (doc[key] && Object.keys(doc[key]).length > MAX_COLLECTION_ITEMS) {
        throw driveDataError(`Drive file ${name} has too many records. Nothing was changed.`, "drive-malformed-shard");
      }
    }
    const forbidden = new Set(["__proto__", "prototype", "constructor"]);
    let nodes = 0;
    const inspect = (value, depth) => {
      if (++nodes > 200000 || depth > 30) throw driveDataError(`Drive file ${name} is too complex. Nothing was changed.`, "drive-malformed-shard");
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw driveDataError(`Drive file ${name} contains a non-finite number. Nothing was changed.`, "drive-malformed-shard");
      }
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        if (value.length > MAX_COLLECTION_ITEMS) throw driveDataError(`Drive file ${name} has too many records. Nothing was changed.`, "drive-malformed-shard");
        for (const item of value) inspect(item, depth + 1);
        return;
      }
      for (const key of Object.keys(value)) {
        if (forbidden.has(key)) throw driveDataError(`Drive file ${name} contains an unsafe key. Nothing was changed.`, "drive-malformed-shard");
        const child = value[key];
        if (key === "ts" || key === "resetAt" || key === "goalsUpdatedAt" || /(?:created|updated|deleted)At$/i.test(key)) {
          if (typeof child !== "number" || !Number.isFinite(child) || child < 0) {
            throw driveDataError(`Drive file ${name} contains an invalid clock. Nothing was changed.`, "drive-malformed-shard");
          }
        }
        inspect(child, depth + 1);
      }
    };
    inspect(doc, 0);
    return doc;
  }

  async function listDataFiles(interactive) {
    const q = encodeURIComponent(
      `trashed=false and mimeType='${FILE_MIME}' and (` +
      `name='${LEGACY_FILE_NAME}' or name contains '${SHARD_PREFIX}')`
    );
    const fields = encodeURIComponent("nextPageToken,incompleteSearch,files(id,name,mimeType,trashed,size,modifiedTime,parents,appProperties,isAppAuthorized)");
    const files = [];
    let pageToken = "";
    let pages = 0;
    do {
      if (++pages > MAX_LIST_PAGES) {
        throw driveDataError("Drive returned too many data-file pages. Nothing was changed.", "drive-shard-limit");
      }
      const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const res = await gfetch(`${API}/files?q=${q}&fields=${fields}&pageSize=100${page}`, undefined, interactive);
      const body = await res.json();
      if (body.incompleteSearch) {
        throw driveDataError("Drive returned incomplete shard results. Nothing was changed.", "drive-incomplete-search");
      }
      for (const file of (body.files || [])) {
        const recognized = recognizedName(file && file.name);
        if (!recognized || file.mimeType !== FILE_MIME || file.trashed) continue;
        if (!recognized.legacy && (!file.isAppAuthorized || !file.appProperties ||
            file.appProperties[APP_SCHEMA_KEY] !== "4" ||
            file.appProperties[APP_WRITER_KEY] !== recognized.writerId ||
            !Array.isArray(file.parents) || file.parents.length !== 1)) {
          throw driveDataError(`Drive file ${file.name} has invalid NutriDaily metadata. Nothing was changed.`, "drive-malformed-shard");
        }
        files.push({ ...file, ...recognized });
        const shardCount = files.filter((item) => !item.legacy).length;
        const legacyCount = files.filter((item) => item.legacy).length;
        if (shardCount > MAX_SHARDS || legacyCount > 1) {
          throw driveDataError("Drive contains too many NutriDaily shards. Nothing was changed.", "drive-shard-limit");
        }
      }
      pageToken = String(body.nextPageToken || "");
    } while (pageToken);
    return files.sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
  }

  async function readCappedJson(file, interactive, aggregate) {
    const declared = Number(file.size || 0);
    if (Number.isFinite(declared) && declared > MAX_DOC_BYTES) {
      throw driveDataError(`Drive file ${file.name} is too large. Nothing was changed.`, "drive-document-too-large");
    }
    const res = await gfetch(`${API}/files/${encodeURIComponent(file.id)}?alt=media`, {
      headers: { Accept: FILE_MIME },
    }, interactive);
    const headerBytes = Number(res.headers.get("content-length") || 0);
    if (Number.isFinite(headerBytes) && headerBytes > MAX_DOC_BYTES) {
      throw driveDataError(`Drive file ${file.name} is too large. Nothing was changed.`, "drive-document-too-large");
    }
    let text;
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      const chunks = [];
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_DOC_BYTES || aggregate.bytes + bytes > MAX_AGGREGATE_BYTES) {
          try { await reader.cancel(); } catch (e) {}
          throw driveDataError("NutriDaily Drive data exceeds the safe read limit. Nothing was changed.", "drive-document-too-large");
        }
        chunks.push(decoder.decode(part.value, { stream: true }));
      }
      chunks.push(decoder.decode());
      text = chunks.join("");
      aggregate.bytes += bytes;
    } else {
      text = await res.text();
      const bytes = utf8Bytes(text);
      if (bytes > MAX_DOC_BYTES || aggregate.bytes + bytes > MAX_AGGREGATE_BYTES) {
        throw driveDataError("NutriDaily Drive data exceeds the safe read limit. Nothing was changed.", "drive-document-too-large");
      }
      aggregate.bytes += bytes;
    }
    let doc;
    try { doc = JSON.parse(text); }
    catch (e) { throw driveDataError(`Drive file ${file.name} contains invalid JSON. Nothing was changed.`, "drive-malformed-shard"); }
    return validateDoc(doc, file.name);
  }

  /** Read and validate every recognized shard before returning any document. */
  async function readShards(interactive) {
    const id = writerId();
    const ownName = shardName(id);
    const files = await listDataFiles(interactive);
    const ownFiles = files.filter((file) => file.name === ownName);
    if (ownFiles.length > 1) {
      throw driveDataError("Drive contains duplicate files for this browser writer. Nothing was changed.", "drive-duplicate-writer-shard");
    }
    const aggregate = { bytes: 0 };
    const docs = [];
    for (const file of files) {
      docs.push({ ...file, doc: await readCappedJson(file, interactive, aggregate) });
    }
    return { docs, ownFileId: ownFiles[0] ? ownFiles[0].id : null, writerId: id };
  }

  async function findByName(name, mime, interactive) {
    const q = encodeURIComponent(`name='${name}' and trashed=false` + (mime ? ` and mimeType='${mime}'` : ""));
    const res = await gfetch(`${API}/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=5`, undefined, interactive);
    const j = await res.json();
    return [...(j.files || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
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

  async function createShard(name, initialDoc, interactive) {
    const folderId = await ensureFolder(interactive);
    const idRes = await gfetch(`${API}/files/generateIds?count=1&space=drive&fields=ids`, undefined, interactive);
    const generatedId = (await idRes.json()).ids[0];
    if (!generatedId) throw driveDataError("Drive did not allocate a shard id.", "drive-create-failed");
    const id = writerId();
    const meta = {
      id: generatedId, name, parents: [folderId], mimeType: FILE_MIME,
      appProperties: { [APP_SCHEMA_KEY]: "4", [APP_WRITER_KEY]: id },
    };
    const boundary = "nd" + randomWriterId();
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(initialDoc)}\r\n--${boundary}--`;
    try {
      const res = await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      }, interactive);
      const createdId = (await res.json()).id;
      if (createdId !== generatedId) throw driveDataError("Drive returned the wrong shard id.", "drive-create-failed");
    } catch (err) {
      // A timed-out create can still have committed. The pre-generated id lets
      // us resolve that ambiguity without creating a duplicate shard.
      try {
        await verifyOwnShard({ id: generatedId, parents: [folderId] }, name, interactive);
      } catch (verifyErr) { throw err; }
    }
    await verifyWritten({ id: generatedId, name, parents: [folderId] }, initialDoc, interactive);
    return { fileId: generatedId, created: true };
  }

  async function verifyOwnShard(file, expectedName, interactive) {
    const fileId = file && file.id;
    const fields = encodeURIComponent("id,name,mimeType,trashed,parents,appProperties,isAppAuthorized");
    const res = await gfetch(`${API}/files/${encodeURIComponent(fileId)}?fields=${fields}`, undefined, interactive);
    const meta = await res.json();
    if (!meta || meta.id !== fileId || meta.name !== expectedName ||
        meta.mimeType !== FILE_MIME || meta.trashed || meta.isAppAuthorized === false ||
        (file.parents && (!Array.isArray(meta.parents) || meta.parents.length !== 1 || meta.parents[0] !== file.parents[0])) ||
        !meta.appProperties || meta.appProperties[APP_SCHEMA_KEY] !== "4" ||
        meta.appProperties[APP_WRITER_KEY] !== writerId()) {
      throw driveDataError("Drive refused to update a file that is not this browser's NutriDaily shard.", "drive-not-own-shard");
    }
    return meta;
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }

  async function verifyWritten(file, expected, interactive) {
    await verifyOwnShard(file, file.name || shardName(writerId()), interactive);
    const aggregate = { bytes: 0 };
    const actual = await readCappedJson({ ...file, name: file.name || shardName(writerId()) }, interactive, aggregate);
    if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
      throw driveDataError("Drive did not preserve the complete shard; local changes remain pending.", "drive-write-verification-failed");
    }
  }

  /** The caller holds the writer lock, so this writer's PATCH is unconditional. */
  async function writeOwnShard(file, doc, interactive) {
    const name = shardName(writerId());
    validateDoc(doc, name);
    const encoded = JSON.stringify(doc);
    if (utf8Bytes(encoded) > MAX_DOC_BYTES) {
      throw driveDataError("The merged NutriDaily document is too large to sync safely.", "drive-document-too-large");
    }
    if (!file) return createShard(name, doc, interactive);
    await verifyOwnShard(file, name, interactive);
    try {
      const res = await gfetch(`${UPLOAD}/files/${encodeURIComponent(file.id)}?uploadType=media&fields=id,modifiedTime`, {
        method: "PATCH",
        headers: { "Content-Type": FILE_MIME },
        body: encoded,
      }, interactive);
      const meta = await res.json();
      if (meta.id !== file.id) throw driveDataError("Drive returned the wrong shard id.", "drive-write-failed");
    } catch (err) {
      try {
        await verifyWritten(file, doc, interactive);
        return { fileId: file.id, created: false, recovered: true };
      } catch (verifyErr) { throw err; }
    }
    await verifyWritten(file, doc, interactive);
    return { fileId: file.id, created: false };
  }

  return {
    canUse, configured, onHttp, unavailableReason, getToken, silentBoot, refreshSession,
    cachedToken, beginLogin, signOut, retryPendingLogout, logoutPending,
    userEmail, readShards, writeOwnShard,
    withWriterLock, writerId, shardName,
    storedToken: cachedToken, clientId, NEEDS_AUTH, BFF_UNAVAILABLE,
    _internals: {
      LEGACY_FILE_NAME, SHARD_PREFIX, FILE_MIME, MAX_SHARDS, MAX_LIST_PAGES,
      MAX_DOC_BYTES, MAX_AGGREGATE_BYTES, LOGOUT_PENDING_KEY, recognizedName, validateDoc,
    },
  };
})();

if (typeof module !== "undefined") module.exports = GDrive;
