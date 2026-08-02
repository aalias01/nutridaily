# NutriDaily

A personal nutrition tracker. You build a library of dishes you cook, then log by picking a food and entering grams (or a serving). No in-app AI, no API key, no account with us.

Nutrition for new dishes comes from **ChatGPT** (your own subscription): copy a fixed prompt from the app, describe what you cooked, paste the reply back. The app parses a plain-text `NUTRI v1` block, you review it, and it becomes a reusable food with macros per 100 g.

**Live app:** [https://nutridaily.vercel.app](https://nutridaily.vercel.app)

## Track without signing in

Logging works fully offline in this browser. Google Sign-in is **optional**. Use it only if you want a copy in **your** Google Drive so a second device (or a cleared browser / reinstall) can restore your log. Clearing this site’s data deletes the local copy unless you signed in or exported a backup.

## Run it

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

Or open the hosted URL. Install from Settings → **Home screen** (Chrome Install, or iPhone Safari → Share → Add to Home Screen).

## First-time flow

1. Tap **+** (or **Add** on Foods) → **New food from ChatGPT paste**.
2. **Copy ChatGPT prompt**, paste it into ChatGPT, then describe your dish.
3. Copy ChatGPT’s reply into the app → **Import** → review macros → **Save food**.
4. On Today, tap **+**, pick the food, enter grams (or serving / piece / batch), save.

## What gets tracked

Per food (per 100 g): calories, protein, carbs, fat, fiber, sodium. Daily goals and rings. Insights for logged days. Appearance: Settings → Mode (`auto` / `light` / `dark`). Default is light.

## Your data

Lives in this browser. Optional Google Drive backup (`NutriDaily/nutridaily-data.json`). Export / import JSON in Settings. Past log lines keep their macros if you later update a recipe.

After reopening the installed app (especially on iPhone), Drive may pause until you tap **Reconnect** on the banner or the header sync pill. A Hide on that banner lasts for the rest of the calendar day. Meals still save locally meanwhile.

## Google Drive setup (Daycells-style)

About five minutes. Free for personal use. On the live deploy, a Google OAuth Client ID is injected at build time via `GOOGLE_CLIENT_ID`. If your Gmail is on the project’s **test users** list, open Settings and tap **Sign in with Google**. A Google popup appears. No Client ID paste needed.

Forks and your own deploys: leave committed `js/config.js` empty. Create your own Client ID (steps below), then either set `GOOGLE_CLIENT_ID` on Vercel or paste it under Settings → **Advanced: override Client ID**.

### Create a Client ID

1. Open [console.cloud.google.com](https://console.cloud.google.com) → create or pick a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **Google Auth Platform** (OAuth):
   - **Branding:** app name `NutriDaily` + your email.
   - **Audience:** External. Stay in **Testing**. Under **Test users**, add every Gmail that should sign in.
4. **Clients → Create client → Web application.**
   - Authorized JavaScript origins (no path, no trailing slash):
     - `https://nutridaily.vercel.app`
     - `http://localhost:8080`
   - Leave **Authorized redirect URIs** empty (popup token flow, same as Daycells).
   - Create. Copy the **Client ID** only (`….apps.googleusercontent.com`). Ignore the Client Secret.
5. Wire the Client ID:
   - **Vercel:** Project → Settings → Environment Variables → `GOOGLE_CLIENT_ID` (Production) → Redeploy.
   - **Or** Settings → Advanced → paste Client ID → Sign in with Google.
6. Confirm Drive has folder **NutriDaily** / file **nutridaily-data.json**.

### Data Access (scopes)

Register: `.../auth/userinfo.email` and `.../auth/drive.file`. When signing in, grant Drive access (granular consent may show Drive unchecked by default).

### Testing vs publish

Stay in **Testing** for household use. One Client ID is enough; each person signs in with their own Gmail and gets their own Drive file.

## Deploy your own

```bash
vercel env add GOOGLE_CLIENT_ID production
npx vercel --prod
```

After code changes, bump the `CACHE` name in `sw.js` (or hard-refresh) so installed PWAs pick up the new build.

## Tests

```bash
npm test
```

## License

MIT. See [LICENSE](LICENSE).
