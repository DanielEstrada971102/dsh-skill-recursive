/**
 * Recursive skill discovery for DeepSeek Harness: adds nested `SKILL.md`
 * bundles (depth >= `minDepth`) to the skill catalog, leaving depth-1
 * discovery to the built-in provider.
 *
 * @module dsh-skill-recursive
 */

import { watch } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'skill-recursive'
export const inject = ['skills']

/** Ranks sit one step below the shipped filesystem provider, so flat skills win collisions. */
const RANKS = {
  'project-dsh': 110,
  'project-agents': 210,
  custom: 310,
  'user-dsh': 410,
  'user-agents': 510,
}

const SKILL_FILE = 'SKILL.md'
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

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
 * Settings schema. Volatile fields are the only ones DSH exposes in the
 * Settings form and the ones the Loader can refresh in place.
 */
export const Config = z.object({
  minDepth: z.natural().min(1).default(DEFAULTS.minDepth).description('First folder level that may contain a skill.').volatile(),
  maxDepth: z.natural().min(1).default(DEFAULTS.maxDepth).description('Deepest folder level that is scanned.').volatile(),
  watch: z.boolean().default(DEFAULTS.watch).description('Refresh the catalog when skill files change.').volatile(),
  debounceMs: z.natural().default(DEFAULTS.debounceMs).description('Debounce for watcher invalidations.').volatile(),
  pollIntervalMs: z.natural().min(250).default(DEFAULTS.pollIntervalMs).description('Fallback polling interval.').volatile(),
  includeProjectRoots: z.boolean().default(DEFAULTS.includeProjectRoots).description('Scan project .dsh/skills and .agents/skills.').volatile(),
  includeUserRoots: z.boolean().default(DEFAULTS.includeUserRoots).description('Scan user-level skill roots.').volatile(),
  followSymlinks: z.boolean().default(DEFAULTS.followSymlinks).description('Follow symlinked folders.').volatile(),
  extraRoots: z.array(z.string().min(1)).default([...DEFAULTS.extraRoots]).description('Additional skill roots.').volatile(),
  ignoreDirs: z.array(z.string().min(1)).default([...DEFAULTS.ignoreDirs]).description('Folder names never scanned.').volatile(),
})

/**
 * Register the recursive skill provider on the host `skills` registry.
 * @param ctx - plugin context carrying the `skills` service.
 * @param config - optional row config; see {@link normalizeConfig}.
 */
export function apply(ctx, config) {
  let provider
  ctx.skills.registerProvider((control) => {
    provider = new RecursiveSkillProvider(ctx, control, config)
    return provider
  })
  ctx.on('settings/document-updated', () => provider?.syncOptions())
  ctx.effect(function* () {
    yield async () => {
      await provider?.dispose()
    }
  }, 'skill-recursive watcher')
}

/** Provider that adds nested `SKILL.md` bundles to the skill catalog. */
class RecursiveSkillProvider {
  /**
   * @param ctx - plugin context.
   * @param control - registry registration control.
   * @param config - raw row config, including Loader volatile references.
   */
  constructor(ctx, control, config) {
    this.ctx = ctx
    this.name = name
    this.control = control
    this.config = config
    this.options = normalizeConfig(ctx, config)
    this.watchers = new Map()
    this.pendingInvalidation = undefined
    this.disposed = false
    control.signal.addEventListener('abort', () => {
      this.dispose()
    }, { once: true })
  }

  /**
   * Discover nested skill candidates for one workspace.
   * @param options - lookup options; `cwd` selects the project roots.
   * @returns candidates, or an incomplete observation when a scan failed.
   */
  async list(options = {}) {
    this.syncOptions()
    const roots = await this.roots(options.cwd)
    this.observeRoots(roots)
    const candidates = []
    let complete = true
    for (const root of roots) {
      const scan = await scanRoot(root, this.options, this.ctx, this.name)
      if (!scan.complete) complete = false
      for (const candidate of scan.candidates) candidates.push(candidate)
    }
    return complete ? candidates : { candidates, complete }
  }

