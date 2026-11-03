import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/**
 * Poll a predicate until it becomes true or the timeout expires.
 * @param {() => boolean} predicate condition to observe.
 * @param {number} timeoutMs maximum wait.
 * @param {string} label failure description.
 */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`timed out waiting for ${label}`)
}

test('a nested skill edit invalidates the catalog, and dispose stops watching', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-recursive-watch-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await mkdir(join(root, 'container', 'demo'), { recursive: true })
  const file = join(root, 'container', 'demo', 'SKILL.md')
  await writeFile(file, '---\nname: demo\ndescription: Demo skill for the watcher.\n---\n\nBody.\n')

  let invalidations = 0
  const providers = []
  const ctx = {
    logger: { info() {}, warn() {} },
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
    on() {
      return () => {}
    },
  }

  apply(ctx, {
    extraRoots: [root],
    includeProjectRoots: false,
    includeUserRoots: false,
    watch: true,
    debounceMs: 50,
    pollIntervalMs: 250,
  })
  const provider = providers[0]

  const first = await provider.list({ cwd: root })
  assert.deepEqual(first.map((candidate) => candidate.name), ['demo'])

  await appendFile(file, '\n<!-- edit -->\n')
  await waitFor(() => invalidations > 0, 6000, 'a watcher invalidation')

  await provider.dispose()
  const settled = invalidations
  await appendFile(file, '\n<!-- after dispose -->\n')
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(invalidations, settled, 'dispose stops further invalidations')
})
