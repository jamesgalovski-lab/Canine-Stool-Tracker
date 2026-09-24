# Stool Tracker: deploy notes

Brand-neutral, diet-neutral stool log for dogs. Same stack as the body condition and dental apps: one HTML page plus one Netlify function.

## Files
- `index.html`: the whole app (no external libraries).
- `netlify/functions/analyze-stool.js`: photo analysis proxy. It has its own name so it cannot affect the existing `analyze` function the other apps use.

## Deploy
1. Put `index.html` wherever the page should live (its own folder or subdomain if you want to avoid clashing with an existing `index.html`).
2. Copy `analyze-stool.js` into the site's existing `netlify/functions/` folder.
3. Confirm the environment variable name. The function reads `ANTHROPIC_API_KEY`; check it matches the name your other functions use.
4. Model: defaults to `claude-sonnet-5`. Verify the current model string in the Anthropic docs (https://docs.claude.com) and set `STOOL_MODEL` in Netlify if you want a different one.
5. Timeout: the function aborts after 22 seconds to stay under Netlify's roughly 26-second synchronous limit, with `max_tokens` at 600.

## Must do before public launch
- **Veterinary review of the `CLINICAL` block** near the top of the script in `index.html`. Every threshold there (how many loose logs in a row trigger a vet prompt, baseline size, transition grace period) is a development placeholder, not a clinical standard.
- **Legal review** of the disclosure wording and of naming Purina/Waltham/Nestlé Purina/Mars in it. The disclosure text lives in the `DISCLOSURE` constant.
- **Illustrations**: the seven score drawings are original SVGs drawn in code (`illustration()` function). Swap in commissioned artwork or your own photos if you prefer; keep them original.

## Data and privacy
- Everything is stored in the browser's localStorage under `stoolTracker.v1`. Nothing is saved on a server.
- Photos are compressed on the device (1024 px, JPEG 82%) and sent once to the function for a suggestion; only a 160 px thumbnail is kept.
- Users can export and import their log as JSON, print a vet report (browser Print → Save as PDF), and delete all data.
- If you later add email capture or server storage (as in the dental tracker), update the Privacy card on the About tab.

## Validation data you get for free
Each entry records the AI's suggested score, its confidence, and whether the owner agreed. Aggregated (with consent), that is the owner-vs-AI agreement dataset for validating the scale later.