  /** Pick up Settings changes; the Loader updates volatile refs in place. */
  syncOptions() {
    if (this.disposed) return
    let next
    try {
      next = normalizeConfig(this.ctx, this.config)
    } catch (error) {
      this.ctx.logger.warn(`skill-recursive: ignoring invalid settings: ${errorMessage(error)}`)
      return
    }
    if (sameOptions(next, this.options)) return
    this.options = next
    if (this.pendingInvalidation !== undefined) {
      clearTimeout(this.pendingInvalidation)
      this.pendingInvalidation = undefined
    }
    this.closeWatchers()
    this.control.invalidate()
  }

  /**
   * Load one nested skill body from its candidate.
   * @param candidate - winning candidate returned by {@link list}.
   * @param options - lookup options whose signal cancels reads.
   * @returns the full definition, or undefined when the file vanished.
   */
  async get(candidate, options = {}) {
    const parsed = await readSkill(candidate.path, options.signal)
    if (parsed === undefined) return undefined
    if (parsed.name !== candidate.name) {
      throw new Error(`skill file ${candidate.path} now declares "${parsed.name}" but was discovered as "${candidate.name}"`)
    }
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: parsed.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: dirname(candidate.path) },
      path: parsed.path,
      content: parsed.content,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    }
  }

  /**
   * Resolve the standard skill roots for a workspace.
   * @param cwd - session working directory.
   * @returns de-duplicated roots in precedence order.
   */
  async roots(cwd) {
    const roots = []
    if (this.options.includeProjectRoots && typeof cwd === 'string' && cwd.length > 0) {
      const projectRoot = await findProjectRoot(resolve(cwd), this.ctx)
      roots.push({ path: join(projectRoot, '.dsh', 'skills'), source: 'project-dsh', rank: RANKS['project-dsh'] })
      roots.push({ path: join(projectRoot, '.agents', 'skills'), source: 'project-agents', rank: RANKS['project-agents'] })
    }
    for (const path of this.options.extraRoots) {
      roots.push({ path, source: 'custom', rank: RANKS.custom })
    }
    if (this.options.includeUserRoots) {
      roots.push({ path: join(agentHome('DSH_HOME', '.dsh'), 'skills'), source: 'user-dsh', rank: RANKS['user-dsh'] })
      roots.push({ path: join(agentHome('DSH_AGENTS_HOME', '.agents'), 'skills'), source: 'user-agents', rank: RANKS['user-agents'] })
    }
    const seen = new Set()
    const unique = []
    for (const root of roots) {
      if (seen.has(root.path)) continue
      seen.add(root.path)
      unique.push(root)
    }
    return unique
  }

  /**
   * Start a watcher per known root so a new nested skill invalidates the cache.
   * @param roots - resolved roots from {@link roots}.
   */
  observeRoots(roots) {
    if (!this.options.watch || this.disposed) return
    for (const root of roots) {
      if (this.watchers.has(root.path)) continue
      const watcher = { root, handle: undefined, polling: undefined, lastSignature: undefined, closed: false }
      this.watchers.set(root.path, watcher)
      void this.openWatcher(watcher)
    }
  }

  /**
   * Open a recursive filesystem watcher, falling back to polling where the
   * platform does not support recursive watches.
   * @param watcher - per-root watcher state.
   */
  async openWatcher(watcher) {
    try {
      const info = await stat(watcher.root.path)
      if (!info.isDirectory()) {
        this.watchers.delete(watcher.root.path)
        return
      }
    } catch {
      // Retry on a later listing; the root may be created after first discovery.
      this.watchers.delete(watcher.root.path)
      return
    }
    if (this.disposed || watcher.closed) return
    try {
      const handle = watch(watcher.root.path, { recursive: true, persistent: false }, () => this.scheduleInvalidation())
      handle.on('error', () => {
        handle.close()
        watcher.handle = undefined
        this.startPolling(watcher)
      })
      watcher.handle = handle
    } catch {
      this.startPolling(watcher)
    }
  }

  /**
   * Poll a root's nested skill signature when recursive watching is unavailable.
   * @param watcher - per-root watcher state.
   */
  startPolling(watcher) {
    if (this.disposed || watcher.closed || watcher.polling !== undefined) return
    const tick = async () => {
      const signature = await signatureOf(watcher.root, this.options, this.ctx)
      if (watcher.lastSignature === undefined) {
        watcher.lastSignature = signature
        return
      }
      if (signature !== watcher.lastSignature) {
        watcher.lastSignature = signature
        this.scheduleInvalidation()
      }
    }
    void tick()
    watcher.polling = setInterval(() => void tick(), this.options.pollIntervalMs)
    watcher.polling.unref?.()
  }

  /** Debounce a catalog invalidation burst into one refresh. */
  scheduleInvalidation() {
    if (this.disposed || this.pendingInvalidation !== undefined) return
    this.pendingInvalidation = setTimeout(() => {
      this.pendingInvalidation = undefined
      this.control.invalidate()
    }, this.options.debounceMs)
    this.pendingInvalidation.unref?.()
  }

  /** Stop every watcher and timer owned by this registration. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.pendingInvalidation !== undefined) {
      clearTimeout(this.pendingInvalidation)
      this.pendingInvalidation = undefined
    }
    this.closeWatchers()
  }

  /** Close watcher handles and polling timers; the next listing opens fresh ones. */
  closeWatchers() {
    for (const watcher of this.watchers.values()) {
      watcher.closed = true
      watcher.handle?.close()
      watcher.handle = undefined
      if (watcher.polling !== undefined) {
        clearInterval(watcher.polling)
        watcher.polling = undefined
      }
    }
    this.watchers.clear()
  }
}

