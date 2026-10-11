# Release v1.2.2

## Known issues

- `apps/web`'s `lint` script (`next lint`) has no ESLint config anywhere in
  this repo's history — `next lint` just prompts interactively to create
  one. This is pre-existing, not a regression introduced by this release.
  Lint is skipped for this release; adding a config is a separate,
  deliberate follow-up, not done ad hoc here.

## Env changes

- `REDIS_URL` — now required on the production **web** container (not just
  `api`/`worker`). Phase 3's mail-on-approve/reject enqueueing
  (`apps/web/src/lib/auth/auth.ts`, `apps/api/src/lib/mailQueue.ts`) runs
  BullMQ/ioredis from the web process too, so it must point at the same
  Redis instance as `api`/`worker`. Set it in the deploy env, no value here.
- `CONSOLE_ENABLED=true` — enables the superadmin Console app
  (`apps/web`/`apps/api`). Required for staff login, members/plan grants,
  and the platform dashboard to be reachable.
- `SIGNUP_MODE=request` — gates new-account creation behind an approved
  access request or platform invite (Email Phase 3). Omit or set to `open`
  to restore the pre-Phase-3 behavior (anyone can sign up directly).
- `MAIL_TRANSPORT=smtp` — selects the SMTP transport in `@nia/mail`
  (`log` is the no-op dev default; `graph` is the Microsoft Graph
  alternative). Required for OTP/access-request/contact-form emails to
  actually send in production.
- `SMTP_HOST=smtp.example.com`
- `SMTP_PORT=587`
- `SMTP_SECURE=false`
- `SMTP_USER=postmaster@example.com`
- `SMTP_PASS=`                          — SECRET, no value here
- `SMTP_FROM=notifications@example.com`
- `CONTACT_TO_EMAIL=support@tecnots.com` — where the landing page's "Talk
  to us" form sends its notification email (defaults to this value if
  unset). Reply-To on that email is always the submitter's own address.

## Agent downloads (0.0.7)

Production's `AGENT_DOWNLOADS_BASE_URL` already points at Azure Blob
Storage, not the `niacore-proxy`/nginx-mounted directory described in
`RELEASE.md`'s "Publish" step and `DEPLOYMENT.md`'s "Agent downloads"
section — that nginx path is the **old** method and is no longer what's
actually live. Both `apps/web` (`packages/schemas/src/downloadManifest.ts`,
via `apps/web/src/lib/downloads/manifest.ts`) and `services/agent-bridge`
resolve every download URL as `${AGENT_DOWNLOADS_BASE_URL}/<file>` and the
manifest itself as `${AGENT_DOWNLOADS_BASE_URL}/manifest.json` — there is
no other server-side logic involved, so "upload the right files to the
right blob prefix, then point the env var at that prefix" is the entire
mechanism.

### 1. Build artifacts + regenerate the manifest

From repo root, after the usual per-platform build steps (see `RELEASE.md`
§3):

```
node apps/agent/packaging/generate-manifest.mjs
cd ~/Desktop/nia-core-agent-0.0.7   # wherever SHA256SUMS.txt/INSTALL-NOTES.md live for this release
```

Confirm `apps/agent/packaging/manifest.json`'s `version` is `0.0.7` before
continuing.

### 2. Upload to Azure (account `albizmedia`, container `nia-core`)

Upload every artifact for this release — the four built packages, plus
`manifest.json` and `SHA256SUMS.txt` — to **both** a version-pinned prefix
(permanent archive, lets you roll back by just repointing the env var) and
`latest/` (what `AGENT_DOWNLOADS_BASE_URL` will actually point at):

```
set -a; source ~/.nia-core-secrets/azure-albizmedia.env; set +a   # AZURE_STORAGE_KEY — never print it

az storage blob upload-batch \
  --account-name albizmedia \
  --destination nia-core/agent-downloads/0.0.7 \
  --source ~/Desktop/nia-core-agent-0.0.7 \
  --pattern "*" \
  --content-type "application/octet-stream" \
  --overwrite

az storage blob upload-batch \
  --account-name albizmedia \
  --destination nia-core/agent-downloads/latest \
  --source ~/Desktop/nia-core-agent-0.0.7 \
  --pattern "*" \
  --content-type "application/octet-stream" \
  --overwrite
```

Then fix the content-type on the two JSON/text files in **both** prefixes
(uploaded above as `application/octet-stream`, which works but isn't
correct — `manifest.json` is fetched directly by `downloadManifest.ts`'s
`fetch()`, and a wrong content-type on it is the one file where that could
matter to a stricter client down the line):

```
for prefix in 0.0.7 latest; do
  az storage blob update --account-name albizmedia \
    --container-name nia-core --name "agent-downloads/$prefix/manifest.json" \
    --content-type "application/json"
  az storage blob update --account-name albizmedia \
    --container-name nia-core --name "agent-downloads/$prefix/SHA256SUMS.txt" \
    --content-type "text/plain"
done
```

