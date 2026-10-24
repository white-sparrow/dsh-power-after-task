# dsh-power-after-task

A DeepSeek Harness (DSH) plugin that puts the host Windows PC to **Sleep**, **Shuts it down**, or **Restarts** it once the current agent task finishes — with a cancellable grace countdown, controlled from one small button in the composer dock.

It never acts on its own. Nothing happens until you press **Arm**, and the power command only runs after the session's agent has actually stopped working *and* the grace countdown has run out.

**Repository:** <https://github.com/white-sparrow/dsh-power-after-task>

## What counts as "the task finished"

The task is the span of work between your prompt and the moment the agent stops producing work — however many steps (tool calls), turns, continuations, or subagents it took. It ends on any turn stop:

| Situation | Treated as finished |
| --- | --- |
| The agent answered and stopped | yes |
| The agent stopped with an error and showed no result | yes |
| You cancelled the run | yes |
| A goal driver or auto-continuation is still running the session | no |
| You send another message while the countdown is running | no — the countdown goes back to waiting |
| The session is archived or removed while armed | yes |

The plugin watches the Harness session-status signal (`api-session/status`), so it follows the real agent lifecycle rather than a guess about "the answer being visible".

## Arm and Grace

- **Arm** — registers the request for one session: "when this session's task finishes, run the chosen power action". Until you Arm, the plugin is inert.
- **Grace** — a cancellable delay between "the task finished" and "the command runs" (default 45 seconds). It exists so a mis-click, a late follow-up message, or unsaved work can still be rescued. Choices: 15s, 30s, 1m, 2m, 5m.
- **Cancel** — stops the arm at any time, while waiting or while counting.

```
Arm → waiting for the task to finish → agent goes idle → grace countdown → power command
        ↑ any new activity returns here                                   │ Cancel → off
```

Commands actually run: `shutdown.exe /s /t 0` (Shut down), `shutdown.exe /r /t 0` (Restart), or `kernel32!ApplicationSuspend` via PowerShell with a `rundll32 powrprof.dll,SetSuspendState 0,0,0` fallback (Sleep). Sleep uses `ApplicationSuspend` deliberately: the `rundll32` form hibernates whenever hibernation is enabled.

## The control in the UI

### Composer-dock control

One entry in the composer dock, beside the shipped Activity and Usage entries:

- **Idle** — a single power icon. Nothing else.
- **Click** — expands inline into two drop-downs (Action, Grace) and an **Arm** button.
- **Armed** — the icon shrinks, lights up (brand colour while waiting, amber while counting or failed), and a **Cancel** button appears. No status text is printed; hovering the icon shows the action and the remaining countdown.
- **Disabled row** — the entry removes itself within a couple of seconds, whether you enable or disable it, because the widget probes the plugin route.

### Countdown ribbon

While a countdown is running, a wide semi-transparent ribbon sits across the middle of the frame (registered in `shell.overlay`):

- A large `m:ss.mmm` timer — minutes, seconds, milliseconds — updated on animation frames.
- A tiny line under it naming the target: `Until sleep`, `Until shut down`, `Until restart`.
- A **Cancel** button, because the arm stays visible until the countdown finishes or you cancel it.

The layer itself is click-through: only the Cancel button takes pointer events, so the ribbon never blocks the work you are still doing. A failed power command keeps the ribbon visible with the error instead of silently returning to normal.

Every colour is a `--dsw-alias-*` theme token (`bg-overlay`, `brand-primary`, `state-warn-primary`, `state-error-primary`, `label-*`, `border-*`), mixed with `transparent` for the semi-transparent surfaces, so the plugin follows the Harness light/dark setting automatically.

## Requirements

- **Windows** host (the power commands are Windows-specific). On other platforms the action is rejected with an error.
- **Web composition** (`dsh web`): the dock widget talks to the Host through this plugin's own HTTP route. A Desktop/Electron page has no `ctx.webServer`, so the control does not appear there.
- Node 20+ for the Harness Host.

## Install

Publish or unpack the package, then install the bundle in the Harness profile:

- **Plugin Manager UI** → Install bundle → `dsh-power-after-task`.
- Or from an agent session, ask it to install the bundle with the `plugin_manager` tool.
- Or from a checkout: `plugin_manager` install target pointing at the directory (pnpm links it, no build step — the package ships plain JavaScript).

The bundle ships a composition patch (`dsh.bundle.patch`) that inserts the plugin row. Installing does **not** turn it on.

## Enable it when you need it

The row ships `disabled: true`, so after install nothing runs and the dock entry does not appear:

1. Settings → Plugins → **Power after task** → enable. The entry appears within a couple of seconds, and disabling the row removes it again — no page refresh needed either way.

Arm and Cancel are mutating, so they run only for a request that is addressed to the local Harness address (`127.0.0.1`, `localhost`, `::1`) **and** carries evidence of being a page request (`Sec-Fetch-Site: same-origin`, or an `Origin` matching this server). Anything else — a foreign web page, a DNS-rebinding attack, a stray local process — gets `403`. Turning the row off clears every pending arm and countdown.

## Configuration

The row's `config` lives in `cordis.patch.yml` inside the package; override it with your own patch if you want different defaults.

| Field | Default | Meaning |
| --- | --- | --- |
| `defaultAction` | `shutdown` | Action the control preselects: `sleep`, `shutdown`, `restart` |
| `graceSeconds` | `45` | Countdown length after the task finishes; capped at 3600 |

## Agent tool

The plugin also registers one tool, so you can ask your agent to do the same thing:

`power_after_task` — `action: status | arm | cancel | execute`, `session`, `power: sleep | shutdown | restart`, `grace_seconds`.

`execute` runs the action immediately and is deliberately **not** reachable from the HTTP route: the page can only Arm and Cancel.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: `/power-task` route, session-status watcher, countdown, Windows power commands, `power_after_task` tool |
| `client.js` | Web UI half: the composer-dock control and the `shell.overlay` countdown ribbon |
| `cordis.patch.yml` | The plugin row, disabled by default, with its `config` |
| `locale/en.json`, `locale/fa.json` | Plugin Manager title and description (`meta.title`, `meta.description`) |
| `icon.svg` | Plugin Manager artwork |

No build step, no dependencies.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No dock entry | The row is disabled — enable it in Settings → Plugins; the entry appears within a couple of seconds |
| Arm answers `answered 403` | The request did not look like it came from the page: open Harness through its own local address, not a proxy or a foreign hostname |
| Ribbon does not appear after upgrading the plugin | Refresh the page once so the browser loads the new client bundle |
| Ribbon keeps counting after the task should be protected | That is the design: it counts until the command runs, you Cancel it, or new activity pauses it back to waiting |
| `… failed` in the ribbon | The Host could not run the command — check power settings, hibernation/fast-startup, or shutdown privileges; Cancel clears the state |
| Nothing happens when the task ends | The session is still running (a goal continuation, a subagent, or a queued message keeps it `running`) |
| Control missing on the Desktop app | Expected: that composition has no web server |

## License

MIT — see `LICENSE`.
