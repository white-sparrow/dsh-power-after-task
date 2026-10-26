# Contributing

Small plugin, plain JavaScript, no dependencies, no build step.

## Setup and checks

```sh
git clone https://github.com/white-sparrow/dsh-power-after-task
cd power-after-task
npm run check        # node --check on index.js + client.js
```

CI runs `npm run check` on Node 20 for every push and PR; keep it green.

## Working on the plugin

- `index.js` is the Host half (route, session watcher, countdown, power
  commands, tool); `client.js` is the Web UI half (dock control, overlay
  ribbon). Plugin code cannot call either directly — keep that split.
- UI colours must use `--dsw-alias-*` / `--dsw-specific-*` tokens, never
  hardcoded hex values, so dark and light themes both work.
- Keep the dock entry compact: icon when idle, inline drop-downs on click,
  hover text instead of status lines.

## Local debugging

- `GET http://127.0.0.1:<port>/power-task/debug` — sessions running/armed,
  server origin, and headers of the last GET and the last POST with
  `accepted` (did the guard pass?). Never returns any credential material.
- Client bundle changes need one browser refresh; Host changes apply when
  the plugin is reloaded (disable + enable the row).
- A Host restart clears pending arms — re-arm after testing.

## Releases

Releases use npm **staged publishing**; the maintainer token is
staging-only, and approval (2FA) is done by a human:

```sh
npm run stage            # 1) bump version + CHANGELOG, then stage the build
npm run stage:list       # 2) find the stage id
npm run stage:approve <stage-id>   # 3) you do this: it asks for a 2FA code
```

`scripts/npm-auth.mjs` reads `NPM_TOKEN` from `.env` (never committed —
`.env.example` documents the format), uses a throwaway owner-only npmrc in
the temp directory, and pins npm 11 under `.npm-tools/` because `npx
npm@11 -- stage …` misroutes arguments. Nothing prints the token; revoke
the token after use.

Tag releases as `v<version>` after approval; GitHub Releases carry the
`npm pack` tarball.

## Pull requests

Fill the template; include what + why, a CHANGELOG entry for user-facing
changes, and a screenshot for UI changes.
