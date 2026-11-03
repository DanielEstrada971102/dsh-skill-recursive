# Changelog

## 0.2.0 - 2026-11-03

- Add a Web settings page under Settings → Plugins for every option.
- Export a schemastery `Config` schema; volatile fields apply live when saved.
- Verify the bundle in both the `desktop` and `web` profiles.
- Trim the README and code comments; add a settings regression test.

## 0.1.1 - 2026-11-02

- Fix the `test` script for Node 22: list the test files explicitly instead of passing the `tests` directory, which Node 22 resolves as a module path. No runtime behavior change.

## 0.1.0 - 2026-11-02

- Initial public release.
- Register a `ctx.skills` provider that discovers `SKILL.md` bundles nested at depth 2 or deeper under the standard project and user skill roots.
- Skip depth-1 bundles so the shipped `skill-filesystem` provider keeps ownership and duplicate warnings stay out of the log.
- Rank nested candidates one step below the matching flat root, so a same-name flat skill always wins.
- Watch roots recursively and invalidate the catalog on change, with a polling fallback where recursive watching is unavailable.
- Zero runtime dependencies; Node built-ins only.
