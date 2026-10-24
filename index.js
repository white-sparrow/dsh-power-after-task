/**
 * Host half of `dsh-power-after-task`.
 *
 * One operation, two callers (see the plugin-development practice notes):
 * `arm`, `cancel`, `status`, and `execute` are implemented once here and reach
 * the page through a plugin-owned HTTP route, while the `power_after_task`
 * tool exposes the same four operations to the agent.
 *
 * A request is armed for one session. The countdown starts when that session's
 * Agent stops running; if the Agent starts running again the countdown returns
 * to waiting, so a goal driver or a follow-up message never powers the machine
 * out from under the work.
 *
 * Requires the Web composition (`ctx.webServer`) and runs on Windows only.
 *
 * @module dsh-power-after-task
 */
import { spawn } from 'node:child_process'

/** Power targets this build can drive. */
const POWER_ACTIONS = ['sleep', 'shutdown', 'restart']
/** Used when the row's `config` supplies no usable grace period. */
const FALLBACK_GRACE_SECONDS = 45
/** Upper bound on a countdown, so a bad argument cannot schedule a year of waiting. */
const MAX_GRACE_SECONDS = 3600
/** Body ceiling for the plugin route. */
const MAX_BODY_BYTES = 8 * 1024
/** One prefix route owns every endpoint below. */
const ROUTE = '/power-task'

/**
 * PowerShell that suspends the machine through `kernel32!ApplicationSuspend`.
 * `rundll32 powrprof.dll,SetSuspendState` hibernates whenever hibernation is
 * enabled, so it only serves as the fallback below.
 */
const SLEEP_SCRIPT = [
  "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class DshPower { [DllImport(\"kernel32.dll\", SetLastError = true)] public static extern bool ApplicationSuspend(); }' -Name DshPower -Namespace Dsh",
  'if ([Dsh.DshPower]::ApplicationSuspend()) { exit 0 } else { exit 1 }',
].join('\n')

/**
 * Run one program to completion.
 * @param command - executable to spawn.
 * @param args - its argument vector.
 * @returns a promise that resolves on exit code 0.
 */
