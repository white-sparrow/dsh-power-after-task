# dsh-power-after-task

[![npm](https://img.shields.io/npm/v/dsh-power-after-task?logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/dsh-power-after-task)
[![license](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![CI](https://github.com/white-sparrow/dsh-power-after-task/actions/workflows/ci.yml/badge.svg)](https://github.com/white-sparrow/dsh-power-after-task/actions/workflows/ci.yml)

Windows **Sleep / Shut down / Restart** after the current agent task finishes — a compact, disabled-by-default DeepSeek Harness plugin.

Nothing happens on its own: the power command only runs after you press **Arm**, the agent has actually stopped working, and the grace countdown expires. **Cancel** at any point returns it to off.

## Requirements

- **Windows** host — power commands are Windows-specific; other platforms are rejected with an error.
- **Web composition** (`dsh web`): the dock control talks to the Host over this plugin's own HTTP route; a Desktop page has no web server, so no control appears there.
- Node 20+ for the Harness Host. No build step, no dependencies.

## Install and enable

```
Plugin Manager → Install bundle → dsh-power-after-task
```

The bundle's patch inserts the plugin row with `disabled: true`, so installing changes nothing else. Enable when you need it via **Settings → Plugins → Power after task**; the dock entry appears within about two seconds, and disabling the row (which also clears every pending arm) removes it again — no page refresh needed.

## UI

One entry in the composer dock, beside Activity and Usage:

- **Idle** — just a small power icon.
- **Click** — expands inline into two drop-downs (Action, Grace) and an **Arm** button.
- **Armed** — icon shrinks and lights up (brand while waiting, amber while counting), a **Cancel** button appears; hover shows action + remaining time. No status text by design.

While a countdown runs, a wide semi-transparent ribbon (registered in `shell.overlay`) shows a large `m:ss.mmm` timer, a tiny `Until sleep / Until shut down / Until restart` caption, and a **Cancel** button. The layer is click-through — only Cancel takes pointer events — and a failed power command keeps the ribbon visible with the error.

All colours are `--dsw-alias-*` theme tokens, so dark/light follows the Harness theme automatically.

## When the task counts as finished

The task is the whole span between your prompt and the agent's turn stop — across steps, continuations, and subagents. It counts as finished when the agent answers, errors out without a result, or you cancel; also if the session is archived/removed while armed. It does **not** fire while a goal driver or continuation is still running, and any new message puts the countdown back to waiting. Detection uses the session-status signal (`api-session/status`), not a guess.

```
Arm → waiting → agent goes idle → grace countdown → power command
      ↑ new activity returns here                Cancel → off
```

**Grace** (default 45 s, choices 15 s / 30 s / 1 m / 2 m / 5 m, cap 3600 s) is the cancellable gap between "finished" and "fires" — long enough to rescue a mis-click or unsaved work.

Commands run: `shutdown.exe /s /t 0`, `shutdown.exe /r /t 0`, or Sleep via `kernel32!ApplicationSuspend` (deliberately not `rundll32 SetSuspendState`, which hibernates when hibernation is enabled; `rundll32` is only the fallback).

## Agent tool

`power_after_task` — `action: status | arm | cancel | execute`, `session`, `power: sleep | shutdown | restart`, `grace_seconds`. `execute` fires immediately and is not reachable from the HTTP route; the page can only Arm and Cancel.

## Configuration

Set in `cordis.patch.yml` (override with your own patch):

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultAction` | `shutdown` | Preselected action: `sleep` · `shutdown` · `restart` |
| `graceSeconds` | `45` | Countdown after finish; capped at 3600 |

## Security

Arm/Cancel refuse requests that *prove* they are not this page: non-loopback `Host` (DNS rebinding), browser-reported cross-site `Sec-Fetch-Site`, or non-loopback `Origin`. Requests carrying none of that evidence pass — that is the Harness page transport (it forwards `Cookie` but not fetch metadata) or a local process, which could run `shutdown.exe` directly anyway. Route: `POST /power-task/arm`, `POST /power-task/cancel`, `GET /power-task/state`, `GET /power-task/debug`. See [SECURITY.md](SECURITY.md).

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: `/power-task` route, session watcher, countdown, Windows power commands, tool |
| `client.js` | UI half: composer-dock control + `shell.overlay` countdown ribbon |
| `cordis.patch.yml` | Plugin row, disabled by default, with `config` |
| `locale/en.json`, `locale/fa.json` | Plugin Manager title/description |
| `icon.svg` | Plugin Manager artwork |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No dock entry | Row is disabled — enable it in Settings → Plugins |
| Arm answers `403` | Read `GET /power-task/debug` → `lastPost`: `host`, `secFetchSite`, `origin`, `accepted`. A non-loopback `host` means a proxy or foreign hostname |
| Ribbon missing after upgrade | Refresh the page once to load the new client bundle |
| `… failed` in the ribbon | Command rejected — power settings, hibernation/fast-startup, shutdown privileges; Cancel clears state |
| Nothing fires | Session is still running (goal continuation, subagent, queued message) |

## Development and releases

See [CONTRIBUTING.md](CONTRIBUTING.md) — checks (`npm run check`), local debugging, and the staged npm release flow.

## License

MIT — see [LICENSE](LICENSE).
