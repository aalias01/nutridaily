# NutriChat

A personal food diary. You build a library of dishes you cook, then log by picking a food and entering grams (or a serving). No in-app AI, no API key, no account with us.

Nutrition for new dishes comes from **ChatGPT** (your own subscription): copy a fixed prompt from the app, describe what you cooked, paste the reply back. The app parses a plain-text `NUTRI v1` block, you review it, and it becomes a reusable food with macros per 100 g.

## Run it

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

Or open the hosted URL if you have one. On a phone: Chrome install prompt, or iPhone Safari → Share → Add to Home Screen.

## First-time flow

1. Tap **+** (or **Add** on Foods) → **New food from ChatGPT paste**.
2. **Copy ChatGPT prompt**, paste it into ChatGPT, then describe your dish (ingredients and amounts, finished weight if you have it).
3. Copy ChatGPT’s reply into the app → **Import** → review macros → **Save food**.
4. On Today, tap **+**, pick the food, enter grams (or serving / piece / batch), save.

Repeat for each dish you cook. Day-to-day logging stays offline and free.

## What gets tracked

Per food (per 100 g): calories, protein, carbs, fat, fiber, sodium. Daily goals and rings for the first five; sodium as a number. Insights chart logged days and top calorie contributors.

## Your data

Lives in this browser. Optional Google Drive backup (a visible file: `NutriChat/nutrichat-data.json`). Export / import JSON anytime in Settings. Past log lines keep their macros even if you later update a recipe.

## Enable cloud backup (optional)

About five minutes. Free for personal use.

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project → enable **Google Drive API**.
2. OAuth consent screen → External → app name + your email. In Testing mode, add each user’s Gmail under Test users.
3. Credentials → OAuth client ID → **Web application**. Authorized JavaScript origins: `http://localhost:8080` and your deploy URL (e.g. `https://your-app.vercel.app`).
4. Paste the Client ID under Settings → Developer, or set `GOOGLE_CLIENT_ID` on Vercel (see Deploy) so the build injects it into `js/config.js`.

## Deploy your own

Static files. Vercel / any static host. This repo’s `vercel.json` runs `npm run build` (Client ID inject) before publish.

```bash
vercel env add GOOGLE_CLIENT_ID production
npx vercel --prod
```

After code changes, bump the `CACHE` name in `sw.js` (or hard-refresh) so installed PWAs pick up the new build.

## Tests

```bash
npm test
# or: node tests/test-core.js && node tests/test-parse.js
```

## License

MIT. See [LICENSE](LICENSE).