function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    child.once('error', (error) => reject(new Error(`${command}: ${error.message}`)))
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited (${code ?? signal ?? 'unknown'})`))
    })
  })
}

/**
 * Ask Windows to carry out one power action.
 * @param action - `sleep`, `shutdown`, or `restart`.
 * @returns a promise that rejects with the reason the machine stayed up.
 */
async function runPowerAction(action) {
  if (process.platform !== 'win32') {
    throw new Error(`power-after-task drives Windows; this Host runs on ${process.platform}`)
  }
  if (!POWER_ACTIONS.includes(action)) throw new Error(`unknown power action '${action}'`)
  if (action === 'shutdown') return runCommand('shutdown.exe', ['/s', '/t', '0', '/c', 'DSH power-after-task'])
  if (action === 'restart') return runCommand('shutdown.exe', ['/r', '/t', '0', '/c', 'DSH power-after-task'])

  const failures = []
  try {
    return await runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      SLEEP_SCRIPT,
    ])
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  try {
    return await runCommand('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,0,0'])
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  throw new Error(`sleep failed: ${failures.join(' ; ')}`)
}

/**
 * Read a request body as JSON.
 * @param req - the incoming request.
 * @returns the parsed object, or `{}` for an empty body.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed
}

/** Services this Host half needs from the composition. */
export const inject = ['webServer', 'timer', 'tools', 'sessionController']

export function apply(ctx, config) {
  const defaultAction = POWER_ACTIONS.includes(config?.defaultAction) ? config.defaultAction : 'shutdown'
  const configuredGrace = Number(config?.graceSeconds)
  const defaultGrace = Number.isFinite(configuredGrace) && configuredGrace >= 0
    ? Math.min(configuredGrace, MAX_GRACE_SECONDS)
    : FALLBACK_GRACE_SECONDS
  /** This server's own origin, read lazily so activation order cannot break it. */
  const serverOrigin = () => {
    try {
      return new URL(ctx.webServer.getOrigin())
    } catch {
      return undefined
    }
  }

  /** Sessions whose Agent is currently running. */
  const running = new Set()
  /** One entry per armed session: `{ action, graceSeconds, endsAt, cancelTimer }`. */
  const pending = new Map()

  const log = (message) => ctx.logger?.info?.(`power-after-task: ${message}`)

  /** Diagnostic from the last running-state read, surfaced by `/power-task/debug`. */
  let seedFailure = ''
  /** Headers the last mutating request carried, so a rejected Arm is diagnosable. */
  let lastPost = null
  let postAttempts = 0
  /** Headers the last read request carried: the page polls here every couple of seconds. */
  let lastGet = null
  let getAttempts = 0

  /**
   * Ask the Session domain which Agents are running, so an arm made before this
   * plugin saw a session's first status event is still correct.
   * @param sessionId - one session to refresh, omitted to refresh every row.
   */
  async function refreshRunning(sessionId) {
    try {
      const value = await ctx.sessionController.list({}, new AbortController().signal)
      for (const item of value?.items ?? []) {
        if (sessionId && item.sessionId !== sessionId) continue
        if (item.running) running.add(item.sessionId)
        else running.delete(item.sessionId)
      }
      seedFailure = ''
    } catch (error) {
      seedFailure = error instanceof Error ? error.message : String(error)
      // The status-event feed remains authoritative when the read is unavailable.
    }
  }

  /**
   * Stop a running countdown without forgetting the arm.
   * @param entry - the pending entry to pause.
   */
  function pauseCountdown(entry) {
    entry.cancelTimer?.()
    entry.cancelTimer = undefined
    entry.endsAt = undefined
  }

  /**
   * Carry out the armed action. The arm stays visible until the command runs
   * successfully or the user cancels it: a command that fails leaves the entry
   * in the `failed` state instead of silently returning to normal.
   * @param sessionId - the session whose arm fired.
   */
  function fire(sessionId) {
    const entry = pending.get(sessionId)
    if (!entry) return
    pauseCountdown(entry)
    log(`${entry.action} scheduled for session ${sessionId}`)
    runPowerAction(entry.action).then(
      () => {
        pending.delete(sessionId)
        log(`${entry.action} executed`)
      },
      (error) => {
        entry.failed = error instanceof Error ? error.message : String(error)
        log(`${entry.action} failed: ${entry.failed}`)
      },
    )
  }

  /**
   * Begin (or restart) the grace countdown for one armed entry.
   * @param sessionId - the session to count down for.
   * @param entry - its pending entry.
   */
  function startCountdown(sessionId, entry) {
    pauseCountdown(entry)
    entry.endsAt = Date.now() + entry.graceSeconds * 1000
    entry.cancelTimer = ctx.timer.timeout(() => fire(sessionId), entry.graceSeconds * 1000)
  }

  /**
   * Arm one session for a power action.
   * @param sessionId - the session to watch.
   * @param action - `sleep`, `shutdown`, or `restart`.
   * @param graceSeconds - countdown length after the task finishes.
   * @returns the state the caller can display.
   */
  async function arm(sessionId, action = defaultAction, graceSeconds = defaultGrace) {
    if (!POWER_ACTIONS.includes(action)) throw new Error(`unknown power action '${action}'`)
    const grace = Math.min(Math.max(Number(graceSeconds) || 0, 0), MAX_GRACE_SECONDS)
    const entry = { action, graceSeconds: grace, endsAt: undefined, cancelTimer: undefined }
    pending.set(sessionId, entry)
    // A session this plugin never saw start can still be mid-turn, so check the
    // Session domain before concluding that its task is already finished.
    if (!running.has(sessionId)) await refreshRunning(sessionId)
    // An idle session is already "finished", so the countdown begins at once;
    // a message sent inside the grace window puts it back to waiting.
    if (!running.has(sessionId)) startCountdown(sessionId, entry)
    return stateOf(sessionId)
  }

  /**
   * Forget one arm, cancelling any countdown already running.
   * @param sessionId - the session to clear.
   */
  function cancel(sessionId) {
    const entry = pending.get(sessionId)
    if (entry) pauseCountdown(entry)
    pending.delete(sessionId)
    return stateOf(sessionId)
  }

  /**
   * Current state of one session's arm.
   * @param sessionId - the session to report.
   * @returns `{ state, running, ... }`.
   */
  function stateOf(sessionId) {
    const entry = pending.get(sessionId)
    if (!entry) return { state: 'off', running: running.has(sessionId) }
    return {
      state: entry.failed ? 'failed' : entry.endsAt ? 'counting' : 'armed',
      action: entry.action,
      graceSeconds: entry.graceSeconds,
      endsAt: entry.endsAt ?? null,
      detail: entry.failed,
      running: running.has(sessionId),
    }
  }

  /**
   * Whether a host value names this machine. A rebinding attack reaches the
   * port under a foreign name, so the Host header is what separates the page
   * from an outside web page.
   * @param value - a `Host` or URL hostname, with or without a port.
   * @returns whether it is a loopback name.
   */
  function isLoopbackHost(value) {
    const host = String(value ?? '').toLowerCase()
    if (!host) return false
    const closing = host.lastIndexOf(']')
    const bare = closing > 0 ? host.slice(1, closing) : host.split(':')[0]
    return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1'
  }

  /**
   * Refuse a read request that proves it came from elsewhere.
   * @param req - the incoming request.
   * @returns whether the request may be served.
   */
  function isSameOrigin(req) {
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string') return site === 'same-origin' || site === 'none'
    const origin = req.headers['origin']
    if (typeof origin !== 'string') return true
    try {
      return isLoopbackHost(new URL(origin).hostname)
    } catch {
      return false
    }
  }

  /**
   * Whether a mutating request is trusted. A request is refused only when it
   * proves it is not the page: addressed to a non-loopback host (DNS
   * rebinding or a foreign vhost), reported by the browser as cross-site, or
   * sent with a non-loopback `Origin`. A request carrying none of that
   * evidence passes: it is the Harness page through its own transport, or a
   * local process — which could run `shutdown.exe` directly anyway.
   * @param req - the incoming request.
   * @returns whether Arm or Cancel may run.
   */
  function fromPage(req) {
    const host = req.headers.host
    if (typeof host === 'string' && !isLoopbackHost(host)) return false
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
    const origin = req.headers['origin']
    if (typeof origin === 'string') {
      try {
        if (!isLoopbackHost(new URL(origin).hostname)) return false
      } catch {
        return false
      }
    }
    return true
  }

  /**
   * Answer one plugin-route request.
   * @param req - the incoming request.
   * @param res - the response to own.
   */
  async function handle(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (!isSameOrigin(req)) return reply(403, { error: 'this endpoint is only reachable from the Harness page' })

    const path = (req.url ?? '').split('?')[0]
    const sub = path.slice(ROUTE.length).replace(/^\//, '')
    try {
      if (sub === 'debug') return reply(200, {
        marker: 'guard-v6',
        platform: process.platform,
        running: [...running],
        pending: [...pending.keys()],
        seedFailure,
        guard: 'refuse non-loopback host, cross-site, or non-loopback origin',
        serverOrigin: serverOrigin() ?? null,
        postAttempts,
        lastPost,
        getAttempts,
        lastGet,
      })
      if (sub === 'defaults') return reply(200, { actions: POWER_ACTIONS, defaultAction, graceSeconds: defaultGrace })
      if (req.method === 'GET' && (sub === 'defaults' || sub === 'state')) {
        getAttempts += 1
        lastGet = {
          at: new Date().toISOString(),
          path,
          host: req.headers.host ?? null,
          secFetchSite: req.headers['sec-fetch-site'] ?? null,
          origin: req.headers['origin'] ?? null,
          cookie: Boolean(req.headers.cookie),
        }
      }
      if (req.method === 'GET' && sub === 'state') {
        const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('session')
        return reply(200, query ? stateOf(query) : {
          arms: [...pending.keys()].map((id) => ({ sessionId: id, ...stateOf(id) })),
        })
      }
      if (req.method !== 'POST') return reply(405, { error: `unsupported method ${req.method ?? 'unknown'}` })
      postAttempts += 1
      const accepted = fromPage(req)
      lastPost = {
        at: new Date().toISOString(),
        path,
        host: req.headers.host ?? null,
        secFetchSite: req.headers['sec-fetch-site'] ?? null,
        origin: req.headers['origin'] ?? null,
        contentType: req.headers['content-type'] ?? null,
        accepted,
      }
      // Arming and cancelling are mutating: they refuse a request that proves it
      // is not this page.
      if (!accepted) {
        return reply(403, { error: 'this control only accepts requests from the Harness page', hint: 'see /power-task/debug' })
      }

      const body = await readJsonBody(req)
      if (sub === 'arm') {
        const sessionId = String(body.sessionId ?? '')
        if (!sessionId) return reply(400, { error: 'sessionId is required' })
        return reply(200, await arm(sessionId, body.action ?? defaultAction, body.graceSeconds ?? defaultGrace))
      }
      if (sub === 'cancel') {
        const sessionId = String(body.sessionId ?? '')
        if (!sessionId) return reply(400, { error: 'sessionId is required' })
        return reply(200, cancel(sessionId))
      }
      return reply(404, { error: `unknown power-task endpoint '${sub}'` })
    } catch (error) {
      return reply(400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  return ctx.effect(() => {
    const disposer = ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: handle })
    // A session already running when this plugin activates never emits a status
    // event this plugin observes, so seed the running set once.
    void refreshRunning()

    ctx.on('api-session/status', (sessionId, isRunning) => {
      const entry = pending.get(sessionId)
      if (isRunning) {
        running.add(sessionId)
        if (entry?.endsAt) pauseCountdown(entry)
      } else {
        running.delete(sessionId)
        if (entry && !entry.endsAt && !entry.failed) startCountdown(sessionId, entry)
      }
    })

    // A session leaving the live registry has no further work to protect.
    ctx.on('api-session/removed', (sessionId) => {
      running.delete(sessionId)
      const entry = pending.get(sessionId)
      if (entry && !entry.endsAt && !entry.failed) startCountdown(sessionId, entry)
    })

    ctx.tools.register({
      name: 'power_after_task',
      description:
        'Arm, cancel, or inspect a Windows power action that runs when a session’s task finishes, '
        + 'or run one immediately. Arming starts a cancellable countdown after the Agent stops running.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'arm', 'cancel', 'execute'], description: 'Which operation to run.' },
          session: { type: 'string', description: 'Session id to arm or cancel; defaults to the calling session.' },
          power: { type: 'string', enum: POWER_ACTIONS, description: `Power target; defaults to '${defaultAction}'.` },
          grace_seconds: { type: 'number', description: `Countdown seconds after the task finishes; defaults to ${defaultGrace}.` },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { state: { type: 'string' }, detail: { type: 'string' } } },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value ?? {}, null, 2) }],
      },
      execute: async (args, exec) => {
        const sessionId = args.session ?? exec?.agent?.id
        try {
          if (args.action === 'status') return sessionId ? stateOf(sessionId) : { state: 'off', running: false }
          if (args.action === 'arm') {
            if (!sessionId) throw new Error('no session to arm')
            return await arm(sessionId, args.power ?? defaultAction, args.grace_seconds ?? defaultGrace)
          }
          if (args.action === 'cancel') {
            if (!sessionId) throw new Error('no session to cancel')
            return cancel(sessionId)
          }
          if (args.action === 'execute') {
            await runPowerAction(args.power ?? defaultAction)
            return { state: 'executed', detail: String(args.power ?? defaultAction) }
          }
          throw new Error(`unknown action '${args.action}'`)
        } catch (error) {
          return { state: 'error', detail: error instanceof Error ? error.message : String(error) }
        }
      },
    })

    return () => {
      disposer()
      for (const entry of pending.values()) pauseCountdown(entry)
      pending.clear()
      running.clear()
    }
  }, 'power-after-task: route, events, and tool')
}
