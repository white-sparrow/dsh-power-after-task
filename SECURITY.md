# Security Policy

## Reporting a vulnerability

Use **private vulnerability reporting** on GitHub: open an advisory draft at
<https://github.com/white-sparrow/dsh-power-after-task/security/advisories/new>.
Do not open a public issue for anything involving the `/power-task` route,
the arm/cancel guard, or the countdown firing.

## Supported versions

| Version | Status |
| --- | --- |
| latest | fully supported |
| previous | supported until a fix for the latest exists |

## Threat model, briefly

- The route is served by the Harness Host on a **loopback** address.
- Arm and Cancel refuse requests that prove they are not this page:
  non-loopback `Host` (DNS rebinding / foreign vhost), a browser cross-site
  `Sec-Fetch-Site`, or a non-loopback `Origin`.
- A request with none of that metadata is accepted: the plugin's own page
  transport forwards `Cookie` but not `Sec-Fetch-*`/`Origin`, and a local
  process already has the right to run `shutdown.exe` directly.
- The destructive `execute` mode exists only as an agent tool call, never
  on the HTTP surface.
- Disabling the plugin row clears every pending arm and countdown.
- Every action requires an explicit user Arm; the plugin never schedules
  power actions by itself.

## Known limitations

- Any local process able to bind the loopback port can post to the route;
  at that point it could run the OS power commands directly as well.
- A user-approved countdown is not revocable by anything except Cancel
  from the page or the tool — that is intentional.
