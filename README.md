# dsh-skill-recursive

Recursive `SKILL.md` discovery for DeepSeek Harness. The built-in provider reads one directory level per skill root; this plugin adds skills stored in nested folders.

```
.dsh/skills/
├── flat-skill/SKILL.md            ← built-in provider
└── obsidian-skills/               ← container folder
    ├── defuddle/SKILL.md          ← this plugin
    └── json-canvas/SKILL.md       ← this plugin
```

## Install

The plugin is a normal DSH bundle and works in both the Desktop app (`desktop` profile) and a browser-hosted harness (`web` profile). A profile only loads what is installed in it.

### Desktop app

Use the in-app plugin manager, or ask a Harness session to install it:

```
plugin_manager action=install_bundle target=github:DanielEstrada971102/dsh-skill-recursive#v0.2.0
```

### Web profile

```sh
dsh plugin --profile web add github:DanielEstrada971102/dsh-skill-recursive#v0.2.0
```

### Local clone

```sh
git clone https://github.com/DanielEstrada971102/dsh-skill-recursive.git
dsh plugin --profile <profile> add link:<absolute path to the clone>
```

Restart the host after installing or updating a bundle.

## Configure

Open **Settings → Plugins → Recursive Skill Discovery**. The bundle's page renders the configuration form; changes are saved by DSH and applied without restarting.

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
| `extraRoots` | `[]` | Additional roots; use absolute paths. |
| `ignoreDirs` | `[".system","node_modules",".git"]` | Directory names never descended into. |

The profile patch still works for deployment defaults:

```yaml
- insert:
    - id: skill-recursive
      name: dsh-skill-recursive
      config:
        maxDepth: 6
        extraRoots:
          - C:/shared/skills
```

## What it does

- **Roots** — project `.dsh/skills` and `.agents/skills` (nearest `.git` ancestor of the session cwd), `$DSH_HOME/skills` (default `~/.dsh/skills`), `$DSH_AGENTS_HOME/skills` (default `~/.agents/skills`), plus any `extraRoots`.
- **Recursive scan** — walks each root to `maxDepth`, skipping `ignoreDirs`.
- **Depth guard** — contributes only nested bundles at depth 2 or deeper, so the built-in provider keeps ownership of flat skills.
- **Precedence** — nested candidates rank one step below the matching flat root, so a same-name flat skill wins.
- **Frontmatter** — reads `name`, `description`, optional `whenToUse`, `disable-model-invocation`, and `user-invocable`; invalid files are logged and skipped.
- **Hot refresh** — watches roots and invalidates the skill catalog; falls back to polling where recursive watching is unavailable.

## Compatibility

- Tested with DeepSeek Harness `0.2.1-rc.5` and Node.js 20+.
- The settings form is rendered by the same Web client in both the Desktop and Web profiles.
- Uses DSH's `@deepseek-ai/schemastery` for the settings schema; no other runtime dependency.

## Notes

- **Depth-1 ownership** — this plugin supplements `skill-filesystem`; if that provider is disabled, flat skills are not discovered by this plugin alone.
- **Direct filesystem reads** — skill files are read with `node:fs` from the host process, matching the built-in provider.
- **Frontmatter subset** — plain/quoted scalars, block scalars (`|`, `>`), and booleans are supported; arbitrary nested YAML is not forwarded.
- **Watchers** — one watcher is kept per distinct root path for the process lifetime.

## License

[MIT](LICENSE)
