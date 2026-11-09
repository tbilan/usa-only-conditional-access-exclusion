# USA-only Conditional Access Exclusion

A local Node web app that manages a **"block sign-ins from outside the United States"** Conditional Access
policy across all the Microsoft Entra tenants you manage, and lets you pick who is **excluded** from it —
each exclusion with either a **removal date** or a **Permanent** checkbox. Expired exclusions are removed automatically.

## How it works (per tenant)

Each tenant already has its own US-only policy, possibly under a different name. The first time you open a tenant the app
lists its Conditional Access policies (likely US-only ones are flagged) and you pick the right one; the choice is remembered.
Choosing a policy changes nothing in the tenant.

Excluding a user adds them **directly to that policy's Exclude → Users list**; removing the exclusion takes them out.
Users already excluded in the policy appear as "not tracked" so you can give them a removal date or mark them permanent.
You can also change the policy's state (report-only / on / off) from the app, or "Change policy" to point at a different one.

If a tenant has no US-only policy, the chooser can **create** one (`USA-only Conditional Access`: all users, all apps, block
unless in the `Allowed - United States` location, report-only).

Dated exclusions stay active through the end of that date (this computer's clock) and a sweep (at startup and every
15 min) removes them. **The app must be running for expiry to happen**; it catches up on next start.

Always make your break-glass / emergency accounts **Permanent** exclusions before turning a policy ON.

## Setup

1. **App registration** (in your own/partner tenant): Entra ID → App registrations → New, *Accounts in any organizational directory (multi-tenant)*.
   - Redirect URI (Web): `http://localhost:3000/consent-done.html`
   - Create a client secret.
   - API permissions → Microsoft Graph → **Application** permissions:
     `Policy.ReadWrite.ConditionalAccess`, `Policy.Read.All`, `Application.Read.All`, `User.Read.All`,
     and (only for GDAP import) `DelegatedAdminRelationship.Read.All`. Grant admin consent in your own tenant.
2. `cp .env.example .env` and fill in `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `PARTNER_TENANT_ID`.
3. `npm install && npm start`, then open <http://localhost:3000>.
4. **Add tenants** manually (name + tenant ID) or **Import from GDAP**.
5. **Per customer tenant**, an admin there must approve the app once. Open the tenant in the app; if it isn't consented the
   error shows an admin-consent link to send them.

## Notes

- Listens on `127.0.0.1` only; rejects foreign `Host` headers and non-JSON writes. There is no login, so run it on a machine only you use.
- Secrets live in `.env` (git-ignored). Tracked exclusions and the audit log live in `data/db.json` (git-ignored).
- `npm test` runs the expiry tests.
