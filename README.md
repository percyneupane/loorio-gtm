# Loorio GTM

Creator outreach engine for Loorio, plus an always-on inbox assistant. One process (`npm start`)
runs a local dashboard and a background worker:

```
discover ─► find public email ─► AI: pick email + score fit ─► AI: draft email + 3 follow-ups
                                                                         │
                         you approve (or AUTO_APPROVE) ◄────────────────┘
                                   │
          send in-window, ≤ DAILY_SEND_LIMIT/day ─► follow-ups day 3 / 7 / 14 in the same thread
                                   │
inbox monitor (every 60s) ─► reply? stop sequence · opt-out? suppress forever · bounce? stop
                          └► triage every new email ─► Gmail draft reply ─► push notification
```

## Where emails come from

Only places the creator published them, in order:

1. **YouTube** — channel description + the 5 most recent video descriptions (official Data API)
2. **TikTok / Instagram bio** and their **link-in-bio page** (Linktree, Beacons, Stan, …)
3. **Their own website** — homepage, then contact / about / work-with-me pages

Decodes `name [at] gmail [dot] com` style obfuscation and `mailto:` links. Claude then picks the
business address (never invents one — it must be in the found list) and scores fit 0–100 against
`config/pitch.md`. The dashboard shows exactly where each email was found.

Not covered: YouTube's captcha-gated "View email address" button, and Instagram profiles that
serve a login wall to logged-out visitors (add those creators by website or paste the email's
source page instead).

## Setup

```bash
cp .env.example .env     # fill in the keys below
npm install
npm start                # → http://localhost:3000, click "Connect Gmail"
```

| Key | Where to get it |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `SECRET` | Same OAuth client as `~/loorio-outreach-tracker` (redirect URI `http://localhost:3000/api/auth/callback/google` is already registered). The app requests `gmail.readonly` + `gmail.compose`; Google shows an "unverified app" screen for your own account — *Advanced → Continue*. Keep the OAuth app **in production** or the refresh token dies after 7 days. |
| `YOUTUBE_API_KEY` | Same Google Cloud project → *APIs & Services → Library → YouTube Data API v3 → Enable*, then *Credentials → Create credentials → API key*. Free quota covers ~95 niche searches/day. |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys. Haiku 5.5 qualifies/triages (fractions of a cent); Opus 5.5 writes emails and replies (~1–3¢ each). |
| `NTFY_TOPIC` | Install the free **ntfy** app (iOS/Android), tap *Subscribe*, enter the topic from `.env`. Treat the topic like a password. |
| `SENDER_ADDRESS` | A postal address — CAN-SPAM requires it in commercial email. A PO box works. |

Edit **`config/pitch.md`** to change what the AI says about Loorio and what you're asking for.

## Running it all the time

The worker only runs while `npm start` is running. On a Mac that stays on:

```bash
npx pm2 start "npm start" --name loorio-gtm && npx pm2 save
```

If the app is offline for more than about a week, Gmail's history cursor expires; the monitor
resumes from "now" and doesn't backfill the gap.

## Safety rails

- Nothing sends until you approve it (`AUTO_APPROVE=false` by default); weekday send window and daily cap.
- Before each follow-up the thread is re-checked; any reply cancels the rest.
- Opt-outs ("no thanks", "unsubscribe") and bounces are suppressed permanently, across creators sharing an address.
- Replies are always **drafts** in Gmail — the AI never sends a reply on its own.
- Inbound email and scraped pages are treated as untrusted data in every prompt.
- Page fetching blocks private/loopback addresses, caps size and redirects.
- The dashboard binds to `127.0.0.1` and rejects cross-origin / non-JSON writes.

## Development

```bash
npm test          # node:test, 75 tests, coverage report
npm run typecheck
```

Layout: `src/discovery` (email finding), `src/outreach` (discover/enrich/send + pure scheduling),
`src/inbox` (monitor), `src/ai` (Claude prompts + schemas), `src/google` (Gmail/YouTube/OAuth over
REST), `src/repo` (SQLite access), `public/` (dashboard). Data lives in `data/gtm.db` (git-ignored).
