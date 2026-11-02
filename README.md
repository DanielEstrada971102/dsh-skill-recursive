# dsh-skill-recursive

A DeepSeek Harness plugin that finds `SKILL.md` files in **nested** subfolders of the standard skill roots — not only the first directory level.

```
.dsh/skills/
├── flat-skill/SKILL.md            ← already found by the built-in provider
└── obsidian-skills/               ← container folder
    ├── defuddle/SKILL.md          ← found by this plugin
    └── json-canvas/SKILL.md       ← found by this plugin
```

Without it, the second group never reaches the skill catalog, because the shipped `@deepseek-ai/dsh-skill-filesystem` provider reads exactly one directory level per root (`readdir` of the root, then `<root>/<name>/SKILL.md`) and watches with chokidar `depth: 1`.

## Install

The package is a standard DSH bundle (`dsh.bundle.patch`), so it installs into a profile like any other plugin. Requires Node.js 20 or newer.

### Through the agent (recommended)

Ask a Harness session to install it:

```
plugin_manager action=install_bundle target=github:DanielEstrada971102/dsh-skill-recursive
```

The plugin manager links the package into the active profile, applies the patch row, and hot-applies the change. No restart is normally needed.

### Through the CLI

```sh
dsh plugin --profile <profile> add github:DanielEstrada971102/dsh-skill-recursive
```

On DSH Desktop use the in-app plugin manager instead: the Desktop profile is managed by the app, and a CLI install against a different profile will not show up there.

### From a local clone

```sh
git clone https://github.com/DanielEstrada971102/dsh-skill-recursive.git
# then, in the Harness: plugin_manager action=install_bundle target=<absolute path to the clone>
```

## What it does

- **Roots** — project `.dsh/skills` and `.agents/skills` (nearest `.git` ancestor of the session cwd), `$DSH_HOME/skills` (default `~/.dsh/skills`), `$DSH_AGENTS_HOME/skills` (default `~/.agents/skills`), plus any `extraRoots`.
- **Recursive scan** — walks each root to `maxDepth`, skipping `ignoreDirs` (`.system`, `node_modules`, `.git` by default).
- **Depth guard** — managed by `minDepth: 2`: the plugin contributes only nested bundles, so the built-in provider keeps ownership of depth-1 skills and no duplicate-name warnings are produced.
- **Precedence** — nested candidates rank one step below the matching flat root (project 110/210, custom 310, user 410/510), so a same-name flat skill always wins.
- **Frontmatter** — reads the same fields as the built-in provider: `name`, `description`, optional `whenToUse`, `disable-model-invocation`, `user-invocable`. Invalid files are logged and skipped.
- **Hot refresh** — a recursive `fs.watch` per root invalidates the skill catalog; where recursive watching is unavailable it falls back to polling `mtime`/size.
- **Zero dependencies** — Node built-ins only. Profile-installed bundles may not resolve the Harness installation's `node_modules`, so the YAML frontmatter subset parser and discovery walk are self-contained.

## Configuration

Every field is optional and validated at activation; an invalid value throws instead of being silently ignored.

| Field | Default | Meaning |
|---|---|---|
| `minDepth` | `2` | First directory depth (relative to a root) that may hold a skill. |
| `maxDepth` | `8` | Deepest directory depth scanned. |
| `watch` | `true` | Watch roots and invalidate the catalog on change. |
| `debounceMs` | `200` | Debounce for watcher invalidations. |
| `pollIntervalMs` | `2000` | Fallback polling interval. |
| `includeProjectRoots` | `true` | Scan project `.dsh/skills` and `.agents/skills`. |
| `includeUserRoots` | `true` | Scan user-level skill roots. |
| `followSymlinks` | `false` | Follow symlinked directories (loop-guarded). |
| `extraRoots` | `[]` | Additional roots; relative paths resolve against the process cwd. |
| `ignoreDirs` | `[".system","node_modules",".git"]` | Directory names never descended into. |

Example row config:

```yaml
- insert:
    - id: skill-recursive
      name: dsh-skill-recursive
      config:
        maxDepth: 6
        extraRoots:
          - C:/shared/skills
```

## Verify it works

After installation, the skill catalog should list the nested names (for example `obsidian-bases`), and asking the agent to use one loads it normally. In a session:

```
Use the obsidian-bases skill.
```

To re-run the plugin's own checks locally (no dependencies, no install step):

```sh
npm test
```

The suite covers depth filtering, ignored directories, invalid frontmatter, config validation, `get()` loading, watcher invalidation, and dispose behavior. CI runs it on Windows and Ubuntu with Node 20 and 22.

## Compatibility

- Tested with DeepSeek Harness `0.2.1-rc.5`, Node.js 20+.
- Depends only on the host `skills` service and Node built-ins; no `@deepseek-ai/*` package is imported.
- Declares `dsh.bundle.patch` and `dsh.compatibility` in `package.json` for the plugin manager and DSH Market.

## Known limitations

- **Depth-1 ownership** — this plugin deliberately does not register depth-1 skills; it supplements `skill-filesystem` rather than replacing it. If that built-in row is disabled, flat skills will not be discovered by this plugin alone.
- **Direct filesystem reads** — skill files are read with `node:fs` from the host process, matching the built-in provider's trusted-host path; filesystem policy hooks do not mediate these reads.
- **Frontmatter subset** — inline scalars, quoted strings, block scalars (`|`, `>`), and booleans are supported; arbitrary nested YAML structures are not forwarded as metadata.
- **Ranks** — nested candidates use fixed ranks (110/210/310/410/510) one step below the shipped roots; a future change to those shipped ranks would need this table updated.
- **Root creation** — a root that does not exist when first observed is retried on the next listing; it becomes watched once it appears.
- **Watcher lifetime** — one watcher is kept per distinct root path for the process lifetime, so many distinct project roots accumulate watchers until restart.

## Discoverability (DSH Market)

The DSH Market catalog is curated by the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry. To list this plugin there, open a pull request with one entry pointing at this repository. GitHub-only entries are supported; there is no npm publication for this package.

## License

[MIT](LICENSE)
