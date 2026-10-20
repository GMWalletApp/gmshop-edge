# Owned IP check — release evidence and coverage

## Scope and provenance

- Initial baseline: `86170fc` on deployed v1.17.0 `a847530`; ticker-only `fa927e5`
  is preserved, including removal of manual CDK handoff copy.
- Reference: https://ip-check.leeguoo.com/ and the author's linked Claude network
  article. This is a store-native implementation, NOT a byte/pixel-identical clone.
- Algorithm port: leeguooooo/claude-code-usage-bar `ip_score.py`, MIT, pinned at
  `a36a0b51c464b31c1b9b6189c29857e06ef63795`. License is retained in
  `LICENSE.upstream`. 800 differential cases matched risk/type/score exactly.
- External risk may conservatively lower that score. Current official country
  allowlist and trusted-ingress regional conflicts also constrain the result.
- Article: independently written with source links, not a copied/rebranded full
  article. Community fingerprint theories are not presented as official ban rules.

## Data providers

- Primary: https://ipquery.io/ — official page states no API key, free tier and
  commercial use permitted. IPv4 and IPv6 examples were checked live.
- Fallback: https://proxycheck.io/api/ — anonymous full response, 100/day advertised;
  site-wide D1 allowance is conservatively capped at 80 fallback calls/day.
- ipapi.is was NOT integrated: Google registration was rejected for the connection;
  its free tier is for development/testing, and public redistribution has separate
  restrictions. No account key was acquired/stored and no paid plan was bought.
- No attempt to bypass registration controls, rotate IPs or evade provider quotas.
- Both providers get only the queried IP. No account, cookie, order, CDK or secret
  is forwarded. Public visitor data still traverses normal hosting/network logs.

## Reference feature matrix

| Reference feature | Owned implementation | Boundary |
| --- | --- | --- |
| Current exit IPv4/IPv6 | Trusted original Cloudflare request metadata | Not proof of Claude's network route |
| Country/city/ASN/organization/colo | IPQuery + edge metadata, source labeled | Approximate geolocation |
| Other IP query / URL parameter | Public-IP validation, canonical IPv6 | Rejects local/reserved targets |
| JSON API | `/api/ip-check`, JSON Accept on `/ip-check` | Same limits; no extra API-key account system |
| Purity / risk score | MIT port, provider risk, 0–100 | Not a probability or official safety certificate |
| Clean/caution/high-risk/region bands | Explicit verdicts plus incomplete state | Missing evidence never gives 100 |
| Hosting / VPN / proxy / Tor | Required boolean provider flags | Database detection, not exhaustive scanning |
| Residential proxy | Original rule inference | Labeled inferred, not direct measurement |
| China-cloud row | Original ASN/organization rule | No claim about user nationality or actual bans |
| Mobile | IPQuery boolean; fallback may be unknown | Provider-supplied classification |
| Anycast | Published Google/Cloudflare resolver matches | Others UNKNOWN, never default false |
| ASN abuse fraction | UNKNOWN; alternative aggregate risk displayed separately | Not claimed to be equivalent |
| Browser timezone | Local read + comparison to provider timezone | Not scored or uploaded |
| WebRTC | Explicit Google STUN opt-in, 5s timeout, masked candidates | No-result is inconclusive; no automatic leak verdict |
| Local configuration checks | Safe macOS/Linux + PowerShell instructions | Website cannot read shell/config itself |
| Share image | 900×1200 masked PNG + QR + source/time/brand | Always masked even after UI reveal; no auto-post |
| Download / device share / copy link | Native browser actions, error handling | Device share depends on browser support |
| Ranking | Last 30 days of site-only score bins, one sample/IP/day | Not global; small samples say collecting |
| Technical blog | Standalone bilingual guide + coverage table + references | Independent prose, not unauthorized verbatim copy |
| Privacy/contact | Coverage/data notice + existing site support controls | No new third-party tracking scripts |
| Language/theme/mobile/keyboard | Existing Paraglide, theme and accessible controls | Production readback required below |

## Implementation and ablation

The public route stays thin. Feature-owned server code runs after Host validation
and before i18n request cloning, preserving `request.cf`. No second auth system,
router, database, SDK, screenshot dependency or generic provider/service framework.

Provider timeouts are 4s each, at most one fallback, 64 KiB response cap, redirects
rejected. Client timeout is 15s and cancels stale requests. Quota, malformed/missing
fields and network failure degrade visibly without synthesizing negative flags.
Cache keys include canonical IP and ingress-region context; cached normalized facts
omit the raw IP. TTL is 600s, public responses are private/CDN no-store. D1 rate keys
are hashed. No raw IP or account is stored in score bins. The ranking query uses the
day index and excludes old/future bins; failures in optional ranking never stop a
valid diagnostic result. No order/price/fulfillment/payment/notification behavior is
changed.