/**
 * Depth-limited recursive scan of one skill root for nested `SKILL.md` files.
 * @param root - resolved root descriptor.
 * @param options - normalized plugin options.
 * @param ctx - plugin context for warnings.
 * @returns candidates plus whether the scan was complete.
 */
async function scanRoot(root, options, ctx, providerName) {
  const candidates = []
  let complete = true
  const stack = [{ dir: root.path, depth: 0 }]
  const visited = new Set()
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch (error) {
      if (!isAbsent(error)) {
        complete = false
        ctx.logger.warn(`skill-recursive: cannot read ${current.dir}: ${errorMessage(error)}`)
      }
      continue
    }
    if (current.depth >= options.minDepth && entries.some((entry) => entry.name === SKILL_FILE)) {
      const file = join(current.dir, SKILL_FILE)
      const parsed = await readSkillCandidate(file, root, ctx, providerName)
      if (parsed !== undefined) candidates.push(parsed)
    }
    if (current.depth >= options.maxDepth) continue
    for (const entry of entries) {
      const child = join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (isIgnored(entry.name, options)) continue
        stack.push({ dir: child, depth: current.depth + 1 })
        continue
      }
      if (!entry.isSymbolicLink() || !options.followSymlinks) continue
      try {
        const info = await stat(child)
        if (!info.isDirectory()) continue
        const real = await realpath(child)
        if (visited.has(real)) continue
        visited.add(real)
        stack.push({ dir: child, depth: current.depth + 1 })
      } catch (error) {
        ctx.logger.warn(`skill-recursive: cannot follow ${child}: ${errorMessage(error)}`)
      }
    }
  }
  return { candidates, complete }
}

/**
 * Read and validate one nested skill file into a provider candidate.
 * @param path - absolute `SKILL.md` path.
 * @param root - root descriptor supplying source and rank.
 * @param ctx - plugin context for warnings.
 * @returns candidate, or undefined when the file is not a valid skill.
 */
async function readSkillCandidate(path, root, ctx, providerName) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if (isAbsent(error)) return undefined
    ctx.logger.warn(`skill-recursive: cannot stat ${path}: ${errorMessage(error)}`)
    return undefined
  }
  if (!info.isFile()) return undefined
  let parsed
  try {
    parsed = await readSkill(path)
  } catch (error) {
    ctx.logger.warn(`skill file ${path} ignored: ${errorMessage(error)}`)
    return undefined
  }
  if (parsed === undefined) return undefined
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    invocation: parsed.invocation,
    provider: root.providerName ?? providerName,
    source: root.source,
    rank: root.rank,
    locator: { path, directory: dirname(path) },
    resourceBase: { kind: 'directory', path: dirname(path) },
    path,
    ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
  }
}

