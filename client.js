/**
 * Client half of `dsh-power-after-task`.
 *
 * Two seats:
 * - `conversation.composer.dock` — the control itself: one power icon that
 *   expands inline into an Action drop-down, a Grace drop-down, and Arm. While
 *   armed it prints nothing: a smaller lit icon plus Cancel is the whole message.
 * - `shell.overlay` — the frame-wide ribbon that counts down once the task has
 *   finished: minutes, seconds, milliseconds, and one tiny line naming the
 *   action it is counting down to.
 *
 * State lives entirely in the Host half. Both seats read and write it through
 * this package's own routes — requested document-relative, as the shipped HMR
 * client requests its event stream. A failed fetch means the Host half is not
 * running (the row is disabled), so both seats disappear instead of showing
 * stale state.
 *
 * Every colour comes from a `--dsw-alias-*` theme token, so light and dark
 * settings carry the plugin; semi-transparent surfaces mix a token with
 * `transparent` rather than inventing a colour.
 *
 * @module dsh-power-after-task/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-power-after-task',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Document-relative app routes (the shell may serve the page under a path). */
    const STATE_ROUTE = 'power-task/state'
    const ARMS_ROUTE = 'power-task/state'
    const DEFAULTS_ROUTE = 'power-task/defaults'
    const ARM_ROUTE = 'power-task/arm'
    const CANCEL_ROUTE = 'power-task/cancel'
    /** Grace choices: seconds, plus the label shown in the drop-down. */
    const GRACE_CHOICES = [
      [15, '15s'],
      [30, '30s'],
      [60, '1m'],
      [120, '2m'],
      [300, '5m'],
    ]

    /**
     * Call this package's Host routes, through the shell transport when there is one.
     * @param path - document-relative route.
     * @param body - request body, omitted for a GET.
     * @returns the parsed JSON answer.
     */
    function request(path, body) {
      const transport = globalThis.__DSH_TRANSPORT__
      const fetchImpl = transport?.fetch ?? globalThis.fetch
      return Promise.resolve(fetchImpl(path, body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
        .then((res) => {
          if (!res.ok) throw new Error(`${path} answered ${res.status}`)
          return res.json()
        })
    }

    /**
     * Format a countdown as `m:ss.mmm`.
     * @param ms - milliseconds remaining.
     * @returns the clock text.
     */
    function clock(ms) {
      const total = Math.max(0, ms)
      const minutes = Math.floor(total / 60000)
      const seconds = Math.floor((total % 60000) / 1000)
      const millis = Math.floor(total % 1000)
      return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
    }

    /** The power glyph, drawn in the current text colour. */
    function PowerIcon(size) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
        style: { display: 'block' },
      },
        h('path', { d: 'M12 3v8' }),
        h('path', { d: 'M18.4 6.6a9 9 0 1 1-12.77.04' }))
    }

    /** Shared compact chrome for the two seats, built only from theme tokens. */
    const chrome = {
      appearance: 'none',
      font: 'inherit',
      fontSize: 11,
      lineHeight: 1.4,
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 6,
      padding: '2px 6px',
    }

    /**
     * The composer-dock control.
     * @param props - slot props (`sessionId`) plus the registration's `inject`.
     * @returns the entry element.
     */
    function PowerAfterTask(props) {
      const { sessionId, t, request: call } = props
      const [open, setOpen] = React.useState(false)
      const [available, setAvailable] = React.useState(true)
      const [actions, setActions] = React.useState(['sleep', 'shutdown', 'restart'])
      const [action, setAction] = React.useState('shutdown')
      const [grace, setGrace] = React.useState(45)
      const [state, setState] = React.useState({ state: 'off', running: false })
      const [remaining, setRemaining] = React.useState(0)
      const [failure, setFailure] = React.useState('')
      const primed = React.useRef(false)

      // Defaults on the first success; the loop doubles as the availability probe,
      // so disabling the row removes this entry within a couple of seconds.
      React.useEffect(() => {
        let alive = true
        const probe = () => call(DEFAULTS_ROUTE).then((info) => {
          if (!alive) return
          if (!info?.actions) { setAvailable(false); primed.current = false; return }
          setAvailable(true)
          if (primed.current) return
          primed.current = true
          setActions(Array.isArray(info.actions) ? info.actions : ['sleep', 'shutdown', 'restart'])
          if (info.defaultAction) setAction(info.defaultAction)
          if (Number.isFinite(info.graceSeconds)) setGrace(info.graceSeconds)
        }, () => {
          if (!alive) return
          setAvailable(false)
          primed.current = false
        })
        probe()
        const timer = setInterval(probe, 2000)
        return () => { alive = false; clearInterval(timer) }
      }, [call])

      React.useEffect(() => {
        let alive = true
        call(`${STATE_ROUTE}?session=${encodeURIComponent(sessionId)}`).then((info) => {
          if (alive && info) setState(info)
        }, () => {})
        return () => { alive = false }
      }, [call, sessionId])

      // One tick per second while an arm exists: it refreshes Host state and the clock.
      React.useEffect(() => {
        if (state.state === 'off') {
          setRemaining(0)
          return undefined
        }
        const tick = () => {
          setRemaining(state.endsAt ? state.endsAt - Date.now() : 0)
          call(`${STATE_ROUTE}?session=${encodeURIComponent(sessionId)}`).then((info) => {
            if (info) setState(info)
          }, () => {})
        }
        tick()
        const timer = setInterval(tick, 1000)
        return () => clearInterval(timer)
      }, [call, sessionId, state.state, state.endsAt, state.action])

      /**
       * Send one operation and adopt the state it reports.
       * @param path - route to post to.
       * @param body - request body.
       */
      const send = (path, body) => {
        setFailure('')
        call(path, body).then((info) => {
          if (info) setState(info)
        }, (error) => setFailure(error instanceof Error ? error.message : String(error)))
      }

      const label = (id) => t(`action.${id}`)
      const armed = state.state !== 'off'
      const counting = state.state === 'counting'
      const failed = state.state === 'failed'
      const accent = failed || counting
        ? 'var(--dsw-alias-state-warn-primary)'
        : 'var(--dsw-alias-brand-primary)'
      const choices = GRACE_CHOICES.some(([seconds]) => seconds === grace)
        ? GRACE_CHOICES
        : [[grace, `${grace}s`], ...GRACE_CHOICES]
      // Nothing is printed while armed: a smaller lit icon plus Cancel carries the
      // whole message. Action and remaining time stay reachable as a hover title.
      const hover = armed
        ? `${label(state.action)} · ${failed ? (state.detail ?? t('failed')) : counting ? clock(remaining) : t('waiting')}`
        : t('tooltip')
      const shown = failure || (failed ? `${label(state.action)} · ${state.detail ?? t('failed')}` : '')

      if (!sessionId || !available) return null

      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
      },
        h('button', {
          type: 'button',
          'aria-expanded': open,
          'aria-label': armed ? `${t('title')} · ${label(state.action)}` : t('title'),
          title: hover,
          style: {
            ...chrome,
            display: 'flex',
            alignItems: 'center',
            padding: armed ? '2px 5px' : '3px 6px',
            cursor: 'pointer',
            color: armed ? accent : 'var(--dsw-alias-label-secondary)',
            borderColor: armed ? accent : 'var(--dsw-alias-border-l1)',
          },
          onClick: () => { setFailure(''); setOpen((value) => !value) },
        }, PowerIcon(armed ? 11 : 14)),
        armed ? h('button', {
          type: 'button',
          title: hover,
          style: { ...chrome, color: accent, cursor: 'pointer' },
          onClick: () => send(CANCEL_ROUTE, { sessionId }),
        }, t('cancel')) : null,
        open ? h('select', {
          title: t('actionLabel'),
          disabled: armed,
          value: armed ? state.action : action,
          onChange: (event) => setAction(event.target.value),
          style: { ...chrome, cursor: armed ? 'default' : 'pointer' },
        }, actions.map((id) => h('option', { key: id, value: id }, label(id)))) : null,
        open ? h('select', {
          title: t('graceLabel'),
          disabled: armed,
          value: String(armed ? state.graceSeconds : grace),
          onChange: (event) => setGrace(Number(event.target.value)),
          style: { ...chrome, cursor: armed ? 'default' : 'pointer' },
        }, choices.map(([seconds, text]) => h('option', { key: seconds, value: String(seconds) }, `${t('graceLabel')} ${text}`))) : null,
        open && !armed ? h('button', {
          type: 'button',
          style: { ...chrome, color: accent, borderColor: 'var(--dsw-alias-border-l2)', cursor: 'pointer' },
          onClick: () => send(ARM_ROUTE, { sessionId, action, graceSeconds: grace }),
        }, t('arm')) : null,
        shown ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, shown) : null)
    }

    /**
     * The frame-wide countdown ribbon, shown only while a countdown is running
     * (or while a power action reported a failure). It never blocks the page:
     * only its Cancel button takes pointer events.
     * @param props - the registration's `inject`.
     * @returns the overlay element, or `null`.
     */
    function CountdownRibbon(props) {
      const { t, request: call } = props
      const [arms, setArms] = React.useState([])
      const [live, setLive] = React.useState(true)
      const [now, setNow] = React.useState(() => Date.now())
      const counting = arms.find((arm) => arm.state === 'counting') ?? null
      const failedArm = arms.find((arm) => arm.state === 'failed') ?? null
      const ribbon = counting ?? failedArm

      React.useEffect(() => {
        let alive = true
        const probe = () => call(ARMS_ROUTE).then((info) => {
          if (!alive) return
          setLive(true)
          setArms(Array.isArray(info?.arms) ? info.arms : [])
        }, () => {
          if (!alive) return
          setLive(false)
          setArms([])
        })
        probe()
        const timer = setInterval(probe, 1000)
        return () => { alive = false; clearInterval(timer) }
      }, [call])

      // Animation frames give the millisecond digits a smooth update.
      React.useEffect(() => {
        if (!counting) return undefined
        let frame = requestAnimationFrame(function loop() {
          setNow(Date.now())
          frame = requestAnimationFrame(loop)
        })
        return () => cancelAnimationFrame(frame)
      }, [counting?.state, counting?.endsAt])

      /**
       * Cancel the countdown this ribbon is showing.
       */
      const cancel = () => {
        if (!ribbon?.sessionId) return
        call(CANCEL_ROUTE, { sessionId: ribbon.sessionId }).then(() => setNow(Date.now()), () => {})
      }

      if (!live || !ribbon) return null

      const remaining = ribbon.endsAt ? Math.max(0, ribbon.endsAt - now) : 0
      const accent = failedArm
        ? 'var(--dsw-alias-state-error-primary)'
        : 'var(--dsw-alias-state-warn-primary)'
      const caption = failedArm
        ? `${t(`action.${failedArm.action}`)} · ${failedArm.detail ?? t('failed')}`
        : t(`until.${counting.action}`)

      return h('div', {
        'aria-live': 'polite',
        style: {
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          zIndex: 40,
          font: 'inherit',
        },
      },
        h('div', {
          style: {
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            padding: '30px 16px',
            background: 'color-mix(in srgb, var(--dsw-alias-bg-overlay) 68%, transparent)',
            borderTop: '1px solid var(--dsw-alias-border-l2)',
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
            backdropFilter: 'blur(8px)',
            boxShadow: '0 0 40px color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)',
          },
        },
          h('div', {
            style: {
              fontSize: 'clamp(54px, 13vw, 150px)',
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: '-0.02em',
              color: accent,
              fontVariantNumeric: 'tabular-nums',
            },
          }, clock(remaining)),
          h('div', {
            style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', letterSpacing: '0.01em' },
          }, caption),
          h('button', {
            type: 'button',
            style: { ...chrome, pointerEvents: 'auto', color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer', marginTop: 4 },
            onClick: cancel,
          }, t('cancel')))
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dicts = {
          en: {
            title: 'Power after task',
            tooltip: 'Sleep, shut down, or restart this PC once the current task finishes.',
            'action.sleep': 'Sleep',
            'action.shutdown': 'Shut down',
            'action.restart': 'Restart',
            'until.sleep': 'Until sleep',
            'until.shutdown': 'Until shut down',
            'until.restart': 'Until restart',
            arm: 'Arm',
            cancel: 'Cancel',
            waiting: 'waiting for the task to finish',
            failed: 'the power action failed',
            actionLabel: 'Action',
            graceLabel: 'Grace',
          },
          fa: {
            title: 'خاموش‌شدن پس از تسک',
            tooltip: 'پس از پایان تسک جاری، این رایانه را به حالت خواب ببرد، خاموش کند یا راه‌اندازی مجدد کند.',
            'action.sleep': 'خواب',
            'action.shutdown': 'خاموش',
            'action.restart': 'راه‌اندازی مجدد',
            'until.sleep': 'تا خواب',
            'until.shutdown': 'تا خاموشی',
            'until.restart': 'تا راه‌اندازی مجدد',
            arm: 'آماده‌سازی',
            cancel: 'لغو',
            waiting: 'در انتظار پایان تسک',
            failed: 'کنش برقی انجام نشد',
            actionLabel: 'کنش',
            graceLabel: 'مهلت',
          },
        }
        return ctx.effect(() => {
          const disposers = [
            ctx.locale.register('power-after-task', 'en', dicts.en),
            ctx.locale.register('power-after-task', 'fa', dicts.fa),
          ]
          const translate = ctx.locale.bind('power-after-task')
          /**
           * Translate one key, falling back to the English dictionary when the
           * registry has no entry for it, so the control never prints a raw key.
           * @param key - dictionary key.
           * @returns the text to show.
           */
          const t = (key) => {
            const value = translate(key)
            return typeof value === 'string' && value !== key ? value : (dicts.en[key] ?? key)
          }
          const injected = () => ({ t, request })
          disposers.push(ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'power-after-task',
            order: 2,
            label: () => t('title'),
            inject: injected,
          }, PowerAfterTask)))
          disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'power-after-task-countdown',
            order: 20,
            label: () => t('title'),
            inject: injected,
          }, CountdownRibbon)))
          return () => { for (const dispose of disposers) dispose() }
        }, 'power-after-task: locale, dock control, and countdown ribbon')
      },
    }
  },
})
