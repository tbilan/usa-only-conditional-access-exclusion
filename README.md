# USA-only Conditional Access Exclusion

A local Node web app that manages a **"block sign-ins from outside the United States"** Conditional Access
policy across all the Microsoft Entra tenants you manage, and lets you pick who is **excluded** from it —
each exclusion with either a **removal date** or a **Permanent** checkbox. Expired exclusions are removed automatically.

## How it works (per tenant)

The app provisions three objects in each tenant (idempotent, found again by name):

| Object | Name |
|---|---|
| Named location (country: US) | `Allowed - United States` |
| Security group (the exclusion list) | `USA-only CA Exclusions` |
| Conditional Access policy | `USA-only Conditional Access` — all users, all apps, **block** unless in the US location; excludes the group |

Excluding a user = adding them to the group; removing the exclusion = removing them. The policy is created in
**report-only** mode; review the Entra sign-in logs, then press **Turn ON**.
Dated exclusions stay active through the end of that date (this computer's clock) and a sweep (at startup and every
15 min) removes them. **The app must be running for expiry to happen**; it catches up on next start.

Always add your break-glass / emergency accounts as **Permanent** exclusions before turning the policy ON.

## Setup

1. **App registration** (in your own/partner tenant): Entra ID → App registrations → New, *Accounts in any organizational directory (multi-tenant)*.
   - Redirect URI (Web): `http://localhost:3000/consent-done.html`
   - Create a client secret.
   - API permissions → Microsoft Graph → **Application** permissions:
     `Policy.ReadWrite.ConditionalAccess`, `Policy.Read.All`, `Application.Read.All`, `Group.ReadWrite.All`, `User.Read.All`,
     and (only for GDAP import) `DelegatedAdminRelationship.Read.All`. Grant admin consent in your own tenant.
2. `cp .env.example .env` and fill in `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `PARTNER_TENANT_ID`.
3. `npm install && npm start`, then open <http://localhost:3000>.
4. **Add tenants** manually (name + tenant ID) or **Import from GDAP**.
5. **Per customer tenant**, an admin there must approve the app once. Open the tenant in the app; if it isn't consented the
   error shows an admin-consent link to send them.

## Notes

- Listens on `127.0.0.1` only; rejects foreign `Host` headers and non-JSON writes. There is no login, so run it on a machine only you use.
- Secrets live in `.env` (git-ignored). Tracked exclusions and the audit log live in `data/db.json` (git-ignored).
- Members added to the group outside the app show up as "not tracked" so you can give them a date.
- `npm test` runs the expiry tests.
