# Research: Security hardening for a self-hosted CMMC L2 GRC web app

_Generated: 2026-11-26 · Depth: standard · Researchers: 1 · Searches: 10 · Pages read: 13_

**Assumptions:** The app stays single-tenant and is first run locally, then hosted behind a reverse proxy with TLS. V1 holds no CUI, but it does hold evidence and compliance posture data, which is sensitive. Nobody could answer questions, so I judged the ranking from the brief. Rankings are my own judgment, built on the cited findings. "Not fetched" items are listed under Questions or Not found, not cited as facts.

## What exists
This is the closest set of comparables, covering what they publish about their own security posture, and the libraries the plan would use.

| Name | Link | What it does | Alive? (last release · stars · users) | License | How close to the idea |
|------|------|--------------|---------------------------------------|---------|-----------------------|
| CISO Assistant (intuitem) | [SECURITY.md](https://github.com/intuitem/ciso-assistant-community/blob/main/SECURITY.md) | Open-source GRC. Publishes a policy: report by email to security@intuitem.com, semver, only the latest minor of the current major gets fixes, GitHub Security Advisories, CERT-FR notified at CVSS 9.0 or higher, no bug bounty | no evidence found (not read: release dates, stars) | AGPL per a search result, not verified on a fetched page | Closest open-source peer. Its posture is a disclosure policy, not a control mapping |
| Vanta (own security page) | [vanta.com/company/security](https://www.vanta.com/company/security) | SaaS GRC. Says it holds SOC 2 Type II and ISO 27001, runs a yearly pen test (Doyensec), does field-level encryption plus KMS, TLS 1.2+ with HSTS, WebAuthn-only MFA where possible, and SAST, SCA, malicious-dependency scan and DAST | n/a (SaaS) | proprietary | Shows the bar a hosted GRC sets. Self-description only, not independently verified |
| @fastify/helmet | [repo](https://github.com/fastify/fastify-helmet) | Security headers and CSP. Global by default, per-route override, `enableCSPNonces`. Plugin `>=12.x` for Fastify 5 | not read | not read | Already in use (on /api only) |
| @fastify/rate-limit | [README](https://raw.githubusercontent.com/fastify/fastify-rate-limit/main/README.md) | Per-route or global limits, in-memory store by default | not read (a search result suggested 10.x targets Fastify 5, unverified) | MIT per a search result, not on a fetched page | Fits the rate-limit item |
| file-type | [repo](https://github.com/sindresorhus/file-type) | Magic-byte detection for binary formats | not read | MIT | Fits upload sniffing, with limits (see Gaps) |
| otplib | [repo](https://github.com/yeojz/otplib) | TOTP/HOTP. v13 is a breaking rewrite | no evidence found (the page showed no version or release date) | MIT | Candidate for optional MFA |
| OWASP ASVS 5.0.0 | [repo](https://github.com/OWASP/ASVS) | Verification standard, released May 2025 | stable | CC BY-SA 4.0 (from a search result, not a fetched page) | The checklist to map against |

## Gaps and angles
- The comparables publish policy and attestations, not control-by-control self-mapping. CISO Assistant's policy covers reporting and support windows only. Vanta's page lists certifications and testing. I found no published mapping of a GRC tool's own controls to NIST SP 800-171. Direct evidence is limited to these two pages — [CISO Assistant](https://github.com/intuitem/ciso-assistant-community/blob/main/SECURITY.md), [Vanta](https://www.vanta.com/company/security)
- Drata and Eramba posture: no evidence found (not fetched).
- NIST 800-171 3.5/3.13/3.14 as they apply to the tool: no evidence found. I did not fetch the standard or CMMC scoping guidance, so whether the tool counts as in-scope is an open question.
- file-type cannot cover text formats such as SVG, CSV or TXT. It gives no guarantee a file is valid. It prefers the whole file, and it can misreport macro-enabled OOXML as the base type. It is not concurrency-safe. Malformed-input robustness is "not considered security issues" by the maintainers, so the docs advise a size limit and a worker thread with a timeout. It does not itself detect zip or docx bombs — [file-type](https://github.com/sindresorhus/file-type)
- otplib is stateless and does not track used codes, so replay protection is the app's job (from a search result; the fetched README did not mention replay or a verify window) — [otplib](https://github.com/yeojz/otplib)
- rate-limit pitfalls: the in-memory store is per process. Behind a proxy without `trustProxy`, all clients share one key. The key is the IP by default, and `onRequest` runs before auth data exists, so per-user keys need `hook: 'preHandler'`. The 404 handler is not limited by default — [README](https://raw.githubusercontent.com/fastify/fastify-rate-limit/main/README.md)
- helmet is currently on /api only, so the HTML served by Vite or a later static host has no CSP. Helmet's default CSP applies unless `useDefaults: false`. Nonces need `enableCSPNonces` — [fastify-helmet](https://github.com/fastify/fastify-helmet)

## Best practices
- Make access control the top priority. OWASP Top 10 2025 ranks Broken Access Control first. Misconfiguration is second, supply chain failures third, authentication failures seventh, and logging and alerting failures ninth — [OWASP Top 10 2025](https://top10.owasp.org/2025)
- Use ASVS 5.0.0 (May 2025) as the checklist. I did not verify its level definitions — [ASVS](https://github.com/OWASP/ASVS)
- Passwords per NIST 800-63B-4: no composition rules, allow long passwords and spaces (cap only for hashing cost), screen against a blocklist of breached and common passwords, and make rate limiting the main online defense. The page gives no numeric minimum, and sources disagree (8 vs 15), so settle it from the standard text — [NIST 800-63B-4 passwords](https://pages.nist.gov/800-63-4/sp800-63b/passwords)
- Sessions per OWASP: set Secure, HttpOnly and SameSite explicitly, prefer the `__Host-` prefix, keep scope narrow, regenerate the ID on login and privilege change, invalidate server-side on logout, and enforce idle (15–30 min low-risk, 2–5 min high-value) and absolute (4–8 h) timeouts server-side — [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). Note `__Host-` requires Secure, so it needs HTTPS and won't work over plain-HTTP localhost in all browsers (my inference, not sourced).
- Supply chain with pnpm: commit the lockfile. Use `allowBuilds` (build scripts blocked unless listed, `strictDepBuilds` on by default). Keep `minimumReleaseAge` (default 1440 minutes). Consider `trustPolicy: no-downgrade`, and keep `blockExoticSubdeps` on — [pnpm](https://pnpm.io/supply-chain-security). Use `npm ci`-style frozen installs in CI, and audit — [Node security guide](https://nodejs.org/en/learn/getting-started/security-best-practices). I did not fetch pnpm audit docs or GitHub's SHA-pinning docs, so pinning Actions to full SHAs is my recommendation (one search snippet cites GitHub's guidance, unverified).
- Node hardening: set `headersTimeout`, `requestTimeout` and `keepAliveTimeout`, put a reverse proxy in front, guard against prototype pollution (JSON Schema/zod input validation, `Object.hasOwn`), and never expose `--inspect` — [Node security guide](https://nodejs.org/en/learn/getting-started/security-best-practices)
- For uploads: cap size first, then sniff, run detection in a worker with a timeout, and refuse text-ish types (SVG, HTML) by allowlist — [file-type](https://github.com/sindresorhus/file-type)
- Publish a disclosure policy as peers do (contact, supported versions, advisories) — [CISO Assistant](https://github.com/intuitem/ciso-assistant-community/blob/main/SECURITY.md)

## Ideas to consider
Ranking: value against effort for a single-tenant app, local now and hosted later. All rankings are (own idea) judgments on the cited evidence.

1. **Authz/IDOR/CSRF regression tests on every route** (route-table test that fails if a route lacks an auth decision) — grows from OWASP A01 [Top 10](https://top10.owasp.org/2025). High value, low effort.
2. **Supply-chain CI** (pnpm settings, frozen lockfile, audit, SHA-pinned Actions, optionally CodeQL/Semgrep) — grows from [pnpm](https://pnpm.io/supply-chain-security) and OWASP A03. High value, low effort, as gitleaks is already there.
3. **Headers + CSP on the served HTML and production static hosting** (replace Vite dev server for hosting) — grows from [helmet gap](https://github.com/fastify/fastify-helmet). High value, low-medium effort.
4. **Session hardening**: idle and absolute timeouts, ID rotation on login, `__Host-` cookie when on HTTPS — grows from [OWASP sessions](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). High value, low effort.
5. **Rate limiting on all routes** with strict limits on login and writes; set `trustProxy` before hosting — grows from [rate-limit pitfalls](https://raw.githubusercontent.com/fastify/fastify-rate-limit/main/README.md). Medium-high value, low effort.
6. **Upload hardening**: size cap, extension and MIME allowlist, sniff, force `Content-Disposition: attachment` and `nosniff` on download (the last two are my suggestion), worker-thread timeout — grows from [file-type](https://github.com/sindresorhus/file-type). High value, medium effort.
7. **Password blocklist and length policy** (no composition rules) — grows from [NIST](https://pages.nist.gov/800-63-4/sp800-63b/passwords). Medium value, low effort. Lockout after 5 failures also lets an attacker lock out a user, so combine with throttling (own idea).
8. **Log redaction and error handling** — grows from OWASP A09 and A10. Medium value, low effort.
9. **Tamper-evident audit log (hash chain)** — grows from A09 and the append-only log. Medium value, medium effort. Note a chain stored in the same DB only detects partial edits, unless the head hash is exported (own idea).
10. **SECURITY.md plus short STRIDE threat model** — grows from [CISO Assistant policy](https://github.com/intuitem/ciso-assistant-community/blob/main/SECURITY.md). Medium value, low effort. A self-mapping to NIST 800-171 has real credibility value but no peer precedent was found.
11. **Backups and encryption at rest**: start with encrypted, tested backups and disk encryption of the host. SQLite-level encryption is higher effort and I did not research options (no evidence found). Vanta does field-level plus KMS but at a SaaS scale — [Vanta](https://www.vanta.com/company/security). Value rises when hosted.
12. **Optional TOTP MFA** — otplib v13 needs an app-side replay store, and secrets and recovery codes need storage — [otplib](https://github.com/yeojz/otplib). Highest effort and surface. Vanta requires phishing-resistant factors (WebAuthn) for staff, so consider WebAuthn later (own idea). Defer until hosting.

## Questions for the plan
- Where will it be hosted, and who terminates TLS? — why it matters: `__Host-` cookies, HSTS, `trustProxy` for rate limits and the Node timeouts all depend on it — options: reverse proxy (Caddy/nginx) / Node direct / platform-managed
- Is the tool itself in CMMC scope, and what does the contractor's assessor expect? — why it matters: no evidence found on scoping, and it decides whether 800-171 self-mapping and MFA are mandatory or optional — options: treat as out of scope, voluntary self-mapping / treat as a Security Protection Asset / ask the assessor
- Password minimum length? — why it matters: sources conflict (8 vs 15) and the NIST page fetched gives no number — options: read 800-63B-4 section 3.1.1 and pick 15 / 8 with MFA
- Session timeouts? — why it matters: OWASP gives ranges — options: 15–30 min idle, 8 h absolute / 5 min for admins / longer for demo
- Upload policy: which types are allowed? — why it matters: file-type cannot judge text formats, and OOXML detection is imperfect — options: strict allowlist (PDF, PNG, JPEG, docx, xlsx) / allowlist plus archive-expansion checks / quarantine and scan
- Audit-log integrity: in-DB chain or exported anchor? — why it matters: an in-DB chain cannot stop someone who rewrites the whole table — options: in-DB chain / periodic signed export / defer
- MFA now or at hosting? — why it matters: highest effort, replay handling is yours — options: TOTP via otplib / WebAuthn / defer
- Encryption at rest approach? — why it matters: no research done on SQLite encryption options — options: host disk encryption plus encrypted backups / SQLite encryption extension / defer

## Suspect pages
none

## Sources
- OWASP Top 10 2025 — https://top10.owasp.org/2025 — 2025
- OWASP ASVS (GitHub) — https://github.com/OWASP/ASVS — 5.0.0, May 2025
- NIST SP 800-63B-4, Passwords appendix — https://pages.nist.gov/800-63-4/sp800-63b/passwords
- OWASP Session Management Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- Node.js Security Best Practices — https://nodejs.org/en/learn/getting-started/security-best-practices
- pnpm, Mitigating supply chain attacks — https://pnpm.io/supply-chain-security
- @fastify/rate-limit README — https://raw.githubusercontent.com/fastify/fastify-rate-limit/main/README.md
- @fastify/helmet — https://github.com/fastify/fastify-helmet
- file-type — https://github.com/sindresorhus/file-type
- otplib — https://github.com/yeojz/otplib
- CISO Assistant SECURITY.md — https://github.com/intuitem/ciso-assistant-community/blob/main/SECURITY.md
- Vanta, Security and privacy — https://www.vanta.com/company/security
