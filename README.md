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

Per food (per 100 g): calories, protein, carbs, fat, fiber, sodium, potassium. Daily goals and rings. Before logging your first food, **Day plan** lets you keep the phase target, set an absolute calorie target from 200–6,000 kcal, or declare a zero-calorie fast (for today, or plan tomorrow from today). Up to five presets can be saved and reapplied one day at a time; nothing auto-schedules future days. The target and its phase baseline are frozen, and a reduced plan stays locked after the first-ever add event even if that food is deleted. Targets below 1,200 kcal show a clinician-supervision warning. Once a day has ever been logged, regular phase-target changes begin the next day. Day plans never change protein, fiber, sodium, or potassium floors and ceilings; carbs and fat follow the day's calorie plan so the macros still add up. Body weight shows a smoothed trend and weekly rate next to the entry field, so a heavy morning doesn't read as a heavy week. Appearance: Settings → Mode (`auto` / `light` / `dark`). Default is light.

### Sodium and potassium

Sodium and potassium both matter for blood pressure, and their **molar Na:K ratio** is a useful supporting signal. It does not replace either nutrient's independent target. A five-year trial of potassium-enriched salt in ~21,000 older, high-risk participants found fewer strokes, cardiovascular events, and deaths; that trial tested a salt substitute in a specific population, not this app's ratio score.

The supporting ratio target is at or below **1.0**, while sodium still has its own ceiling and potassium its own floor. Watch the units: mass and molar ratios differ by a factor of 1.70 because potassium's atomic mass is 70% higher. The app stores milligrams and shows molar. WHO's 2,000 mg sodium / 3,510 mg potassium works out to 0.97.

**Sodium and potassium are both nullable, and that matters.** A food with either value unrecorded stays blank rather than defaulting to zero, because "contains none" and "not measured" are different claims. Each absolute nutrient has independent completeness. The ratio uses only entries where both Na and K are known, so separately known subsets are never divided. It is shown only when the same paired entries satisfy the app's conservative **80% coverage heuristic**: at least 80% by both calorie share and item share (the lower share wins, so zero-calorie unknown items still count). This 80% cutoff is an app heuristic for honest display, not a clinical guideline.

The card also names which lever to pull, and deliberately not by picking whichever milligram gap is smaller: adding a food is easier to sustain than stripping salt out of meals you already eat. If sodium is already inside its own limit, the gap is on the potassium side regardless of which number looks bigger.

> Kidney disease and medicines such as ACE inhibitors, ARBs, and potassium-sparing diuretics can raise potassium dangerously. Ask a clinician before deliberately increasing potassium or using supplements or potassium salt substitutes.

Targets have shapes, and the app is consistent about them: **protein, fiber, and potassium are floors** (minimums), **sodium and the Na:K ratio are ceilings** (lower is better), and **calories, carbs and fat are ranges**. The headline has exactly one 10% mineral-composite slot: with joint paired coverage it requires the sodium ceiling, potassium floor, and ratio together; without joint coverage it scores only when both absolute Na and K are independently complete, and then requires both. Otherwise the mineral slot is skipped and the remaining weights are renormalized, either because coverage is incomplete for that day, or because a very low-calorie day plan makes that target arithmetically incoherent and exempts it outright; a range mixing both reasons still discloses how many days were exempt rather than silently dropping the slot. Today flags the moment you pass a number, and says whether you are slightly over or past the tolerance band: the amber zone is exactly what Insights scores as on target.

New installations use a configurable generic adult potassium reference of **3,510 mg** (the WHO adult reference), not an individualized prescription. Existing saved targets are preserved; the app does not infer medical personalization.

## Insights

Everything is derived on device from your own log: no server, no model, no guesswork you can't inspect.

Nutrient scope is one control: a docked pill row at the bottom of the Insights tab (Kcal, Protein, Carbs, Fat, Fiber, Na, K). The intake chart and the panels that live with it follow that dock. There is no second nutrient selector.

Order on the tab:

