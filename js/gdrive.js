/* NutriDaily — Google account + Drive storage (BYO cloud).
 * Uses Google Identity Services token flow (client-side only, no app server).
 * Scope drive.file: the app can ONLY see files it created — one JSON doc
 * in a visible "NutriDaily" folder in the USER'S OWN Drive.
 */
const GDrive = (() => {
  const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
  const FILE_NAME = "nutridaily-data.json";
  const FOLDER_NAME = "NutriDaily";
  const TOKEN_KEY = "nd_gtoken_v1"; // sessionStorage: token survives reloads, not browser restarts

  let tokenClient = null;
  let pending = null; // {resolve, reject} for the in-flight token request

  function clientId() {
    return (localStorage.getItem("nd_gclient") || "").trim() || ((window.ND_CONFIG || {}).googleClientId || "").trim();
  }
  const libReady = () => !!(window.google && google.accounts && google.accounts.oauth2);
  const onHttp = () => location.protocol === "http:" || location.protocol === "https:";
  const configured = () => !!clientId();
  const canUse = () => onHttp() && configured();

  /** Why Drive sign-in is unavailable, or null if usable. */
  function unavailableReason() {
    if (!onHttp()) return "Google sign-in needs the app served over http(s). Run: python3 -m http.server 8080 — or open the hosted URL.";
    if (!configured()) return "No OAuth Client ID configured. Add one in Settings (see README).";
    if (!libReady()) return "Google sign-in library is still loading — try again in a moment.";
    return null;
  }

  function initClient() {
    if (tokenClient || !libReady() || !configured()) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPE,
      callback: (resp) => {
        const p = pending; pending = null;
        if (!p) return;
        if (resp && resp.access_token) {
          const tok = { token: resp.access_token, exp: Date.now() + (Number(resp.expires_in || 3500) - 60) * 1000 };
          sessionStorage.setItem(TOKEN_KEY, JSON.stringify(tok));
          p.resolve(tok.token);
        } else p.reject(new Error((resp && resp.error) || "Sign-in failed"));
      },
      error_callback: (err) => {
        const p = pending; pending = null;
        if (p) p.reject(new Error((err && err.type) === "popup_closed" ? "Sign-in cancelled" : "Sign-in failed: " + ((err && err.type) || "unknown")));
      },
    });
  }

  function storedToken() {
    try {
      const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
      return t && t.exp > Date.now() ? t.token : null;
    } catch (e) { return null; }
  }

  /** Get an access token. interactive=true may open Google's popup (call from a click). */
  function getToken(interactive) {
    const t = storedToken();
    if (t) return Promise.resolve(t);
    const reason = unavailableReason();
    if (reason) return Promise.reject(new Error(reason));
    initClient();
    if (!tokenClient) return Promise.reject(new Error("Sign-in not ready"));
    if (pending) return Promise.reject(new Error("Sign-in already in progress"));
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      try { tokenClient.requestAccessToken({ prompt: interactive ? "" : "none" }); }
      catch (e) { pending = null; reject(e); }
    });
  }

  function signOut() {
    const t = storedToken();
    sessionStorage.removeItem(TOKEN_KEY);
    if (t && libReady()) { try { google.accounts.oauth2.revoke(t, () => {}); } catch (e) {} }
  }

  // ---------- authorized fetch ----------
  async function gfetch(url, opts, interactive) {
    let token = await getToken(!!interactive);
    let res = await fetch(url, withAuth(opts, token));
    if (res.status === 401) { // token stale → one silent retry
      sessionStorage.removeItem(TOKEN_KEY);
      token = await getToken(false);
      res = await fetch(url, withAuth(opts, token));
    }
    if (!res.ok) {
      let msg = `Drive error ${res.status}`;
      try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
      throw new Error(msg);
    }
    return res;
  }
  const withAuth = (opts = {}, token) => ({ ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });

  async function userEmail() {
    const res = await gfetch("https://www.googleapis.com/oauth2/v3/userinfo");
    const j = await res.json();
    return j.email || "";
  }

  // ---------- Drive file ops (drive.file scope) ----------
  const API = "https://www.googleapis.com/drive/v3";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

  async function findByName(name, mime) {
    const q = encodeURIComponent(`name='${name}' and trashed=false` + (mime ? ` and mimeType='${mime}'` : ""));
    const res = await gfetch(`${API}/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=5`);
    const j = await res.json();
    return (j.files || [])[0] || null;
  }

  async function ensureFolder() {
    const found = await findByName(FOLDER_NAME, "application/vnd.google-apps.folder");
    if (found) return found.id;
    const res = await gfetch(`${API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    });
    return (await res.json()).id;
  }

  /** Find the data file, or create it with initialDoc. Returns { fileId, created }. */
  async function ensureFile(initialDoc) {
    const found = await findByName(FILE_NAME);
    if (found) return { fileId: found.id, created: false };
    const folderId = await ensureFolder();
    const meta = { name: FILE_NAME, parents: [folderId], mimeType: "application/json" };
    const boundary = "ncb" + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(initialDoc)}\r\n--${boundary}--`;
    const res = await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return { fileId: (await res.json()).id, created: true };
  }

  async function readFile(fileId) {
    const res = await gfetch(`${API}/files/${fileId}?alt=media`);
    return res.json();
  }

  async function writeFile(fileId, doc) {
    await gfetch(`${UPLOAD}/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
  }

  return { canUse, configured, onHttp, unavailableReason, getToken, signOut, userEmail, ensureFile, readFile, writeFile, storedToken };
})();

if (typeof module !== "undefined") module.exports = GDrive;