Ablations remove ASN, organization, region, individual risk flags, data providers,
cache, STUN availability and ranking success independently. These validate graceful
loss of evidence, not feature deletion. Removed only redundant hosting rows and
unsafe secret-printing examples. Sharing/ranking/guide remain user-facing features.

## Verification ledger

- 800 pure-scoring differential cases against pinned upstream: passed.
- Focused unit/integration checks: see `artifacts/ip-check/pre-release-tests.log`
  and subsequent final-gate logs (counts may grow as edge cases are added).
- Empty D1 + real SQL: at-most-once sample, no raw IP in counter keys, old/future
  exclusion and indexed ranking query tested using Miniflare.
- Local explicit fixture browser: 100-point display, masked share preview/download,
  mobile dialog without document overflow, no error/warning console entries.
- Downloaded PNG decoded with Apple Vision; QR equals the owned HTTPS checker URL
  with share attribution only, no target IP. Evidence: `qr-validation.log`.
- Local fixture is deliberately labeled TEST and is NOT evidence of a real visitor
  receiving 100. It is not shipped in production.
- Initial baseline deployment incident: stale build was inadvertently uploaded as
  `b725043f`; immediately rolled back to known v1.17.0 `4f85b393`. Correct generated
  baseline `904c23db` then passed live page/API readback. No database changed during
  that correction. Deploy commands now stop on the first failed gate.
- Ticker-only production version `1f40c6af` was read back on the real homepage.
- Final enhanced build/deploy/live checks are recorded below when completed.

## Not a guarantee

Detection is bounded by source coverage and freshness. Anycast outside the known
resolver set, ASN abuse fraction, Claude-side request routing and internal account
risk signals are not verified. This page cannot guarantee prevention of suspension.

## Final production validation

- PR #81 merged as `c805b803`; the subsequent transport/IPv6 correction is tracked
  by PR #82. Final Worker version is recorded in `artifacts/ip-check/final/`.
- Baseline feature CI: 1,151 Vitest + 23 Bun tests passed on the exact feature tree.
- Corrected full local regression: 1,159 Vitest + 23 Bun tests passed; one existing
  skipped file and two existing TODO tests remain, with no failures.
- Workers-native transport regression covers normal/gzip bodies, redirect refusal
  and response-size bounds. Workers does not accept `redirect: "error"`; the
  shared transport uses `manual` and callers reject non-2xx responses.
- IPv6 primary records can contain AS0/empty organization despite valid risk flags.
  Missing identity is filled only from the same checked connection's edge metadata
  or the provider's ISP field. Known positive risk remains reportable even when ASN
  is unknown. No identity plus no positive evidence never becomes a score of 100.
- The anonymous fallback returned HTTP 403 from Workers during the IPv6 probe.
  It is best effort, not guaranteed failover. Missing usable primary evidence still
  degrades visibly; no quota bypass, IP rotation or paid account was used.
- Live browser IPv4: 100 from IPQuery, masked share image generated successfully.
  Live IPv6 current-connection and explicit-address queries: 60/hosting from usable
  primary evidence. Known public DNS IPv4/IPv6: 60 with positive anycast match.
- `/healthz`, home, checker and guide returned 200; private/invalid query targets
  returned 400 and POST returned 405. JSON Accept and no-store headers were checked.
- Live WebRTC completed and displayed masked IPv4/IPv6 candidates, without claiming
  a leak verdict. Guide expansion, mobile overflow and console checks passed.
- Initial wrong-build exposure lasted approximately 24 seconds. A bounded read-only
  audit around that window found zero new orders and zero order events. No schema
  migration or manual business-data edit was executed during that correction.
- Sharing uses a first-party QR URL without the target IP. Its generated PNG was
  decoded successfully; the local sample download was labeled TEST-FIXTURE.

## 2026-10 Claude-exit redesign

- References: https://ip.skk.moe/ (split-routing table) and
  https://ipinfo.cv/claude-ai-check (verdict + per-item advice). Store-native
  implementation; no code copied. `nb5p/MyIP` (MIT) confirmed the
  `/cdn-cgi/trace` technique only.
- The browser fetches `https://{claude.ai,anthropic.com,chatgpt.com,grok.com}/cdn-cgi/trace`
  directly (all send `Access-Control-Allow-Origin: *`), so the score is computed
  for the exit Claude sees, not the exit that reaches this site. No Claude exit →
  no lookup, no score, verdict "unknown".
- Domestic exit: `myip.ipip.net/json`. DNS resolver: `{random}.edns.ip-api.com/json`
  (owner accepted ip-api free-tier terms on 2026-10-20 for this free public page).
- Provider lookups now require a Turnstile token with action `ipcheck` when
  Turnstile is configured; without it `/api/ip-check` returns edge facts only with
  `warning: "verify"` and 403. One token per run.
- Browser fingerprint (Canvas/WebGL FNV-1a codes, GPU, OS, automation flag) is
  computed and displayed client-side only; never uploaded or stored. Findings:
  automation, virtual GPU, OS/browser mismatch.
