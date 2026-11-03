import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { Config, apply } from '../index.js'

const DEFAULTS = {
  minDepth: 2,
  maxDepth: 8,
  watch: true,
  debounceMs: 200,
  pollIntervalMs: 2000,
  includeProjectRoots: true,
  includeUserRoots: true,
  followSymlinks: false,
  extraRoots: [],
  ignoreDirs: ['.system', 'node_modules', '.git'],
}

/**
 * Build a plugin harness that captures the provider and settings listener.
 * @param {object} config row config passed to apply.
 * @returns {{ provider: object, warnings: string[], handlers: Map<string, Function>, invalidations: () => number }}
 */
function harness(config) {
  const providers = []
  const warnings = []
  const handlers = new Map()
  let invalidations = 0
  const ctx = {
    logger: {
      info() {},
      warn(...args) {
        warnings.push(args.join(' '))
      },
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    skills: {
      registerProvider(create) {
        const controller = new AbortController()
        providers.push(create({ signal: controller.signal, invalidate() { invalidations += 1 } }))
        return () => controller.abort(new Error('test dispose'))
      },
    },
    effect(generatorFactory) {
      const iterator = generatorFactory()
      let step = iterator.next()
      while (!step.done) step = iterator.next()
    },
  }
  apply(ctx, config)
  return { provider: providers[0], warnings, handlers, invalidations: () => invalidations }
}

/**
 * Wrap a mutable settings object in Loader-style volatile references.
 * @param {object} state current settings.
 * @returns {object} config object whose fields expose get().
 */
function refs(state) {
  const config = {}
  for (const key of Object.keys(DEFAULTS)) config[key] = { get: () => state[key] }
  return config
}

/**
 * Write one skill file under a temporary root.
 * @param {string} root temporary skill root.
 * @param {string} relative path below the root.
 * @param {string} frontmatter frontmatter body without delimiters.
 */
async function writeSkill(root, relative, frontmatter) {
  const file = join(root, relative)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `---\n${frontmatter}\n---\n\nBody text.\n`)
}

test('Config defaults match the runtime defaults and every field is editable', () => {
  assert.deepEqual(Object.keys(Config.dict).sort(), Object.keys(DEFAULTS).sort())
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(Config.dict[key].meta.volatile, true, `${key} must be volatile`)
    assert.deepEqual(Config.dict[key].meta.default, value, `${key} default`)
  }
})

test('a settings change refreshes options and discovers the new root', async (t) => {
  const rootA = await mkdtemp(join(tmpdir(), 'dsh-skill-recursive-settings-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'dsh-skill-recursive-settings-b-'))
  t.after(async () => {
    await rm(rootA, { recursive: true, force: true })
    await rm(rootB, { recursive: true, force: true })
  })
  await writeSkill(rootB, join('container', 'demo', 'SKILL.md'), 'name: demo\ndescription: settings demo')

  const state = {
    ...DEFAULTS,
    watch: false,
    includeProjectRoots: false,
    includeUserRoots: false,
    extraRoots: [rootA],
    maxDepth: 3,
  }
  const { provider, handlers, invalidations } = harness(refs(state))

  assert.deepEqual(await provider.list({ cwd: rootA }), [])
  state.extraRoots = [rootB]
  handlers.get('settings/document-updated')('skill-recursive', 1)

  assert.equal(invalidations(), 1)
  const found = await provider.list({ cwd: rootA })
  assert.deepEqual(found.map((candidate) => candidate.name), ['demo'])
})

test('an invalid live settings update is ignored', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-recursive-settings-invalid-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  await writeSkill(root, join('container', 'demo', 'SKILL.md'), 'name: demo\ndescription: demo')

  const state = {
    ...DEFAULTS,
    watch: false,
    includeProjectRoots: false,
    includeUserRoots: false,
    extraRoots: [root],
    maxDepth: 3,
  }
  const { provider, warnings, handlers } = harness(refs(state))

  assert.deepEqual((await provider.list({ cwd: root })).map((candidate) => candidate.name), ['demo'])
  state.maxDepth = 1
  handlers.get('settings/document-updated')('skill-recursive', 2)

  assert.ok(warnings.some((warning) => warning.includes('maxDepth')))
  const found = await provider.list({ cwd: root })
  assert.deepEqual(found.map((candidate) => candidate.name), ['demo'])
})
