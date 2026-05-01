# Contributing to Clawd Cursor

Thanks for considering a contribution. Clawd Cursor is a small project with a single maintainer; the goal of this guide is to keep PRs and issues tractable, not to gate-keep.

## Before you start

- **Bugs:** open an issue first if it's not obviously trivial. The bug template is a one-pager — fill it in honestly so we can repro.
- **Features:** open a feature-request issue before writing code. Some ideas (a new compact action, a new platform) need an architectural sketch first to avoid wasted effort.
- **Security issues:** do not open a public issue or PR. Use [GitHub private vulnerability reporting](https://github.com/AmrDab/clawdcursor/security/advisories/new) — see [SECURITY.md](SECURITY.md) for scope and what to include.

## Local development

```sh
git clone https://github.com/AmrDab/clawdcursor.git
cd clawdcursor
npm install
npm run setup              # builds, links the global `clawdcursor` binary, builds native helpers on macOS
```

Useful scripts:

| Command | What it does |
|---|---|
| `npm run dev` | `tsx watch src/index.ts` — rebuild on save |
| `npm run typecheck` | `tsc --noEmit` — must be clean |
| `npm run lint` | ESLint over `src/` |
| `npm run test` | `vitest` watch mode |
| `npm run test:ci` | `vitest run` — 429/430 baseline, one intentional skip |
| `npm run test:mcp-schema-snapshot` | Diffs the granular tool catalog against `schema.snapshot.json`. Fails if the schema changed. Commit the new snapshot (`:update`) when the change is intentional. |

CI runs typecheck + lint + tests + schema snapshot on every PR across Windows, macOS, and Linux on Node 20 and 22. Match that locally before pushing where possible.

## Code style

- TypeScript strict mode is on. No `any` unless you have a real reason and a comment explaining it.
- Business logic does not see `process.platform`. Cross-OS branches live in `src/v2/platform/{macos,windows,linux}.ts` behind the `PlatformAdapter` interface. If you find yourself writing `if (IS_MAC)` outside `src/v2/platform/`, move it.
- Every tool call goes through the SafetyLayer (`src/pipeline/safety/layer.ts`). Do not add a tool that bypasses it. Destructive verbs (send, delete, close_window, blocked keyboard combos) must escalate to confirm.
- New compact tool actions: define them in `src/tools/compact.ts`, then run `npm run test:mcp-schema-snapshot:update` and commit the snapshot diff. The `argRemap` field is how you alias agent-friendly arg names onto granular tools — see the `key`/`combo` example.
- Tests live next to the code they test under `tests/`. Vitest. Prefer integration tests that hit the real adapter over mocks.

## Commit messages

Conventional-commits-ish. Lowercase type, colon, short imperative. Examples:

```
fix(safety): close-window confirm prompt now renders on Wayland
feat(compact): add browser({"action":"page_context"})
docs(readme): correct compact-action enum names
release(0.8.7): two-line summary
```

The "what's new" line in CHANGELOG and SKILL.md gets edited too — small features can usually share a CHANGELOG entry with related work.

## Pull requests

- Use the PR template. The "Test plan" section matters — reviewers should not have to guess what you ran.
- Include CHANGELOG.md and SKILL.md updates in the same PR as the code change. They are part of the surface area.
- Schema snapshot diffs (`schema.snapshot.json`) must be intentional. If your PR shows a snapshot diff you did not expect, something else changed.
- Cross-OS PRs: if you can't test on all three, say so. CI catches most cross-OS regressions but not all (Wayland and TCC permissions need real machines).

## What gets merged

Things I'll merge quickly: bug fixes with a clear repro, doc fixes, small PRs that make existing behavior more correct. Things that take longer to land: new tools (need schema review), changes to the SafetyLayer (need threat-model review), anything that adds a top-level dependency.

If you've put work into a PR and it's been sitting more than a week, ping the issue or Discord — I have probably just lost track.
