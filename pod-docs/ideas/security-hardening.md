# Idea: Security hardening of Rampart

Status: built — #45 (plan security-hardening)

## The idea
On 2026-11-26 the human said: "now focus on security side of the app".

Harden Rampart as a security product before it's demoed more widely or hosted. Candidate areas (research and the plan interview will narrow them down):
- **Web-page security headers and CSP.** Today helmet only covers `/api`, and the HTML is served by the Vite dev server (the open "before hosting" queue item). Serve the web from a production build with strict headers.
- **Session and auth:**
  - `Secure` cookie behind HTTPS
  - session lifetime and idle timeout review
  - password policy and breached-password check
  - lockout and rate limiting on every write route, not just sign-in
  - optional MFA (TOTP)
- **Input and file handling:** upload type sniffing (magic bytes) for evidence and policies, size limits, filename sanitizing, zip and docx bombs, and SVG/HTML refusal.
- **Data at rest:** SQLite and evidence-store encryption options, backups, and the integrity checks already in place (SHA-256).
- **Supply chain:** dependency audit in CI (`pnpm audit` / OSV), lockfile integrity, pinned GitHub Actions, CodeQL or Semgrep, and the existing gitleaks.
- **Audit and logging:** tamper evidence for the append-only audit log (hash chain), log redaction review, and security events (failed sign-ins, lockouts).
- **Threat model and docs:** a STRIDE pass over the api and web, a SECURITY.md, and a mapping of Rampart's own controls to NIST SP 800-171 (eat our own cooking).
- **Tests:** security regression tests (CSRF, authz on every route, IDOR across assessments, header checks in e2e).

## Why it's on hold
It isn't on hold: the human chose to work on it now with `/pod:ship`.

## What would make it worth building
- Rampart is a compliance tool for defense contractors, so its own security posture is part of its credibility.
- It's a prerequisite for the parked deployment and Microsoft 365 work ([m365-app-deployment](m365-app-deployment.md)).