/**
 * Read and parse one skill file.
 * @param path - absolute `SKILL.md` path.
 * @param signal - optional abort signal.
 * @returns parsed summary, or undefined when the file is missing or invalid.
 */
async function readSkill(path, signal) {
  signal?.throwIfAborted()
  let resolvedPath
  let raw
  try {
    resolvedPath = await realpath(path)
    raw = await readFile(resolvedPath, { encoding: 'utf8', signal })
  } catch (error) {
    signal?.throwIfAborted()
    if (isAbsent(error)) return undefined
    throw error
  }
  signal?.throwIfAborted()
  const frontmatter = parseFrontmatter(raw)
  if (frontmatter === undefined) return undefined
  const data = frontmatter.data
  const skillName = stringField(data, 'name')
  const description = stringField(data, 'description')
  if (skillName === undefined || description === undefined) return undefined
  if (!SKILL_NAME.test(skillName)) {
    throw new Error(`invalid skill name "${skillName}"`)
  }
  return {
    name: skillName,
    description,
    ...(stringField(data, 'whenToUse') !== undefined ? { whenToUse: stringField(data, 'whenToUse') } : {}),
    invocation: parseInvocationPolicy(data),
    ...(typeof data.metadata === 'object' && data.metadata !== null && !Array.isArray(data.metadata) ? { metadata: data.metadata } : {}),
    path: resolvedPath,
    content: frontmatter.body.trim(),
  }
}

/**
 * Extract the YAML frontmatter block and Markdown body.
 * @param raw - whole file text.
 * @returns parsed data and body, or undefined when no frontmatter exists.
 */
function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  const data = parseFrontmatterData(raw.slice(start, closing.start))
  return { data, body: raw.slice(closing.bodyStart) }
}

/**
 * Locate the closing `---` line.
 * @param raw - whole file text.
 * @param start - offset just after the opening delimiter.
 * @returns closing offsets, or undefined when unterminated.
 */
function findClosingFrontmatter(raw, start) {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

/**
 * Parse the small YAML subset skill frontmatter uses: plain and quoted scalars,
 * block scalars, and booleans. Nested mappings and sequences are ignored.
 * @param block - frontmatter text without delimiters.
 * @returns parsed top-level fields.
 */
function parseFrontmatterData(block) {
  const data = Object.create(null)
  const lines = block.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue
    const rest = line.slice(colon + 1).trim()
    if (/^[|>][+-]?$/.test(rest)) {
      const style = rest[0]
      const collected = []
      let cursor = index + 1
      for (; cursor < lines.length; cursor += 1) {
        const next = lines[cursor]
        if (next.trim() === '') {
          collected.push('')
          continue
        }
        if (!/^\s/.test(next)) break
        collected.push(next)
      }
      index = cursor - 1
      const dedented = dedent(collected)
      data[key] = style === '|' ? dedented.trim() : fold(dedented).trim()
      continue
    }
    if (rest === '') continue
    data[key] = parseScalar(rest)
  }
  return data
}

/**
 * Remove the common indentation from block-scalar lines.
 * @param lines - raw block lines.
 * @returns de-indented text lines joined with newlines.
 */
function dedent(lines) {
  const indents = lines.filter((line) => line.length > 0).map((line) => line.match(/^\s*/)[0].length)
  const minimum = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(Math.min(minimum, line.length))).join('\n')
}

/**
 * Fold block-scalar lines into prose.
 * @param text - de-indented block text.
 * @returns folded text.
 */
function fold(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
}

/**
 * Parse one inline scalar value.
 * @param raw - raw scalar text.
 * @returns string, boolean, or null.
 */
