import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/**
 * Build a plugin harness that captures the registered provider.
 * @param {object} config row config passed to apply.
 * @returns {{ provider: object, warnings: string[] }}
 */
function harness(config) {
  const providers = []
  const warnings = []
  const ctx = {
    logger: {
      info() {},
      warn(...args) {
        warnings.push(args.join(' '))
      },
    },
    skills: {
      registerProvider(create) {
        const controller = new AbortController()
        providers.push(create({ signal: controller.signal, invalidate() {} }))
        return () => controller.abort(new Error('test dispose'))
      },
    },
    effect(generatorFactory) {
      const iterator = generatorFactory()
      let step = iterator.next()
      while (!step.done) step = iterator.next()
    },
    on() {
      return () => {}
    },
  }
  apply(ctx, config)
  return { provider: providers[0], warnings }
}

/**
 * Write one skill file under a temporary root.
 * @param {string} root temporary skill root.
 * @param {string} relative path below the root.
 * @param {string} frontmatter frontmatter body without delimiters.
 * @param {string} [body] Markdown body.
 */
async function writeSkill(root, relative, frontmatter, body = 'Body text.\n') {
  const file = join(root, relative)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `---\n${frontmatter}\n---\n\n${body}`)
}

test('discovers nested skills and skips depth-one, ignored, and invalid bundles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-recursive-discovery-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await writeSkill(root, join('flat', 'SKILL.md'), 'name: flat\ndescription: depth one is built-in territory')
  await writeSkill(
    root,
    join('container', 'alpha', 'SKILL.md'),
    'name: alpha\ndescription: Nested alpha.\nwhenToUse: Use for alpha work.\nuser-invocable: false',
    '# Alpha\n\nAlpha body.\n',
  )
  await writeSkill(
    root,
    join('container', 'deep', 'beta', 'SKILL.md'),
    'name: beta\ndescription: "Nested beta: quoted colon."',
    '# Beta\n\nBeta body.\n',
  )
  await writeSkill(
    root,
    join('container', 'deeper', 'more', 'hidden', 'SKILL.md'),
    'name: hidden\ndescription: beyond maxDepth',
  )
  await writeSkill(root, join('node_modules', 'pkg', 'gamma', 'SKILL.md'), 'name: gamma\ndescription: ignored directory')
  await writeSkill(root, join('container', 'broken', 'SKILL.md'), 'name: broken')
  await writeSkill(
    root,
    join('container', 'legacy', 'SKILL.md'),
    'name: legacy\ndescription: legacy fields\nmodelInvocable: true',
  )
  await writeSkill(root, join('container', 'bad-name', 'SKILL.md'), 'name: Not A Skill\ndescription: invalid name')

  const { provider, warnings } = harness({
    extraRoots: [root],
    includeProjectRoots: false,
    includeUserRoots: false,
    watch: false,
    minDepth: 2,
    maxDepth: 3,
  })

  const observation = await provider.list({ cwd: root })
  assert.ok(Array.isArray(observation), 'a complete scan returns a candidate array')
  assert.deepEqual(
    observation.map((candidate) => candidate.name).sort(),
    ['alpha', 'beta'],
  )
  assert.ok(
    warnings.some((warning) => warning.includes('modelInvocable')),
    'legacy invocation keys are reported',
  )
  assert.ok(
    warnings.some((warning) => warning.includes('invalid skill name')),
    'invalid names are reported',
  )

  const alpha = observation.find((candidate) => candidate.name === 'alpha')
  const definition = await provider.get(alpha, {})
  assert.equal(definition.name, 'alpha')
  assert.equal(definition.description, 'Nested alpha.')
  assert.equal(definition.whenToUse, 'Use for alpha work.')
  assert.deepEqual(definition.invocation, { modelInvocable: true, userInvocable: false })
  assert.equal(definition.resourceBase.path, join(root, 'container', 'alpha'))
  assert.equal(definition.provider, 'skill-recursive')
  assert.equal(definition.source, 'custom')
  assert.match(definition.content, /Alpha body\./)
})

test('rejects invalid config at activation', () => {
  assert.throws(() => harness({ minDepth: 2, maxDepth: 1 }), /maxDepth/)
  assert.throws(() => harness({ watch: 'yes' }), /watch/)
  assert.throws(() => harness({ pollIntervalMs: 10 }), /pollIntervalMs/)
})

test('returns an incomplete observation when a root is unreadable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-recursive-missing-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const { provider } = harness({
    extraRoots: [join(root, 'does-not-exist')],
    includeProjectRoots: false,
    includeUserRoots: false,
    watch: false,
  })
  const observation = await provider.list({ cwd: root })
  assert.ok(Array.isArray(observation), 'a missing root is an empty, complete observation')
  assert.deepEqual(observation, [])
})
