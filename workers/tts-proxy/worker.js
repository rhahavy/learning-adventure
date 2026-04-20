/* KidQuest TTS Proxy — Cloudflare Worker
 * ---------------------------------------------------------------
 * Tiny proxy that puts ElevenLabs behind the site without exposing
 * the API key in the frontend. The Worker holds the secret; the
 * frontend just POSTs text and plays back whatever audio comes down
 * the wire.
 *
 * Design goals:
 *   - Zero persistence. No KV, no D1, no logging of student text.
 *     The site reads aloud whatever the kid sees on screen — we
 *     don't want an audit trail of that.
 *   - Fail loud with proper HTTP status codes so the frontend can
 *     cleanly fall back to browser speechSynthesis. Any non-200
 *     response from here trips the client-side cooldown.
 *   - Lean request budget. Streams the audio through without
 *     buffering (Workers cap body size, and ElevenLabs already
 *     returns MP3 — we just pipe it).
 *   - Strict CORS. Only the production site + localhost dev server
 *     are allowed to call this. Everyone else eats a 403 so our
 *     ElevenLabs credits can't be pilfered by someone who sniffs
 *     the URL out of devtools.
 *
 * Endpoints:
 *   POST /tts           → body {text, voiceId?, modelId?, lang?}
 *                         returns audio/mpeg bytes on success,
 *                         JSON error on failure (with upstream code).
 *   GET  /health        → 200 OK (for uptime checks + sanity).
 *   OPTIONS *           → CORS preflight.
 *
 * Secrets / env (set via `wrangler secret put` — see README):
 *   ELEVENLABS_API_KEY  — required.
 *   DEFAULT_VOICE_ID    — optional, var in wrangler.toml.
 *   DEFAULT_MODEL_ID    — optional, defaults to eleven_flash_v2_5
 *                         (cheapest, fastest model — good for short
 *                         kid-facing phrases).
 *   ALLOWED_ORIGINS     — optional comma-separated list; defaults
 *                         to the two origins below.
 */

// Hard-coded fallback for ALLOWED_ORIGINS so a fresh deploy without
// env vars still works on the live site. Override by setting the
// ALLOWED_ORIGINS var in wrangler.toml if the domain changes.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://rhahavy.github.io',
  'https://kidquest.rhahavy.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

// Cap on text length — ElevenLabs charges per character, and a
// 10k-char request is almost certainly a bug or abuse. Short
// phrases (under ~500 chars) are what the UI actually sends.
const MAX_TEXT_LENGTH = 1200;

// Eleven Flash v2.5 is the cheapest+fastest model. For the
// "read this word" / "read this sentence" use case, the quality
// difference between Flash and Multilingual v2 isn't worth 2x the
// credits.
const FALLBACK_MODEL_ID = 'eleven_flash_v2_5';

// "Rachel" — a widely-available default voice in ElevenLabs.
// Override via DEFAULT_VOICE_ID in wrangler.toml.
const FALLBACK_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = getAllowedOrigins(env);
    const corsOrigin = allowed.includes(origin) ? origin : '';

    // Preflight — browsers send this before any POST with a JSON body.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(corsOrigin),
      });
    }

    // Cheap health check for uptime monitors + a sanity URL to paste
    // into a browser after deploy ("is my Worker alive?").
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'kidquest-tts-proxy' }, 200, corsOrigin);
    }

    // The one endpoint that does real work.
    if (url.pathname === '/tts' && request.method === 'POST') {
      // Origin gate. An empty corsOrigin means the Origin header didn't
      // match our allow-list — block it so nobody can point a random
      // site at our Worker and burn our ElevenLabs credits.
      if (!corsOrigin) {
        return json({ error: 'origin_not_allowed' }, 403, '');
      }
      return handleTts(request, env, corsOrigin);
    }

    return json({ error: 'not_found' }, 404, corsOrigin);
  },
};

