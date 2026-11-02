# Changelog

## 0.1.0 - 2026-11-02

- Initial public release.
- Register a `ctx.skills` provider that discovers `SKILL.md` bundles nested at depth 2 or deeper under the standard project and user skill roots.
- Skip depth-1 bundles so the shipped `skill-filesystem` provider keeps ownership and duplicate warnings stay out of the log.
- Rank nested candidates one step below the matching flat root, so a same-name flat skill always wins.
- Watch roots recursively and invalidate the catalog on change, with a polling fallback where recursive watching is unavailable.
- Zero runtime dependencies; Node built-ins only.