function parseScalar(raw) {
  const value = raw.trim()
  if (value === '' || value === '~' || value === 'null') return null
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  const lower = value.toLowerCase()
  if (lower === 'true' || lower === 'yes' || lower === 'on') return true
  if (lower === 'false' || lower === 'no' || lower === 'off') return false
  return value
}

/**
 * Resolve model/user invocation controls from frontmatter.
 * @param data - parsed frontmatter fields.
 * @returns invocation policy.
 */
function parseInvocationPolicy(data) {
  for (const [legacy, canonical] of [
    ['disableModelInvocation', 'disable-model-invocation'],
    ['modelInvocable', 'disable-model-invocation'],
    ['userInvocable', 'user-invocable'],
  ]) {
    if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
  const disableModelInvocation = booleanField(data, 'disable-model-invocation')
  const userInvocable = booleanField(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/**
 * Read an optional boolean field with YAML-compatible coercions.
 * @param data - parsed frontmatter fields.
 * @param key - field name.
 * @returns boolean when present and understood.
 */
function booleanField(data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

/**
 * Read a non-empty string field.
 * @param data - parsed frontmatter fields.
 * @param key - field name.
 * @returns the string, or undefined when absent or empty.
 */
function stringField(data, key) {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Walk up from `cwd` to the nearest directory containing `.git`.
 * @param cwd - absolute session directory.
 * @param ctx - plugin context for warnings.
 * @returns project root, or `cwd` when no repository marker exists.
 */
async function findProjectRoot(cwd, ctx) {
  let current = cwd
  while (true) {
    try {
      await stat(join(current, '.git'))
      return current
    } catch (error) {
      if (!isAbsent(error)) ctx.logger.warn(`skill-recursive: cannot inspect ${join(current, '.git')}: ${errorMessage(error)}`)
    }
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

/**
 * Resolve a home-based directory from an environment override.
 * @param variable - environment variable name.
 * @param fallback - directory name under the home directory.
 * @returns absolute directory path.
 */
function agentHome(variable, fallback) {
  const override = process.env[variable]
  if (typeof override === 'string' && override.length > 0) return resolve(override)
  return join(homedir(), fallback)
}

/**
 * Build a change signature for polling fallback.
 * @param root - root descriptor.
 * @param options - normalized plugin options.
 * @param ctx - plugin context for warnings.
 * @returns stable signature string.
 */
async function signatureOf(root, options, ctx) {
  const scan = await scanRootSignature(root, options, ctx)
  return scan
}

/**
 * List nested skill paths with size and mtime for change detection.
 * @param root - root descriptor.
 * @param options - normalized plugin options.
 * @param ctx - plugin context for warnings.
 * @returns stable signature string.
 */
async function scanRootSignature(root, options, ctx) {
  const parts = []
  const stack = [{ dir: root.path, depth: 0 }]
  const visited = new Set()
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    if (current.depth >= options.minDepth && entries.some((entry) => entry.name === SKILL_FILE)) {
      const file = join(current.dir, SKILL_FILE)
      try {
        const info = await stat(file)
        parts.push(`${file}:${info.size}:${info.mtimeMs}`)
      } catch {
        // The file vanished between listing and stat; the next scan settles it.
      }
    }
    if (current.depth >= options.maxDepth) continue
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isIgnored(entry.name, options)) continue
        stack.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 })
        continue
      }
      if (!entry.isSymbolicLink() || !options.followSymlinks) continue
      try {
        const info = await stat(join(current.dir, entry.name))
        if (!info.isDirectory()) continue
        const real = await realpath(join(current.dir, entry.name))
        if (visited.has(real)) continue
        visited.add(real)
        stack.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 })
      } catch (error) {
        ctx.logger.warn(`skill-recursive: cannot follow ${join(current.dir, entry.name)}: ${errorMessage(error)}`)
      }
    }
  }
  return parts.sort().join('\n')
}

/**
 * Whether a directory name is excluded from recursion.
 * @param name - directory base name.
 * @param options - normalized plugin options.
 * @returns whether to skip it.
 */
function isIgnored(name, options) {
  return options.ignoreDirs.includes(name)
}

