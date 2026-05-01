## Summary

<!-- One paragraph: what changes and why. Link any related issues. -->

## Changes

<!-- Bullet list of the substantive changes. File paths welcome. -->

## Test plan

<!-- How did you verify this works? Tick what applies. -->

- [ ] `npm run typecheck` clean
- [ ] `npm run test:ci` passing (429/430 baseline; note any new skips)
- [ ] `npm run test:mcp-schema-snapshot` &mdash; if you touched `src/tools/`, the snapshot diff is intentional and committed
- [ ] Manual smoke on at least one OS (specify which: macOS / Windows / Linux)
- [ ] If touching MCP or REST surface: verified the tool call you changed works end-to-end through that surface

## Risk / scope

<!-- Anything reviewers should pay extra attention to: cross-OS behavior, schema changes, anything that touches the SafetyLayer chokepoint. -->
