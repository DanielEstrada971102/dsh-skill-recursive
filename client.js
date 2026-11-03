window.__ModuleLoader__.load({
  id: 'dsh-skill-recursive',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // The settings namespace is the profile entry id (the row id in cordis.patch.yml).
    const ENTRY_ID = 'skill-recursive'

    // shortcut: the form lists fields explicitly; add a row when Config gains a field.
    const NUMBERS = [
      ['minDepth', 'Minimum depth', 1],
      ['maxDepth', 'Maximum depth', 1],
      ['debounceMs', 'Debounce (ms)', 0],
      ['pollIntervalMs', 'Fallback poll interval (ms)', 250],
    ]
    const BOOLEANS = [
      ['watch', 'Watch for changes'],
      ['includeProjectRoots', 'Scan project roots'],
      ['includeUserRoots', 'Scan user roots'],
      ['followSymlinks', 'Follow symlinked folders'],
    ]
    const LISTS = [
      ['extraRoots', 'Extra skill roots (absolute paths, one per line)'],
      ['ignoreDirs', 'Ignored folder names (one per line)'],
    ]

    const STYLE = `
.dsr-form { display: grid; gap: 12px; padding: 4px 0; color: var(--dsw-alias-label-primary); font-size: 13px; }
.dsr-row { display: grid; gap: 6px; }
.dsr-check { grid-auto-flow: column; justify-content: start; align-items: center; gap: 8px; }
.dsr-label { color: var(--dsw-alias-label-secondary); }
.dsr-input { width: 100%; box-sizing: border-box; padding: 6px 8px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; font: inherit; }
.dsr-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsr-input:disabled { opacity: 0.6; }
.dsr-textarea { resize: vertical; }
.dsr-actions { display: flex; align-items: center; gap: 10px; }
.dsr-save { padding: 6px 14px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 6px; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; cursor: pointer; }
.dsr-save:disabled { opacity: 0.6; cursor: default; }
.dsr-status { color: var(--dsw-alias-label-secondary); }
.dsr-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; }
`

    function lines(text) {
      return String(text).split('\n').map((line) => line.trim()).filter(Boolean)
    }

    function toDraft(value) {
      const draft = {}
      for (const [key] of NUMBERS) draft[key] = value?.[key] === undefined ? '' : String(value[key])
      for (const [key] of BOOLEANS) draft[key] = value?.[key] === true
      for (const [key] of LISTS) draft[key] = Array.isArray(value?.[key]) ? value[key].join('\n') : ''
      return draft
    }

    function parse(draft) {
      const next = {}
      for (const [key, label, min] of NUMBERS) {
        const number = Number(draft[key])
        if (!Number.isInteger(number) || number < min) throw new Error(`${label} must be an integer >= ${min}.`)
        next[key] = number
      }
      if (next.maxDepth < next.minDepth) throw new Error('Maximum depth must be at least the minimum depth.')
      for (const [key] of BOOLEANS) next[key] = draft[key] === true
      for (const [key] of LISTS) next[key] = lines(draft[key])
      return next
    }

    function changes(next, current) {
      const ops = []
      for (const [key] of NUMBERS) if (next[key] !== current[key]) ops.push({ op: 'set', path: [key], value: next[key] })
      for (const [key] of BOOLEANS) if (next[key] !== current[key]) ops.push({ op: 'set', path: [key], value: next[key] })
      for (const [key] of LISTS) {
        if (JSON.stringify(next[key]) !== JSON.stringify(current[key] ?? [])) {
          ops.push({ op: 'set', path: [key], value: next[key] })
        }
      }
      return ops
    }

    function apply(ctx) {
      const form = ctx.configForms.get(ENTRY_ID)

      function ConfigPage() {
        const state = form.getSnapshot()
        const [draft, setDraft] = React.useState(() => toDraft(state.value))
        const [status, setStatus] = React.useState('')

        React.useEffect(() => {
          setDraft(toDraft(state.value))
        }, [state.value])

        if (state.status === 'loading') return h('p', { className: 'dsr-note' }, 'Loading configuration…')
        if (state.status === 'unavailable') return h('p', { className: 'dsr-note' }, 'Configuration is unavailable in this DSH version.')

        const readOnly = state.writable !== true
        const update = (key, value) => {
          setStatus('')
          setDraft((current) => ({ ...current, [key]: value }))
        }
        const save = async () => {
          setStatus('Saving…')
          try {
            const ops = changes(parse(draft), state.value ?? {})
            if (ops.length === 0) {
              setStatus('Saved')
              return
            }
            const accepted = await form.mutate(ops, state.revision)
            setStatus(accepted ? 'Saved' : 'The Host rejected the change.')
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error))
          }
        }

        return h('div', { className: 'dsr-form' }, [
          h('style', { key: 'style' }, STYLE),
          ...NUMBERS.map(([key, label, min]) => h('label', { className: 'dsr-row', key }, [
            h('span', { className: 'dsr-label', key: 'label' }, label),
            h('input', {
              className: 'dsr-input', key: 'input', type: 'number', min, step: 1,
              value: draft[key], disabled: readOnly,
              onChange: (event) => update(key, event.target.value),
            }),
          ])),
          ...BOOLEANS.map(([key, label]) => h('label', { className: 'dsr-row dsr-check', key }, [
            h('input', {
              key: 'input', type: 'checkbox', checked: draft[key] === true, disabled: readOnly,
              onChange: (event) => update(key, event.target.checked),
            }),
            h('span', { className: 'dsr-label', key: 'label' }, label),
          ])),
          ...LISTS.map(([key, label]) => h('label', { className: 'dsr-row', key }, [
            h('span', { className: 'dsr-label', key: 'label' }, label),
            h('textarea', {
              className: 'dsr-input dsr-textarea', key: 'input', rows: 3,
              value: draft[key], disabled: readOnly,
              onChange: (event) => update(key, event.target.value),
            }),
          ])),
          h('div', { className: 'dsr-actions', key: 'actions' }, [
            h('button', {
              className: 'dsr-save', key: 'save', type: 'button',
              disabled: readOnly || status === 'Saving…', onClick: save,
            }, 'Save'),
            status === '' ? null : h('span', { className: 'dsr-status', key: 'status', role: 'status' }, status),
          ]),
        ])
      }

      return ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-skill-recursive',
      }, ConfigPage))
    }

    return {
      inject: ['slots', 'configForms'],
      apply,
    }
  },
})
