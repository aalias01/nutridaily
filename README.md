# NutriDaily

A personal nutrition tracker. You build a library of dishes you cook, then log by picking a food and entering grams (or a serving). No in-app AI, no API key, no account with us.

Nutrition for new dishes comes from an **AI paste** (your own ChatGPT, Claude, or other LLM): copy a fixed prompt from the app, describe what you cooked, paste the reply back. The app parses a plain-text `NUTRI v1` block, you review it, and it becomes a reusable food with macros per 100 g. Common foods show as **Reference · USDA-style avg**; your dishes show as **Yours**.

**Live app:** [https://nutridaily.vercel.app](https://nutridaily.vercel.app)

## Track without signing in

Logging works fully offline in this browser. Google Sign-in is **optional**. Use it only if you want a copy in **your** Google Drive so a second device (or a cleared browser / reinstall) can restore your log. Clearing this site’s data deletes the local copy unless you signed in or exported a backup.

## Run it

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

Or open the hosted URL. Install from Settings → **Home screen** (Chrome Install, or iPhone Safari → Share → Add to Home Screen).

For always-connected Drive auth locally, prefer `npx vercel dev` (see Deploy below) so `/api/auth/*` is available.

## First-time flow

**Common foods (no AI needed):** Today → **+** → pick from **Common foods** (banana, apple, eggs, rice, …) or search the catalog → enter grams / pieces → Save. First pick copies it into My Foods. Tap **Edit food** to change macros or name. Catalog values are USDA-style averages (good defaults, not brand-specific); override anytime.

**Homemade dishes:**

1. Tap **+** → **Homemade dish (AI paste)**.
2. **Copy AI prompt**, paste it into ChatGPT / Claude / any LLM, then describe your dish.
3. Copy the reply into the app → **Import** → review macros → **Save food**.
4. Log it anytime with grams or a serving.

## What gets tracked

Per food (per 100 g): calories, protein, carbs, fat, fiber, sodium. Daily goals and rings. Appearance: Settings → Mode (`auto` / `light` / `dark`). Default is light.

## Insights

Everything is derived on device from your own log — no server, no model, no guesswork you can't inspect.

- **Headline score** — one 0–100 number blending logging consistency, target hit rate, and protein specifically, plus average calories, weight trend and streak.
- **Intake chart** — daily bars or weekly averages against that day's own target, with the hit band shaded and a 7-day rolling mean drawn on top. Tap any bar for the detail. Also: median, typical swing, range, and the last 7 days versus the 7 before.
- **Energy expenditure** — an adaptive TDEE estimate: average intake minus what your weight trend actually did (7700 kcal/kg). Comes with the intake needed to lose 0.5 / 0.25 kg per week, maintain, or gain. Shown only when there is enough data; otherwise the card says exactly what is missing rather than printing a confident-looking number.
- **Weight** — raw weigh-ins as dots with a gap-aware EMA trend line through them, rate per week from a regression on the weigh-ins, and a 4-week projection.
- **Consistency** — a calendar heatmap coloured by how each day landed against target, streaks, weekday-versus-weekend logging rates, and a per-nutrient scorecard with under / on-target / over bars.
- **Breakdown** — macro split as a share of calories against the split your targets imply, calories by meal, day-of-week pattern (where weekend drift shows up), and top foods rankable by calories, protein, sodium or fiber.

Observations under the headline are descriptive only — they report what the numbers say and never grade you on it.

Numbers are estimates from logged data. Nothing here is medical advice; talk to a clinician or dietitian for anything that matters.

## Your data

Lives in this browser. Optional Google Drive backup (`NutriDaily/nutridaily-data.json`). Export / import JSON in Settings. Past log lines keep their macros if you later update a recipe.

On the live Vercel deploy, sign-in uses a small auth API that stores a Google **refresh token** in an httpOnly cookie, so Pixel/iPhone home-screen apps can stay connected across reopen without tapping Reconnect. Meals always keep working locally if Drive ever pauses (revoked access, cleared site data, or Google Testing refresh expiry). A Hide on the reconnect banner lasts for the rest of the calendar day.

## Google Drive setup (full reference)

About five minutes. Free for personal use. On [nutridaily.vercel.app](https://nutridaily.vercel.app), skip to Sign in if you are already a test user.

Forks and your own deploys: leave committed `js/config.js` empty. Create your own OAuth client (steps below), set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `AUTH_SECRET` on Vercel for always-connected sync, or paste a Client ID under Settings → Advanced for the older popup fallback.

### Create a Client ID

1. Open [console.cloud.google.com](https://console.cloud.google.com) → create or pick a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **Google Auth Platform** (OAuth):
   - **Branding:** app name `NutriDaily` + your email.
   - **Audience:** External. Stay in **Testing**. Under **Test users**, add every Gmail that should sign in (you, spouse, etc.; Testing allows up to 100). Save.
4. **Clients → Create client → Web application.**
   - Authorized JavaScript origins (no path, no trailing slash):
     - `https://nutridaily.vercel.app`
     - `http://localhost:3000` for `vercel dev` (and `http://localhost:8080` if you still use a static server + GIS fallback)
   - **Authorized redirect URIs** (required for always-connected auth):
     - `https://nutridaily.vercel.app/api/auth/callback`
     - `http://localhost:3000/api/auth/callback` for local `vercel dev`
   - Create. Copy the **Client ID** (`….apps.googleusercontent.com`) and the **Client Secret**. Never commit the secret or paste it into the browser UI.
5. Wire env on **Vercel** (Project → Settings → Environment Variables, Production):
   - `GOOGLE_CLIENT_ID` = Client ID (also injected into `js/config.js` at build)
   - `GOOGLE_CLIENT_SECRET` = Client Secret (server-only; used by `/api/auth/*`)
   - `AUTH_SECRET` = a long random string (e.g. `openssl rand -hex 32`) used to encrypt the refresh cookie
   - Redeploy. Do not commit filled `js/config.js`.
6. Confirm Drive has folder **NutriDaily** / file **nutridaily-data.json**. On another device: same Google account → **Sign in with Google** once.
7. **Forks / static-only hosts:** without `GOOGLE_CLIENT_SECRET` + `AUTH_SECRET`, Sign in falls back to the older Google Identity Services popup (session access token only; may ask to Reconnect after PWA reopen). Advanced → override Client ID still helps that fallback path.

### Data Access (scopes)

Register: `.../auth/userinfo.email` and `.../auth/drive.file`. When signing in, grant Drive access (granular consent may show Drive unchecked by default). NutriDaily requires Drive; if you continue without it, sign-in is rejected and sync will not enable.

To register scopes:

1. Google Auth Platform → **Data Access** → **Add or remove scopes**.
2. Filter `userinfo` → check `.../auth/userinfo.email`. Filter `drive.file` → check `.../auth/drive.file`.
3. Click **Update** on the side panel, then **Save** on the main Data Access page.

### Testing vs publish

Stay in **Testing** for household use. One Client ID is enough; each person signs in with their own Gmail and gets their own Drive file. Each browser gets its own refresh cookie after Sign in; testers benefit from always-connected sync the same way you do.

**Testing refresh tokens:** while the OAuth app stays in Testing, Google may expire refresh tokens after about **7 days**. Users then tap Sign in / Reconnect once more. Publishing the OAuth app (when you are ready) removes that Testing limit.

## Deploy your own

```bash
vercel env add GOOGLE_CLIENT_ID production
vercel env add GOOGLE_CLIENT_SECRET production
vercel env add AUTH_SECRET production
npx vercel --prod
```

After code changes, bump the `CACHE` name in `sw.js` (or hard-refresh) so installed PWAs pick up the new build.

Local with auth API (`vercel dev`, recommended):

```bash
npx vercel dev
```

Use the localhost origin/redirect URI you registered (often `http://localhost:3000`). Static-only `python3 -m http.server 8080` still works for UI work, but Sign in then uses the GIS fallback (no refresh cookie) unless the BFF is running.

## Troubleshoot

- Redirect / origin error: add the exact origin under Authorized JavaScript origins and `https://nutridaily.vercel.app/api/auth/callback` under Authorized redirect URIs.
- "Sign-in is not configured": set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `AUTH_SECRET` on Vercel and redeploy.
- Access blocked: add that Gmail under Audience → Test users, or publish the OAuth app.
- Google did not return a refresh token: Google Account → [Third-party access](https://myaccount.google.com/connections) → remove NutriDaily, then Sign in again (consent must include Drive).
- **"Google Drive permission was not granted"**: Sign in again and check the Google Drive permission on the consent screen.
- Drive sync paused after reopen: with BFF env set, reopen should refresh quietly. If it still pauses (Testing ~7-day refresh expiry, cleared site data, or revoked access), meals still save locally; tap **Reconnect**.
- Stale UI after deploy: bump `sw.js` CACHE or hard-refresh (reopen the home-screen app if installed).

## Tests

```bash
npm test          # core, parser, analytics — no dependencies

npm install --no-save jsdom
npm run test:ui   # boots index.html headless and exercises the Insights tab
```

## License

MIT. See [LICENSE](LICENSE).
