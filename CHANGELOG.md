# Changelog

All notable changes to `dsh-power-after-task` are documented here.

## 1.0.0

Initial release.

- Arm one Windows power action per session — `sleep`, `shutdown`, or `restart` — and run it when that session's task finishes.
- Completion is the session's Agent going idle (`api-session/status`), so an error stop, a cancellation, or an archived session all count; any new activity puts the arm back to waiting.
- Cancellable grace countdown between completion and the power command, defaulting to 45 seconds and capped at 1 hour.
- Composer-dock control: one power icon that expands inline into Action and Grace drop-downs plus Arm; while armed it prints nothing but a smaller lit icon and Cancel.
- Frame-wide countdown ribbon in `shell.overlay`: semi-transparent band, a large `m:ss.mmm` timer on animation frames, a tiny `Until sleep` / `Until shut down` / `Until restart` caption, and a Cancel button. Click-through everywhere else, so it never blocks the page.
- The arm stays visible until the countdown runs successfully or you cancel it; a failed power command reports a `failed` state instead of silently returning to normal.
- Enabling or disabling the plugin row adds or removes the dock entry live — the widget probes this package's route.
- All colours come from `--dsw-alias-*` theme tokens, so the UI follows the Harness light/dark setting.
- Plugin row ships `disabled: true`: enable it in Settings → Plugins when you need it.
- Plugin-owned `/power-task` route. Mutating endpoints refuse a request that proves it is not the page — a non-loopback `Host`, a browser-reported cross-site `Sec-Fetch-Site`, or a non-loopback `Origin` — while accepting the page's own transport, which forwards `Cookie` but no fetch metadata. The route cannot run a power action immediately.
- `GET /power-task/debug` reports sessions, origin, and the headers of the last read and mutating request, so a rejected Arm is diagnosable without a browser console.
- `power_after_task` agent tool: `status`, `arm`, `cancel`, `execute`.
- English and Persian locale dictionaries plus Plugin Manager title, description, and icon.
- Local publish helper: `npm run publish:local` reads `NPM_TOKEN` from a gitignored `.env`, publishes through a throwaway owner-only npmrc, and deletes it afterwards.
