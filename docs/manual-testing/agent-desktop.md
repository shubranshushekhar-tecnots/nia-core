# Manual end-to-end testing: Nia Agent Desktop (Electron shell)

Hand-drive the Electron shell (`apps/agent-desktop`) against a throwaway,
foreground agent service — no packaging, no admin/root, nothing that
touches a real install or the dev DB. All commands below run from the
repo root unless noted.

**Before you start:** point the agent's config dir at a scratch directory
(same convention as `docs/manual-testing/agent.md`) and export it in
*every* terminal you use below, including the one that launches Electron:

```bash
export NIA_AGENT_HOME=/tmp/nia-agent-desktop-manual
```

You'll use **2 terminals**: (A) the agent service itself (foreground); (B)
the Electron shell.

---

## 1. Build and start the agent service (terminal A)

```bash
export NIA_AGENT_HOME=/tmp/nia-agent-desktop-manual
pnpm --filter @nia/agent run dev start
```

Leave this running. (You don't need a real SQL Server connection paired
for most of the checks below — an unpaired agent is enough to exercise
the window/tray/relaunch/offline-screen behavior; pair one only if you
want to see the colored tray states beyond grey/amber.)

## 2. Build and launch the desktop shell (terminal B)

```bash
export NIA_AGENT_HOME=/tmp/nia-agent-desktop-manual
pnpm --filter @nia/agent-desktop run dev
```

**What you should see:** a window opens loading the agent's own UI (same
OTC→session flow as the browser-based `nia-agent open`), and a tray icon
appears (menu bar on macOS, system tray on Windows) colored grey/amber
depending on pairing state.

## 3. Tray menu + status polling

Click the tray icon's "Open Nia Agent" item with the window closed/hidden
— it should reopen. Check the status line in the tray menu updates within
~15s of pairing/unpairing a connection (or stopping terminal A).

## 4. Close-to-tray (not quit)

Click the window's **X**. **What you should see:** the window disappears
but the tray icon remains and terminal A (the agent service) keeps
running untouched. Click "Open Nia Agent" in the tray — the window
reopens without re-pairing.

## 5. Quit actually quits

From the tray menu, click **Quit**. **What you should see:** both the
window and the tray icon disappear, and the Electron process exits —
confirm with `ps aux | grep -i "Nia Agent"` (nothing left). Terminal A
(the agent service) is untouched — this app only ever controls the
*shell*, never the background service.

## 6. The MUST-PASS relaunch check

This is the one real customer bug (fixed in `fe07ebc`) this app must
never regress. However it was closed, relaunching the app must always
reopen a window — never silently do nothing:

- Close via **X**, then relaunch (`pnpm --filter @nia/agent-desktop run dev` again, or double-click the packaged app). **What you should see:** the *existing* hidden instance is focused (no second process, no second tray icon) — confirm with `ps aux | grep -i electron` showing only one tree before and after.
- Click **Quit** from the tray, then relaunch fresh. **What you should see:** a brand new window + tray icon, pairing state intact.
- Kill it hard (`pkill -9 -f "agent-desktop"` or Task Manager → End Task on Windows) while the window is open, then relaunch. **What you should see:** a clean new window — no leftover zombie tray icon, no "already running" error.

## 7. Service-not-running screen + retry

Stop terminal A (`Ctrl+C`), then click "Open Nia Agent" in the tray (or
relaunch). **What you should see:** a plain-language "Nia Agent service
isn't running" screen — no stack traces, no `ECONNREFUSED`, no raw
technical wording — with a **Retry** link. Restart terminal A, then
either click Retry or just wait a few seconds (it auto-retries): the
screen should silently replace itself with the real UI once the service
is back, no manual window close/reopen needed.

## 8. Navigation allow-list

From inside the loaded UI, try opening any link that points off
`127.0.0.1:<port>` (e.g. a documentation link, if one exists in the UI).
**What you should see:** it opens in your normal default browser, not
inside the Electron window.

## 9. Start-at-login toggle

Open the tray menu, click **Start at login** to toggle it off, then back
on. On macOS, confirm via System Settings → General → Login Items; on
Windows, via Task Manager → Startup apps. (First-ever run of the app
enables this automatically — toggling it off and relaunching should
*not* silently re-enable it, since that's a one-time default, not an
enforced setting.)

## 10. Window size/position memory

Resize and move the window, then close to tray and reopen (or fully
quit and relaunch). **What you should see:** the window reopens at the
same size/position. Then try it after disconnecting an external
monitor the window was on — it should reposition onto a display that's
actually still connected, not open off-screen.

## 11. Tear down

- Terminal B: Quit from the tray menu.
- Terminal A: `Ctrl+C`.
- Optional: `rm -rf /tmp/nia-agent-desktop-manual`.

---

## Reference

| Command | What it does |
| --- | --- |
| `pnpm --filter @nia/agent-desktop run dev` | Build + launch the Electron shell against `$NIA_AGENT_HOME` |
| `pnpm --filter @nia/agent-desktop run typecheck` | `tsc --noEmit` |
| `pnpm --filter @nia/agent-desktop run test` | Unit tests (pure logic only — no Electron runtime needed) |
| `pnpm --filter @nia/agent-desktop run package` | Builds + runs `electron-builder` (dir target only — produces an unpacked app under `dist-electron/`, not an installer) |

Packaging note: `pnpm --filter @nia/agent-desktop run package` only
produces the raw unpacked app (`dist-electron/win-unpacked` or
`dist-electron/mac*`). The real installers remain
`apps/agent/packaging/windows/build-installer.mjs` (NSIS) and
`apps/agent/packaging/macos/build-bundle.mjs` (zip + `install.sh`), which
both now stage this app's output automatically if the `package` step has
been run first — see those scripts' own comments.
