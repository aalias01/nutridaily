# NutriDaily

Log home-cooked dishes by food and grams (or a serving).

**[Live app →](https://nutridaily.vercel.app)**

Homemade recipes enter through a **NUTRI import**. I copy a fixed prompt from the app into ChatGPT or Claude, describe the dish, paste the reply back. The app reads a plain-text `NUTRI v1` block, I review macros, and it saves into My Foods (per 100 g). Catalog staples (banana, eggs, rice, and the rest) are Reference USDA-style averages. The app never calls an LLM itself.

## Logging

Works offline in the browser. Google Sign-in is optional: a Drive backup under the account you sign in with, so a second phone or a restored browser can pick up the same log.

Ways in:

- Common foods or My Foods, then grams or a serving.
- **Log once** when the meal should not enter My Foods: name, portion, calories. Leave macros closed for calories only, or open them when I know protein, carbs, and fat. Calories always count. Incomplete macros stay out of scoring instead of pretending to be zero. The same sheet has an Estimate-with-AI prompt for restaurant or label guesses (same paste-and-review path). Nothing lands in My Foods unless I later save a weighed entry there.
- **Homemade dish (NUTRI import)** when I want a lasting recipe in the library.

When known, each food carries calories, protein, carbs, fat, fiber, sodium, and potassium. Today shows daily goals and rings. Weight has a smoothed trend and weekly rate next to the entry field, so one heavy morning does not read as a heavy week. Appearance is light, dark, or auto. Installable to the home screen from Settings.

## Day plan, Fast, incomplete days

Before the first food of the day I can keep the phase target, set an absolute calorie target (200–6,000 kcal), or declare a zero-calorie **Fast** (today, or plan tomorrow from today). Up to five presets, reapplied one day at a time. Nothing auto-schedules future days. Targets below 1,200 kcal show a clinician-supervision warning. Day plans move calories (and the carbs/fat that follow them); protein, fiber, sodium, and potassium floors and ceilings stay put.

**Mark incomplete** keeps the diary visible and drops that day from Insights averages and TDEE until I clear the mark. Declared fasts and reduced plans are stamped by me, not inferred from how little I ate.

Editing a food later does not rewrite history. Each diary line keeps the macros it was saved with.

## Sodium, potassium, Na:K

Both nutrients matter for blood pressure. The app also shows a molar Na:K ratio as a supporting signal (at or below 1.0). It does not replace sodium's ceiling or potassium's floor. Unrecorded values stay blank instead of becoming zero, and the ratio only appears when paired coverage is honest enough. Kidney disease and some blood-pressure medicines make deliberate potassium increases unsafe; ask a clinician before salt substitutes or supplements aimed at that. A longer public write-up is on the ideas list; no link yet.

## Insights

Computed on device from my own log.

When there is enough history: a 0–100 headline (logging consistency, target hit rate, protein), intake bars with a hit band and rolling mean for the nutrient on the dock, weight with an EMA trend and weekly rate, adaptive TDEE from intake versus what weight actually did (or plain copy about what is missing), adherence by nutrient, macro and meal composition, and a phase comparison when a prior phase exists.

Flags stay up when trust should drop: days that look unfinished, Log once / calories-only days, days marked incomplete, day-plan calorie days. A thin log stays quiet instead of printing empty confident cards. Estimates from logged data, not medical advice.

## How it's built

Vanilla HTML, CSS, and JavaScript as a PWA on Vercel. Optional Drive sync uses one shard file per browser installation, so devices never overwrite each other. Nutrition math is local and deterministic.

## Get in touch

[alvin.alias@gmail.com](mailto:alvin.alias@gmail.com) · [LinkedIn](https://linkedin.com/in/alvin-alias) · [GitHub](https://github.com/aalias01)

© Alvin Alias. Portfolio project. Source is available for viewing and personal/non-commercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use requires prior written permission.
