/**
 * Publish this package to npm using a token from `.env`.
 *
 * The token is read from `.env` (or `NPM_TOKEN` in the environment) and written
 * into a throwaway `.npmrc` under the user's temp directory, with owner-only
 * access, immediately before the publish and deleted right after it — npm
 * 10.x ignores `${VAR}` interpolation in `--userconfig`, so the value has to be
 * there literally. The token never appears in a command line, in npm's output,
 * in the repository, or in the published tarball.
 *
 * Usage: npm run publish:local [-- <extra npm publish flags>]
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * Read one key from a `.env` file, tolerating quotes, comments, and CRLF.
 * @param name - the key to find.
 * @returns the value, or an empty string when absent or blank.
 */
function fromDotEnv(name) {
  let text = ''
  try {
    text = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  } catch {
    return ''
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 0) continue
    if (line.slice(0, separator).trim() !== name) continue
    return line.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  }
  return ''
}

const token = process.env.NPM_TOKEN || fromDotEnv('NPM_TOKEN')
if (!token) {
  console.error('NPM_TOKEN is not set. Put it in .env as `NPM_TOKEN=<token>`, or export it.')
  console.error('Use an npm Granular Access Token scoped to this package only (Automation type).')
  process.exit(1)
}

// Owner-only, outside the project, gone as soon as the publish returns.
const dir = mkdtempSync(join(tmpdir(), 'dsh-npm-auth-'))
const npmrc = join(dir, '.npmrc')
writeFileSync(npmrc, `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 })

const args = ['publish', '--access', 'public', '--userconfig', npmrc, ...process.argv.slice(2)]
// `process.exit()` inside `try` would skip `finally`, so record the status and
// exit only after the throwaway credential is gone.
let status = 1
try {
  const result = spawnSync('npm', args, { stdio: 'inherit', shell: process.platform === 'win32' })
  status = result.status ?? 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(status)