/**
 * Validate and normalize row config.
 * @param ctx - plugin context for warnings about unknown keys.
 * @param raw - raw row config.
 * @returns normalized options.
 */
function normalizeConfig(ctx, raw) {
  const root = unwrap(raw) ?? {}
  if (typeof root !== 'object' || Array.isArray(root)) throw new TypeError('skill-recursive: config must be an object')
  const known = new Set(Object.keys(DEFAULTS))
  for (const key of Object.keys(root)) {
    if (!known.has(key)) ctx.logger.warn(`skill-recursive: unknown config key "${key}" ignored`)
  }
  const value = (key) => unwrap(root[key])
  const options = { ...DEFAULTS }
  options.minDepth = positiveInteger('minDepth', value('minDepth') ?? DEFAULTS.minDepth, 1)
  options.maxDepth = positiveInteger('maxDepth', value('maxDepth') ?? DEFAULTS.maxDepth, options.minDepth)
  options.debounceMs = nonNegativeInteger('debounceMs', value('debounceMs') ?? DEFAULTS.debounceMs)
  options.pollIntervalMs = positiveInteger('pollIntervalMs', value('pollIntervalMs') ?? DEFAULTS.pollIntervalMs, 250)
  options.watch = booleanOption('watch', value('watch') ?? DEFAULTS.watch)
  options.includeProjectRoots = booleanOption('includeProjectRoots', value('includeProjectRoots') ?? DEFAULTS.includeProjectRoots)
  options.includeUserRoots = booleanOption('includeUserRoots', value('includeUserRoots') ?? DEFAULTS.includeUserRoots)
  options.followSymlinks = booleanOption('followSymlinks', value('followSymlinks') ?? DEFAULTS.followSymlinks)
  options.extraRoots = stringArray('extraRoots', value('extraRoots') ?? DEFAULTS.extraRoots).map((path) => resolve(path))
  options.ignoreDirs = stringArray('ignoreDirs', value('ignoreDirs') ?? DEFAULTS.ignoreDirs)
  return options
}

/** Read a Loader volatile reference, or return a plain value. */
function unwrap(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/** Whether two normalized option sets describe the same behavior. */
function sameOptions(a, b) {
  return a.minDepth === b.minDepth
    && a.maxDepth === b.maxDepth
    && a.watch === b.watch
    && a.debounceMs === b.debounceMs
    && a.pollIntervalMs === b.pollIntervalMs
    && a.includeProjectRoots === b.includeProjectRoots
    && a.includeUserRoots === b.includeUserRoots
    && a.followSymlinks === b.followSymlinks
    && sameList(a.extraRoots, b.extraRoots)
    && sameList(a.ignoreDirs, b.ignoreDirs)
}

/** Whether two string arrays are equal. */
function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Validate a positive integer option.
 * @param field - option name.
 * @param value - raw value.
 * @param minimum - inclusive minimum.
 * @returns validated value.
 */
function positiveInteger(field, value, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`skill-recursive: ${field} must be an integer >= ${minimum}`)
  }
  return value
}

/**
 * Validate a non-negative integer option.
 * @param field - option name.
 * @param value - raw value.
 * @returns validated value.
 */
function nonNegativeInteger(field, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`skill-recursive: ${field} must be a non-negative integer`)
  }
  return value
}

/**
 * Validate a boolean option.
 * @param field - option name.
 * @param value - raw value.
 * @returns validated value.
 */
function booleanOption(field, value) {
  if (typeof value !== 'boolean') throw new TypeError(`skill-recursive: ${field} must be a boolean`)
  return value
}

/**
 * Validate a string-array option.
 * @param field - option name.
 * @param value - raw value.
 * @returns validated array.
 */
function stringArray(field, value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new TypeError(`skill-recursive: ${field} must be an array of non-empty strings`)
  }
  return [...value]
}

/**
 * Whether an fs error means the path is simply absent.
 * @param error - thrown value.
 * @returns whether it is ENOENT or ENOTDIR.
 */
function isAbsent(error) {
  return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/**
 * Render an error for logs.
 * @param error - thrown value.
 * @returns message text.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