- **Headline score**: a 0–100 number blending logging consistency, target hit rate, and protein specifically, plus average calories, weight trend and streak. A range with too few real scored days behind a target (whether because every cell was exempt or because there just isn't enough data yet) shows "No data yet" instead of a number rather than crediting an unjustified perfect off a single day propped up by consistency credit alone.
- **Observations**: a short triage list under the headline (a few notes, honesty flags always shown). Notes that own a panel can jump you there; they report what the numbers say and never grade you on it.
- **Intake (selected nutrient)**: daily bars or weekly averages against that day's own target, with the hit band shaded and a 7-day rolling mean drawn on top. Tap any bar for the detail. Also: median, typical swing, range, and the last 7 days versus the 7 before. The logging calendar, day-of-week pattern, and top foods for the same nutrient sit here rather than under a separate "breakdown" section.
- **Weight**: raw weigh-ins as dots with a gap-aware EMA trend line through them, rate per week from a regression on the weigh-ins, and a 4-week projection. Placed above energy so the TDEE card can narrate the chart.
- **Energy expenditure**: an adaptive TDEE estimate: average intake minus what your weight trend actually did (7700 kcal/kg). Comes with the intake needed to lose 0.5 / 0.25 kg per week, maintain, or gain. Shown only when there is enough data; otherwise the card says exactly what is missing rather than printing a confident-looking number.
- **Adherence**: a per-nutrient scorecard with under / on-target / over bars (streaks still appear with the headline and the logging calendar).
- **Composition**: macro split as a share of calories against the split your targets imply, calories by meal, and the Na/K card when coverage is honest enough.
- **Phase comparison**: where a previous phase exists, score, logging, calorie target, weight rate and target hit rates side by side. Calorie average and weight rate are shown without a verdict, because faster loss is progress in a cut and a problem in a bulk.

On a brand-new or very thin log, Insights stays quiet on purpose: energy and composition wait until a few days exist rather than stacking eight "not enough data" cards.

It also tells you when the numbers deserve less trust: days logged with one small entry are flagged as possible unfinished logs (still counted, with the alternative average shown), and calorie heatmaps mark days that used a day plan. Declared low-calorie days and declared fasts are user-stamped, not inferred: they stay out of unfinished-log flags and out of eating-day averages; when a low plan makes a floor or ceiling arithmetically incoherent, that nutrient is left unscored and disclosed rather than quietly dropped; fasts count toward consistency at zero calories and are included in the TDEE intake average as zero; and a declaration made after the day ended is reported rather than quietly rewritten. Because a reduced plan locks after the first logged food, it cannot be added later to turn an over-target result into a hit.

Numbers are estimates from logged data. Nothing here is medical advice; talk to a clinician or dietitian for anything that matters.

## Your data

Lives in this browser. Optional Google Drive backup in `NutriDaily/` uses one `nutridaily-shard-v4-<writer-id>.json` file per browser installation. Export / import JSON in Settings.

**Editing a food does not rewrite history.** Every log line stores the macros and food version it was saved with, so correcting or changing a recipe applies from that point on: past days stay as they were logged. That is what you want when a recipe genuinely changed; if you had a number wrong all along and want an old day fixed, edit that entry directly on the day.

New add, amend, remove, and Undo-restore events also store a per-entry causal sequence and parent event. Replay follows that logical chain rather than device clocks; concurrent amendments merge in a canonical order, removal wins a concurrent amendment, and only a later restore starts a live generation again. Older events without causal metadata remain readable through a deterministic fallback: the originating add is anchored first, then the remaining legacy events are ordered by timestamp, event id, and canonical payload.

On the live Vercel deploy, sign-in uses a small auth API that stores a Google **refresh token** in an httpOnly cookie, so Pixel/iPhone home-screen apps can stay connected across reopen without tapping Reconnect. Drive data itself goes directly between the browser and Google. Each installation writes only its own shard; sync reads every recognized shard and deterministically merges them, so devices never PATCH the same file. The old `nutridaily-data.json` is read as migration input but is never modified. Disconnect clears browser credentials first; if the server-cookie logout cannot finish offline, a durable pending marker blocks silent re-auth and retries the logout after connectivity returns. Meals always keep working locally if Drive ever pauses (revoked access, cleared site data, or Google Testing refresh expiry). A Hide on the reconnect banner lasts for the rest of the calendar day.

Clear/import generations are causal privacy boundaries. New records carry the current reset generation, while edits retain the generation of the identity they change; a later reset removes the whole older identity even if a stale device gives a descendant a newer wall clock. A one-time schema-marked migration upgrades released v4 snapshots that predate per-record generations: rows provably older than that snapshot's own reset stay discarded, while its current rows are stamped locally before any cross-device filtering. Once marked, every record and causal event component must exactly match its document generation or the shard is rejected before merge. Legacy generation-zero data still syncs normally before the first reset. Sync tolerates up to five minutes of ordinary device-clock drift. A reset or record clock farther in the future pauses that writer before filtering, local apply, or any Drive write and asks you to correct the device clock.

The browser stores a random 128-bit writer id locally. NutriDaily requires **Web Locks** and claims one origin-wide exclusive app lock before it reads or changes the nutrition log; a second tab stays on a blocking screen instead of racing the first. Browsers without Web Locks fail closed with update/switch-browser guidance. If the browser restores a page from its back/forward cache, that old page is made inert and reloaded before it can resume. Use a current browser and keep one NutriDaily tab open at a time.

Remote applies, imports, Clear logs, and Start fresh use the same rollback boundary: the app snapshots the live values and exact local storage records, writes the replacement data, and commits the privacy-schema marker and then the reset marker last. A failed local write restores the previous ledger, foods, settings, schema marker, and reset marker and does not publish a Drive update.

## Google Drive setup (full reference)

About five minutes. Free for personal use. On [nutridaily.vercel.app](https://nutridaily.vercel.app), skip to Sign in if you are already a test user.

Forks and your own deploys: leave committed `js/config.js` empty. Create your own OAuth client (steps below). Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `AUTH_SECRET` on Vercel for refresh-cookie sign-in, or paste a Client ID under Settings → Advanced for the Google Identity Services popup fallback. Both modes have safe full Drive read/write sync because writers use independent shards; no data-sync backend or extra OAuth scope is required.

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
6. Confirm Drive has folder **NutriDaily** and a `nutridaily-shard-v4-….json` file. An existing **nutridaily-data.json** may remain as read-only migration input. On another device: same Google account → **Sign in with Google** once.
7. **Forks / static-only hosts:** without `GOOGLE_CLIENT_SECRET` + `AUTH_SECRET`, Sign in falls back to the older Google Identity Services popup (session access token only; it may ask you to Reconnect after a PWA reopen). Advanced → override Client ID supports full direct Drive read/write sync on a static host.

### Data Access (scopes)

Register: `.../auth/userinfo.email` and `.../auth/drive.file`. When signing in, grant Drive access (granular consent may show Drive unchecked by default). NutriDaily requires Drive; if you continue without it, sign-in is rejected and sync will not enable.

To register scopes:

1. Google Auth Platform → **Data Access** → **Add or remove scopes**.
2. Filter `userinfo` → check `.../auth/userinfo.email`. Filter `drive.file` → check `.../auth/drive.file`.
3. Click **Update** on the side panel, then **Save** on the main Data Access page.

### Testing vs publish

Stay in **Testing** for household use. One Client ID is enough; each person signs in with their own Gmail and gets shards in their own Drive. Each browser gets its own refresh cookie after Sign in; testers benefit from always-connected sync the same way you do.

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

Use the localhost origin/redirect URI you registered (often `http://localhost:3000`). Static-only `python3 -m http.server 8080` also supports full Drive read/write through the GIS popup fallback, but it has no refresh cookie and may require Reconnect after reopening.

## Troubleshoot

- Redirect / origin error: add the exact origin under Authorized JavaScript origins and `https://nutridaily.vercel.app/api/auth/callback` under Authorized redirect URIs.
- "Sign-in is not configured": set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `AUTH_SECRET` on Vercel and redeploy.
- Access blocked: add that Gmail under Audience → Test users, or publish the OAuth app.
- Google did not return a refresh token: Google Account → [Third-party access](https://myaccount.google.com/connections) → remove NutriDaily, then Sign in again (consent must include Drive).
- **"Google Drive permission was not granted"**: Sign in again and check the Google Drive permission on the consent screen.
- Drive sync paused after reopen: with BFF env set, reopen should refresh quietly. If it still pauses (Testing ~7-day refresh expiry, cleared site data, or revoked access), meals still save locally; tap **Reconnect**.
- Too many or malformed Drive shards: NutriDaily fails closed without applying or overwriting anything. Export the local copy, then inspect the `NutriDaily` folder before removing any file.
- Stale UI after deploy: bump `sw.js` CACHE or hard-refresh (reopen the home-screen app if installed).

## Tests

```bash
npm test          # core, parser, analytics: no dependencies

npm install --no-save jsdom
npm run test:ui   # boots index.html headless and exercises the Insights tab
```

## License

Copyright © 2026 Alvin Alias. Portfolio project. Source is available for viewing and personal/non-commercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use requires prior written permission.
