# Releasing the Nia Core Agent

Audience: whoever cuts a new `apps/agent`/`apps/agent-desktop` release.
Covers building signed installers for all three OSes, generating the
public download manifest, and publishing them. For the server-side app
release process (apps/web, apps/api, apps/worker, connectors,
agent-bridge), see `DEPLOYMENT.md`'s "Releasing" section instead — this
file is agent-only.

## 1. Bump the version

`apps/agent/package.json`'s `version` field is the single source of
truth — `pnpm run generate-version` (run automatically by `build`/`dev`/
`typecheck`/`test`) writes it into `src/generated/version.ts`'s
`AGENT_VERSION` constant, and `generate-manifest.mjs` reads the same
field to name every output file (`NiaCoreAgent-Setup-<version>.exe`,
etc.). Bump it by hand before building:

```
cd apps/agent && npm version patch --no-git-tag-version   # or minor/major
```

`apps/agent-desktop/package.json` tracks the **same** version as
`apps/agent` — one product version. Bump both together:

```
cd apps/agent-desktop && npm version patch --no-git-tag-version   # or minor/major, matching apps/agent
```

## 2. Required secrets

All of these are read directly from the environment by
`apps/agent/packaging/{windows,macos}/sign.mjs` — nothing to configure
beyond setting them before running the build. Missing a whole group
is fine for a **dev build** (each script warns and proceeds unsigned);
`package:release` (step 4) turns that into a hard failure unless you
explicitly opt out.

### Windows — pick one signing mode

**Azure Trusted Signing (preferred).** No local key material; requires
the [`sign` CLI](https://github.com/dotnet/sign) (installed
automatically by `sign.mjs` via `dotnet tool install`, so the `.NET SDK`
must be on `PATH` — `brew install dotnet` locally, `actions/setup-dotnet`
in CI).

| Var | What it is |
|---|---|
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | e.g. `https://wus2.codesigning.azure.net` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | the Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_CERT_PROFILE` | the certificate profile name |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | service-principal auth for the Azure SDK's `DefaultAzureCredential` chain |
| `AZURE_TRUSTED_SIGNING_TIMESTAMP_URL` | optional, defaults to `http://timestamp.acs.microsoft.com` |

**Classic `.pfx` (fallback)**, via `osslsigncode` (installed
automatically through Homebrew if missing, on a machine that has `brew`):

| Var | What it is |
|---|---|
| `WINDOWS_CERT_PFX_BASE64` | base64 of the `.pfx` file (`base64 -i cert.pfx \| pbcopy`) |
| `WINDOWS_CERT_PASSWORD` | the `.pfx`'s export password |
| `WINDOWS_CERT_TIMESTAMP_URL` | optional, defaults to DigiCert's RFC3161 TSA |

### macOS — Developer ID + notarization

Requires a real macOS host (codesign/notarytool have no cross-platform
equivalent) with Xcode Command Line Tools installed.

| Var | What it is |
|---|---|
| `APPLE_DEVELOPER_ID_APPLICATION` | codesign identity string, e.g. `"Developer ID Application: Nia Core, Inc. (TEAMID)"` |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |
| `APPLE_NOTARIZATION_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_NOTARIZATION_API_KEY_ISSUER_ID` | App Store Connect API key issuer UUID |
| `APPLE_NOTARIZATION_API_KEY_P8_BASE64` | base64 of the `.p8` private key file |

Signing without the notarization group set still produces a
Gatekeeper-runnable build (slower first-launch online check instead of a
stapled ticket) — a soft warning, not a failure. Neither group set at all
is the same unsigned/ad-hoc-signed behavior as before this phase.

Linux has no signing step — nothing to configure there.

## 3. Build

From the repo root, build every workspace dependency once, then package
per OS:

```
pnpm -r --filter @nia/extract --filter @nia/agent build

# Electron shell — electron-builder only packages the host OS's own
# target, so run this once per OS you're releasing for, on that OS:
pnpm --filter @nia/agent-desktop package
```

Then, from `apps/agent`:

```
pnpm run package:release        # --release: hard-fails if any built platform is unsigned
# or, for a deliberate unsigned test build:
pnpm run package:release -- --allow-unsigned
# or, for an ordinary dev build (signs opportunistically, never fails):
pnpm run package:build
```

This orchestrates (`packaging/build-release.mjs`): Windows SEA build +
sign → NSIS installer build + sign; macOS SEA build + codesign + notarize
→ app bundle codesign + notarize; then regenerates
`packaging/manifest.json` off whatever's actually on disk (this always
runs, even picking up a Linux build this command didn't itself produce).
Useful flags: `--target=windows` / `--target=macos` (build one platform
only — macOS artifacts can only be built when running ON macOS),
`--no-desktop` (skip the Electron shell, service-only artifacts).

Linux has its own separate build, not part of this orchestrator:
```
./apps/agent/packaging/linux/build-bundle.sh
```

A `--release --allow-unsigned` build drops an `UNSIGNED-TEST-BUILD.txt`
marker into that platform's `dist/` directory — never ship a release
that has one.

## 4. Publish

Copy these files (named per the version you just built) into the
directory mounted at nginx's `/usr/share/nginx/agent-downloads/` on the
production host (the target of the `alias` in `deploy/nginx/nginx.conf`
— see `DEPLOYMENT.md`'s "Agent downloads" section for the full
request-time resolution logic):

- `apps/agent/packaging/manifest.json`
- `apps/agent/packaging/windows/dist/NiaCoreAgent-Setup-<version>.exe`
- `apps/agent/packaging/windows/dist/nia-agent-windows-<version>.zip` (advanced/portable download)
- `apps/agent/packaging/macos/dist/nia-agent-macos-arm64-<version>.zip`
- `apps/agent/packaging/linux/dist/nia-agent-linux-<version>.tar.gz`

`AGENT_DOWNLOADS_BASE_URL` (root `.env`, shared byte-identical by
`niacore-web` and `niacore-agent-bridge` — see `.env.production.example`)
must already point at that same public `/downloads/agent` address; it
doesn't need changing per release, only set once. No redeploy of either
service is needed for a new version to go live — both read the manifest
fresh on every request.

Once published, any already-paired agent picks this up automatically
within a few hours (or immediately via its own Settings → **Check now**)
through its periodic `GET /agent-api/update` check — see
`apps/agent/src/link/updateChecker.ts` and `docs/pilot/runbook.md`'s
"Updates" section for the customer-facing side of this.

## 5. Verify

- `pnpm --filter @nia/agent build && pnpm --filter @nia/agent-desktop build` still pass.
- `pnpm --filter @nia/agent test` / `pnpm --filter @nia/agent-bridge test` pass, including the auto-update test additions.
- `.github/workflows/agent-windows-smoke.yml` (dispatch manually, or on its own triggers) exercises the full installed-service lifecycle on a real Windows VM, including a real pairing + auto-update round trip (CHECK 8) against a throwaway rebuilt installer — not a substitute for a real signed release, but the closest thing to one that runs in CI.
- Real Authenticode/notarization verification needs real Azure/Apple credentials this sandbox doesn't have — this can only be confirmed once a release actually runs with real secrets configured (CI or a release engineer's machine), not in this repo's own test environment.
