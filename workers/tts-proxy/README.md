# KidQuest TTS Proxy

Tiny Cloudflare Worker that proxies ElevenLabs text-to-speech for the KidQuest
site. The Worker holds the ElevenLabs API key; the frontend never sees it.

## Why this exists

The site is hosted on GitHub Pages (static, no backend). Embedding the
ElevenLabs API key in `index.html` would expose it to anyone who opens
devtools, which burns credits fast. This Worker is the smallest viable
backend: one endpoint, holds one secret, streams MP3s back to the browser.

If the Worker is down, returns a 4xx/5xx, or the frontend hasn't been wired
to it yet, the site falls back to the browser's built-in `speechSynthesis`
automatically. The kids still hear everything read aloud — just in the
system voice instead of the ElevenLabs voice.

## One-time setup

1. **Install Wrangler** (Cloudflare's CLI):
   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. **Set the API key as a secret** (not committed to the repo):
   ```bash
   cd workers/tts-proxy
   wrangler secret put ELEVENLABS_API_KEY
   # Paste your ElevenLabs API key when prompted
   ```

3. **Deploy**:
   ```bash
   wrangler deploy
   ```
   Wrangler prints the Worker URL, e.g.
   `https://kidquest-tts-proxy.<your-subdomain>.workers.dev`.

4. **Wire the URL into the frontend**. Open `index.html`, find the
   `TTS_PROXY_URL` constant near the top of the TTS section, and paste the
   URL from step 3:
   ```js
   const TTS_PROXY_URL = 'https://kidquest-tts-proxy.example.workers.dev';
   ```
   Commit + push. The live site picks up the change on next page load.

## Updating

- **Change the default voice**: edit `DEFAULT_VOICE_ID` in `wrangler.toml`
  and run `wrangler deploy`. No secret change needed.
- **Rotate the API key**: `wrangler secret put ELEVENLABS_API_KEY` again
  with the new key. Takes effect immediately — no redeploy needed.
- **Add a new origin** (e.g. you buy a custom domain): add it to
  `ALLOWED_ORIGINS` in `wrangler.toml` and redeploy.

## Cost & limits

- **Cloudflare Workers free tier**: 100,000 requests/day. The site sends
  at most a few hundred requests per kid per day — we're nowhere near the
  limit.
- **ElevenLabs credits**: each `/tts` call charges your ElevenLabs account
  per character. The Worker caps request length at 1,200 characters to
  prevent accidental or malicious overage.
- **The in-browser session cache** means the same phrase won't re-bill
  ElevenLabs if the kid taps "🔊 Hear it" twice on the same question.

## Endpoints

- `POST /tts` — body `{text, voiceId?, modelId?}`. Returns `audio/mpeg`
  on success, JSON `{error, ...}` on failure.
- `GET /health` — returns `{ok:true}`. For uptime monitors.
- `OPTIONS *` — CORS preflight.

## Security posture

- **No request logging beyond Cloudflare's built-in analytics.** The
  Worker never writes student text anywhere.
- **Origin allow-list.** Only `rhahavy.github.io`, the custom domain, and
  `localhost:8080` can call `/tts`. Other origins get `403`.
- **Text length cap** (1,200 chars) prevents a single request from
  nuking your ElevenLabs balance.
- **Secrets via `wrangler secret`** — never stored in `wrangler.toml` or
  committed to git.

## Troubleshooting

- **Frontend says "falling back to browser TTS" every time**:
  - Check `wrangler tail` for errors.
  - Hit `https://<worker-url>/health` in a browser — should return
    `{"ok":true,"service":"kidquest-tts-proxy"}`.
  - If `/health` works but `/tts` 403s, your site's `Origin` isn't in
    the allow-list. Add it to `ALLOWED_ORIGINS` in `wrangler.toml` and
    redeploy.
- **401 from upstream**: API key is wrong or missing. Re-run
  `wrangler secret put ELEVENLABS_API_KEY`.
- **429 from upstream**: out of ElevenLabs credits. The frontend
  handles this automatically by falling back — no action needed.
  The cooldown in `index.html` means we won't retry for 10 minutes,
  so credit consumption stops immediately when the balance hits zero.