### 3. Point production at `latest/` (one-time; skip if already done)

If `AGENT_DOWNLOADS_BASE_URL` is still pinned to a specific old version
(e.g. `.../agent-downloads/0.0.5`), change it once to the rolling alias so
future releases only need step 2 re-run, no env change or redeploy:

```
AGENT_DOWNLOADS_BASE_URL=https://albizmedia.blob.core.windows.net/nia-core/agent-downloads/latest
```

Set in the root `.env` that `niacore-web` and `niacore-agent-bridge` both
read via `env_file:` (`docker-compose.prod.yml`) — byte-identical for both,
same as every other release. Redeploy both services after changing it (not
needed again for 0.0.8+ as long as it stays pointed at `latest/`).

### 4. Verify

- `curl -sI https://albizmedia.blob.core.windows.net/nia-core/agent-downloads/latest/manifest.json`
  → `200`, and the body's `"version"` is `0.0.7`.
- For each of the 4 artifact files: `curl -sI .../latest/<file>` → `200`
  with a `Content-Length` matching `SHA256SUMS.txt`.
- Load the production downloads page — it should show version `0.0.7` and
  every "Download for ..." link should resolve (no 404).
- An already-paired agent's **Settings → Check now** should report the new
  version available.

(Nginx's `/usr/share/nginx/agent-downloads/` + the `alias` in
`deploy/nginx/nginx.conf`, as described in `RELEASE.md`/`DEPLOYMENT.md`, is
legacy and not what production actually serves from — don't bother copying
files there for this release.)

## Super admin

Goal: `shubranshu.shekhar@tecnots.com` becomes the **only** active
platform super admin (`public.platform_staff`, `revoked_at is null`) in
production. No password is ever typed in chat, a shell command, or
shell history — the account owner sets their own password afterwards via
"Forgot password" or an email-code sign-in.

All commands run **inside the `niacore-api` container** on the VPS
(`docker exec`), since that's the only place `DATABASE_URL`/
`BETTER_AUTH_SECRET` are configured and `dist/scripts/manageStaff.js`
(the only sanctioned writer of `platform_staff` — never via any HTTP
route) lives.

### 1. See who's currently active staff

```
docker exec -it niacore-api node dist/scripts/manageStaff.js list
```

Note every email that shows `[active]` — each one gets revoked in step 4.

### 2. Create the account, if it doesn't already exist

Generates a random password **in-memory only**, inside the container,
and never prints/logs/saves it. Better Auth requires some password at
signup time, but it's immediately thrown away — `shubranshu.shekhar@tecnots.com`
will never know it and must use "Forgot password" or an email-code
sign-in to get in, same as any normal account recovery.

```
docker exec -it niacore-api node --input-type=module -e "
import { auth } from './dist/lib/auth.js';
import { dbPool } from './dist/lib/dbPool.js';
import crypto from 'crypto';
const email = 'shubranshu.shekhar@tecnots.com';
const existing = await dbPool.query('select id from \"user\" where lower(email) = lower(\$1)', [email]);
if (existing.rows[0]) {
  console.log('already exists:', email, '->', existing.rows[0].id);
} else {
  const randomPassword = crypto.randomBytes(24).toString('base64');
  const result = await auth.api.signUpEmail({ body: { email, password: randomPassword, name: 'Shubranshu Shekhar' } });
  console.log('created:', email, '->', result.user.id);
}
await dbPool.end();
"
```

(`apps/api` is `"type": "module"` and the deployed image's `dist/` is
ESM, hence `node --input-type=module`. Run from `/app` inside the
container — that's `WORKDIR` in `apps/api/Dockerfile`, so the relative
`./dist/...` paths above resolve correctly as-is.)

### 3. Grant super admin

Use any email from step 1's active list as `--by` (it just has to be a
*currently active* staff row — the script checks that directly against
`platform_staff`, no password/login involved):

```
docker exec -it niacore-api node dist/scripts/manageStaff.js grant shubranshu.shekhar@tecnots.com --by <an-active-staff-email-from-step-1>
```

### 4. Revoke every other active staff account

Repeat for each email noted in step 1 (now using the newly-granted
account as `--by`, since it just became active):

```
docker exec -it niacore-api node dist/scripts/manageStaff.js revoke <other-staff-email> --by shubranshu.shekhar@tecnots.com
```

### 5. Confirm it's the only active super admin

```
docker exec -it niacore-api node dist/scripts/manageStaff.js list
```

Expect exactly one `[active]` row: `shubranshu.shekhar@tecnots.com`.
Every other email should show `revoked ... by shubranshu.shekhar@tecnots.com`.

### 6. Set a password

With SMTP working on the production domain, `shubranshu.shekhar@tecnots.com`
uses **"Forgot password"** (or an email sign-in code, if that login
method is enabled) on the live site to set their own password. No one
else ever sees or sets it.
