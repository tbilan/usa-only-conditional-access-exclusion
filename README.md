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

Dated exclusions stay active through the end of that date in the app's time zone (`APP_TIMEZONE`, default: the host's; the Azure deployment defaults to America/New_York) and a sweep (at startup and every
15 min) removes them. **The app must be running for expiry to happen**; it catches up on next start.

Always make your break-glass / emergency accounts **Permanent** exclusions before turning a policy ON.

## Setup

1. **App registration** (in your own/partner tenant): Entra ID → App registrations → New, *Accounts in any organizational directory (multi-tenant)*.
   - Redirect URI (Web): `http://localhost:3000/consent-done.html`
   - Create a client secret.
   - API permissions → Microsoft Graph → **Application** permissions:
     `Policy.ReadWrite.ConditionalAccess`, `Policy.Read.All`, `Application.Read.All`, `User.Read.All`, `AuditLog.Read.All` (for the "last 5 sign-ins" column; the tenant also needs Entra ID P1/P2),
     and (only for GDAP import) `DelegatedAdminRelationship.Read.All`. Grant admin consent in your own tenant.
2. `cp .env.example .env` and fill in `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `PARTNER_TENANT_ID`.
3. `npm install && npm start`, then open <http://localhost:3000>.
4. **Add tenants** manually (name + tenant ID) or **Import from GDAP**.
5. **Per customer tenant**, an admin there must approve the app once. Open the tenant in the app; if it isn't consented the
   error shows an admin-consent link to send them.

## Sign-in (SSO) and sharing

The app signs people in with Microsoft Entra ID and accepts **only accounts from your bilan.com tenant**
(`PARTNER_TENANT_ID`). Anyone who can sign in sees the same shared tenant list and can manage exclusions for all of them;
the activity log records who did what.

1. On the app registration → **Authentication**, add a **Web** redirect URI: `<BASE_URL>/auth/callback`
   (for local use: `http://localhost:3000/auth/callback`). The delegated `User.Read` permission already covers sign-in.
2. In `.env` set `PARTNER_TENANT_ID`, and for sharing: `HOST=0.0.0.0` and `BASE_URL=https://your-address`.
   Host it on a server people can reach and put HTTPS in front of it (reverse proxy; set `TRUST_PROXY=true`).
   Sessions last 8 hours (`SESSION_HOURS`).
3. **Recommended:** limit who may sign in. In the bilan.com tenant: Entra ID → Enterprise applications → this app →
   Properties → **Assignment required = Yes**, then assign only the people or a group who should manage client tenants.
   Without that, every bilan.com user can open the app and change client Conditional Access policies.

## Run it in Azure with CI/CD (Container Apps)

Every push to `main` runs the tests, builds a container image and deploys it to **Azure Container Apps**
(`.github/workflows/deploy.yml`). This path does not use App Service VM quota.

What gets created in one resource group: a container registry (Basic), a storage account with a file share that holds
`db.json` and the session key, a Container Apps environment, and the container app (one always-on replica, HTTPS only).
Keep it at one replica: the data is a JSON file and that replica runs the expiry sweep.

One-time setup (run on your computer, signed in with `az login` as an Owner of the subscription):

```powershell
.\infra\setup-cicd.ps1 -Subscription <subscription id> -AppName usa-only-exclusion-tool -ClientId <app registration client id> -PartnerTenantId <bilan.com tenant id> -Location centralus
```

It registers the needed resource providers, creates a deployment identity that GitHub signs in as (OIDC, no stored Azure
password, Contributor on that resource group only), and sets the repository variables and the `APP_CLIENT_SECRET` secret
(through the `gh` CLI if installed, otherwise it prints them for you to paste into the repository settings).

Then push to `main` or run the **Test and deploy** workflow manually. The run summary shows the site URL. After the first deploy:

1. On the app registration → Authentication, add **Web** redirect URIs `https://<site>/auth/callback` and `https://<site>/consent-done.html`.
2. Set **Assignment required = Yes** on the Enterprise application (see Sign-in above).
3. To keep existing data, upload your local `data/db.json` to the storage account's `data` file share (portal → Storage account →
   File shares → data → Upload), then restart the container app revision.

**Custom domain:** set the repository variable `CUSTOM_DOMAIN` (e.g. `exclusionlist.bilan.com`) and run the workflow. The first run
prints the two DNS records to create (a CNAME to the app's default host name and a TXT `asuid.<name>` verification record). Once
they exist, re-run the workflow: it issues a free managed certificate, binds the domain, and switches the app's address to it.
Then register `https://<domain>/auth/callback` and `https://<domain>/consent-done.html` as redirect URIs.

During a deploy the old and new copies overlap for a moment; avoid making changes in the app while a deploy is running.

## Alternative: Azure App Service


`infra/main.bicep` + `infra/deploy.ps1` create, in one resource group: a Linux **App Service** (Node 22, Always On, HTTPS only,
health check `/healthz`), and a **Key Vault** that holds the client secret (the web app reads it through its managed identity).
Data (`db.json`, session key) lives on the App Service's persistent `/home/data`. Keep it at **one instance**: the data is a
JSON file and the instance runs the expiry sweep. Plan size B1 (about $13/month) is enough.

1. Install Azure CLI, run `az login` as an Owner (or Contributor + User Access Administrator) of the target subscription.
2. From the repo root:
   ```powershell
   .\infra\deploy.ps1 -AppName <unique-name> -ClientId <app registration client id> -PartnerTenantId <bilan.com tenant id>
   ```
   It asks for the client secret value, deploys, and prints the site URL and two redirect URIs.
3. On the app registration → Authentication, add those two **Web** redirect URIs
   (`https://<site>/auth/callback` and `https://<site>/consent-done.html`).
4. Set **Assignment required = Yes** on the Enterprise application and assign the people who may use it (see Sign-in above).
5. Move your existing data: stop the local copy, then upload `data/db.json` to `/home/data/` on the web app
   (Kudu: `https://<site-scm-host>/newui/fileManager`, or `az webapp ssh`). Otherwise re-add tenants and re-pick policies.
6. To update later: `git pull`, commit, and run `az webapp deploy -g <rg> -n <app> --src-path <zip> --type zip` (the script does this).

Consent links for customer tenants now use the site address, so send admins links from the hosted app.

## Notes

- Listens on `127.0.0.1` unless you set `HOST`. Rejects foreign `Host` headers and non-JSON writes; every page and API call except the sign-in routes needs a valid session.
- Secrets live in `.env` (git-ignored). Tracked exclusions and the audit log live in `data/db.json` (git-ignored).
- `npm test` runs the expiry tests.
