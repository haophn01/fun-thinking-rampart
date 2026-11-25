# Idea: Deploy Rampart as a Microsoft 365 app (plus a hosted demo)

Status: parked

## The idea
Ship Rampart inside Microsoft 365, so a contractor's compliance team opens it where they already work: Teams, Outlook and the Microsoft 365 app.

**Path, in order:**

1. **Host it first.** A Microsoft 365 app loads a public HTTPS web app, so Rampart needs a host before anything else.
   - Recommended: the web app on Vercel (static Vite build, with `/api/*` rewritten to the API).
   - The API as one container on Fly.io, Railway or Render, with a persistent volume for the SQLite file and the evidence store, plus backups.
   - Small changes: a Dockerfile, a `Secure` session cookie behind HTTPS, an allowed-origin setting.
   - This was option 1 of the 2026-11-25 deployment proposal. The all-Vercel option (Postgres + Blob + Functions) is a bigger rework.
2. **A Teams / Microsoft 365 tab app.**
   - An app manifest (Teams Toolkit / Microsoft 365 Agents Toolkit) that loads the hosted Rampart pages as personal and channel tabs.
   - It also runs in Outlook and the Microsoft 365 app.
   - It needs a CSP `frame-ancestors` allow-list for the Teams and Office hosts; helmet currently sends `frame-ancestors 'none'`.
3. **Entra ID single sign-on**, replacing local passwords inside Microsoft 365 (Teams SSO / MSAL, on-behalf-of to the API). This overlaps the parked [evidence-integrations-sso](evidence-integrations-sso.md) idea.
4. **Optional later steps:**
   - A Microsoft 365 Copilot agent or API plugin ("What's our SPRS score?", "Which POA&M items are overdue?") over the existing read-only API.
   - Teams notifications for POA&M due dates and the 180-day closeout clock.

## Why it's on hold
- **Demo first.** The human asked to circle back only after a successful demo of the V1 plan (`cmmc-l2-grc`).
- **No host yet.** V1 runs on a local machine, and a Microsoft 365 app needs a public HTTPS host first.
- **CUI and compliance:**
  - Vercel and most commercial clouds aren't FedRAMP Moderate.
  - Commercial Microsoft 365 isn't GCC High.
  - A hosted or Microsoft 365 version must stay **demo or test only, with no CUI**, until the parked [cui-storage-hosting](cui-storage-hosting.md) idea is built. A real deployment for a DIB contractor would target their **Microsoft 365 GCC High** tenant and a FedRAMP Moderate–equivalent host for the API.

## What would make it worth building
- A successful V1 demo, with stakeholders wanting the tool where their team already works.
- A decision on the host for the API, with at least a demo environment approved.
- A Microsoft 365 tenant to sideload the app into: a developer tenant for the demo, then the contractor's GCC High tenant for real use.
