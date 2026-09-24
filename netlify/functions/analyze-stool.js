// Netlify serverless function: analyze-stool
// Receives one compressed stool photo from the Stool Tracker front end,
// asks Claude for a SUGGESTED consistency score + visible findings,
// and returns strict JSON. The owner always confirms the final score.
//
// Environment variables (Netlify > Site settings > Environment variables):
//   ANTHROPIC_API_KEY  - required (confirm this matches the name your other functions use)
//   STOOL_MODEL        - optional; defaults below. Verify the model string in the current
//                        Anthropic docs (https://docs.claude.com) before deploying.

const DEFAULT_MODEL = "claude-sonnet-5";
const UPSTREAM_TIMEOUT_MS = 22000; // stays under Netlify's ~26s synchronous limit
const MAX_IMAGE_B64_LENGTH = 6_000_000; // ~4.5 MB decoded; front end sends ~1024px JPEGs

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You assist a dog owner who is logging their dog's stool in a home-observation app.
You look at ONE photo and return ONLY a JSON object. No prose outside the JSON.

Consistency scale (1-7), in the app's own wording:
1 = Pellets: small, hard, dry pieces like pebbles; may crumble apart.
2 = Firm log: holds its shape well, with visible cracks or sections and a dull, dry-looking surface; lifts off the ground cleanly.
3 = Moist log: holds its shape, surface looks damp or shiny, sections faint or absent; may leave a light mark on the ground.
4 = Soft log: still roughly log-shaped but squishy, no sections; leaves a clear smear when lifted.
5 = Soft piles: too soft to hold a log shape; sits in mounds or heaps; hard to lift in one piece.
6 = Loose: some texture remains but no shape; spreads into patches.
7 = Liquid: watery with little or no texture; spreads flat.

Rules:
- Suggest the single closest score. If the photo is unclear, set photo_usable=false and suggested_score=null.
- Colour in photos is unreliable (lighting, grass, pavement, bags). Only mention colour as "recheck in person", never as a finding.
- Report only what is visibly present. Do not diagnose. Do not name diseases.
- Never comment on food, diet quality, brands, or products.
- Keep "note" to one or two plain-language sentences, warm and non-judgmental.

Return exactly this shape:
{
  "photo_usable": true|false,
  "usable_reason": "string (why not usable, or empty)",
  "suggested_score": 1-7 or null,
  "confidence": "low"|"medium"|"high",
  "visible_findings": {
    "mucus_or_coating": true|false,
    "red_blood_visible": true|false,
    "very_dark_or_tarry_appearance": true|false,
    "foreign_material": true|false,
    "possible_worms_or_segments": true|false,
    "colour_recheck_suggested": true|false
  },
  "note": "string"
}`;

// Recover JSON even if the model wraps it in text or it is slightly truncated.
function extractJSON(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let s = text.slice(start);
  const end = s.lastIndexOf("}");
  if (end !== -1) {
    try { return JSON.parse(s.slice(0, end + 1)); } catch (_) { /* fall through */ }
  }
  // Attempt repair: close open strings/brackets/braces.
  let inStr = false, esc = false;
  const stack = [];
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) s += '"';
  s = s.replace(/,\s*$/, "");
  while (stack.length) s += stack.pop() === "{" ? "}" : "]";
  try { return JSON.parse(s); } catch (_) { return null; }
}

function sanitize(r) {
  const f = (r && r.visible_findings) || {};
  const score = Number(r && r.suggested_score);
  return {
    photo_usable: !!(r && r.photo_usable),
    usable_reason: String((r && r.usable_reason) || "").slice(0, 300),
    suggested_score: Number.isInteger(score) && score >= 1 && score <= 7 ? score : null,
    confidence: ["low", "medium", "high"].includes(r && r.confidence) ? r.confidence : "low",
    visible_findings: {
      mucus_or_coating: !!f.mucus_or_coating,
      red_blood_visible: !!f.red_blood_visible,
      very_dark_or_tarry_appearance: !!f.very_dark_or_tarry_appearance,
      foreign_material: !!f.foreign_material,
      possible_worms_or_segments: !!f.possible_worms_or_segments,
      colour_recheck_suggested: !!f.colour_recheck_suggested,
    },
    note: String((r && r.note) || "").slice(0, 500),
  };
}

function reply(statusCode, obj) {
  return { statusCode, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed." });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return reply(500, { error: "Server is missing ANTHROPIC_API_KEY." });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch (_) { return reply(400, { error: "Invalid JSON body." }); }

  const { image, mediaType, context } = payload;
  if (typeof image !== "string" || !image.length) return reply(400, { error: "No image supplied." });
  if (image.length > MAX_IMAGE_B64_LENGTH) return reply(413, { error: "Image too large." });
  const media = ["image/jpeg", "image/png", "image/webp"].includes(mediaType) ? mediaType : "image/jpeg";

  const ctx = context || {};
  const contextLine = `Context (for reference only, do not comment on diet): age group=${String(ctx.ageGroup || "unknown").slice(0, 20)}, size=${String(ctx.size || "unknown").slice(0, 20)}.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.STOOL_MODEL || DEFAULT_MODEL,
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media, data: image } },
            { type: "text", text: `${contextLine}\nScore this photo and return only the JSON object.` },
          ],
        }],
      }),
      signal: controller.signal,
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return reply(502, { error: (data && data.error && data.error.message) || `Upstream error ${resp.status}` });
    }
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const parsed = extractJSON(text);
    if (!parsed) return reply(502, { error: "Could not read the analysis. Please score manually." });
    return reply(200, sanitize(parsed));
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return reply(aborted ? 504 : 500, { error: aborted ? "Analysis timed out. Please score manually." : "Analysis failed." });
  } finally {
    clearTimeout(timer);
  }
};