async function handleTts(request, env, corsOrigin) {
  if (!env.ELEVENLABS_API_KEY) {
    // Misconfigured Worker — return a 5xx so the client treats this as
    // an upstream failure and falls back to browser TTS.
    return json({ error: 'missing_api_key' }, 500, corsOrigin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400, corsOrigin);
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return json({ error: 'missing_text' }, 400, corsOrigin);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return json({ error: 'text_too_long', max: MAX_TEXT_LENGTH }, 413, corsOrigin);
  }

  const voiceId = sanitizeId(body.voiceId) || env.DEFAULT_VOICE_ID || FALLBACK_VOICE_ID;
  const modelId = sanitizeId(body.modelId) || env.DEFAULT_MODEL_ID || FALLBACK_MODEL_ID;

  // Output format notes:
  //   mp3_44100_128 — default on ElevenLabs Free (128 kbps). OK but
  //                    slightly muddy on short consonants; kids doing
  //                    phonics reads sometimes mishear "th" vs "f".
  //   mp3_44100_192 — 192 kbps, unlocked on the Starter tier and up.
  //                    Costs the same in character credits — higher
  //                    bitrate is a free audio-quality win once the
  //                    account is Starter+. Audible improvement on
  //                    cloned voices (Nova) and French cadence.
  // We request 192 unconditionally. If the account ever drops back to
  // Free, ElevenLabs returns a clear error and the client trips its
  // cooldown → browser TTS fallback. Safe to keep asking for the best.
  const upstreamUrl =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
    `?output_format=mp3_44100_192`;

  // Stability/similarity defaults chosen for a calm, consistent
  // read-aloud voice. Adjusting these means re-uploading a custom
  // voice on ElevenLabs — we keep them fixed so the kid hears the
  // same voice every time.
  const payload = {
    text,
    model_id: modelId,
    voice_settings: {
      stability: 0.55,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    },
  };

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
        'accept': 'audio/mpeg',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Network failure reaching ElevenLabs (rare, but possible during
    // an outage). Bubble up as 502 so the client falls back.
    return json({ error: 'upstream_unreachable', detail: String(err && err.message || err) }, 502, corsOrigin);
  }

  if (!upstream.ok) {
    // Forward the upstream status so the client can distinguish
    // "out of credits" (401/429) from "bad request" (400) from
    // "something's wrong upstream" (5xx). We don't leak the full
    // ElevenLabs response body — just the status + a short code.
    let upstreamCode = 'upstream_error';
    try {
      const errBody = await upstream.json();
      if (errBody && errBody.detail && errBody.detail.status) {
        upstreamCode = String(errBody.detail.status);
      }
    } catch {}
    return json(
      { error: 'upstream_failed', status: upstream.status, code: upstreamCode },
      upstream.status >= 500 ? 502 : upstream.status,
      corsOrigin
    );
  }

  // Happy path — stream the MP3 straight through. Headers are
  // copied minimally: only content-type + length (when present).
  const headers = new Headers(corsHeaders(corsOrigin));
  headers.set('content-type', upstream.headers.get('content-type') || 'audio/mpeg');
  const len = upstream.headers.get('content-length');
  if (len) headers.set('content-length', len);
  // The same text + voice + model should be cached for a while on
  // the client. We still send a short max-age so the browser can
  // reuse audio across the same session if the Audio element's blob
  // URL got discarded.
  headers.set('cache-control', 'private, max-age=300');

  return new Response(upstream.body, { status: 200, headers });
}

// ---------- helpers ----------

function getAllowedOrigins(env) {
  if (env.ALLOWED_ORIGINS && typeof env.ALLOWED_ORIGINS === 'string') {
    return env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(origin) {
  const h = {
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
  if (origin) h['access-control-allow-origin'] = origin;
  return h;
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders(origin),
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

// Voice/model IDs are alphanumeric + underscores. Anything weirder
// is either a typo or an injection attempt — reject silently and
// fall through to the defaults.
function sanitizeId(v) {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim();
  if (!trimmed) return '';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(trimmed) ? trimmed : '';
}
