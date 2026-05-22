# Frontend/UX, Performance, and Developer-Experience Audit (2026-05-22)

Scope reviewed:
- CLI UX states, startup/consent flows, error handling, and setup docs/scripts.
- Performance-sensitive paths and perf instrumentation.
- Developer experience around installation, diagnostics, and command behavior.

## Top Findings

### 1) **High** — Global `uncaughtException` recovery policy can hide faults and produce partial-failure behavior
- **Where:** `src/surface/cli.ts`
- **Why it matters:** The process-level `uncaughtException` handler suppresses one specific EINVAL/setTypeOfService error and exits for everything else. While this protects one known Node/macOS socket issue, process-wide exception interception can mask crash provenance and leave state partially mutated before exit, especially during startup/teardown windows.
- **Evidence:** Handler is registered at file top-level before command parsing and normal lifecycle boundaries.
- **Risk profile:** Reliability + debuggability under edge failures; hard to reason about safe continuation after global exceptions.

### 2) **High** — `forceKillPort` uses `kill -9 $(lsof ...)` shell expansion and can misbehave with empty expansion / portability variance
- **Where:** `src/surface/cli.ts`
- **Why it matters:** The non-Windows path executes `kill -9 $(lsof -ti tcp:${port})` via shell. If expansion is empty or `lsof` behavior varies, command outcomes can be inconsistent and difficult to diagnose. This is a critical UX path because users hit it during daemon startup conflicts.
- **Risk profile:** Operational UX (recovery from port conflicts), potential accidental command failure noise.

### 3) **Medium** — Non-interactive onboarding bypass can create inconsistent first-run security UX
- **Where:** `src/surface/onboarding.ts`
- **Why it matters:** On non-TTY stdin/stdout, onboarding returns `true` immediately and consent is effectively skipped for that invocation path. This is practical for CI/pipes but creates two different trust UX modes: strict interactive consent vs implicit pass-through.
- **Risk profile:** Security UX consistency and user expectation mismatch in scripted environments.

### 4) **Medium** — Installer scripts suppress important command output by default, making setup failures harder to self-diagnose
- **Where:** `docs/install.sh`, `docs/install.ps1`
- **Why it matters:** Both scripts redirect/suppress substantial `npm install` / `npm run build` output in normal path. This keeps install logs clean, but when failures happen users get less immediate actionable detail and must rerun manually.
- **Risk profile:** Developer-experience friction during first setup and upgrades.

### 5) **Medium** — Tool registry builds full granular list eagerly on each call; repeated allocations likely in high-frequency introspection paths
- **Where:** `src/tools/registry.ts`
- **Why it matters:** `getTools()` reconstructs merged tool arrays each invocation. If called repeatedly (e.g., transport adapters, schema generation, health/introspection), this incurs avoidable allocation churn.
- **Risk profile:** Mild CPU/GC overhead; scales with call frequency and tool count.

### 6) **Medium** — Perf harness uses mock behaviors only; no guardrail CI benchmark against production code paths
- **Where:** `perf/perf-test.ts`
- **Why it matters:** The harness validates optimization ideas with mocks, but does not benchmark real capture/LLM/tool orchestration paths. Regressions can pass unit tests yet still degrade p95 latency in production.
- **Risk profile:** Performance regressions escaping into releases.

### 7) **Low** — UX copy and command naming surface are strong, but command-mode differences are spread across README, onboarding, doctor, and installers
- **Where:** `README.md`, `src/surface/onboarding.ts`, `src/surface/doctor.ts`, installers
- **Why it matters:** Great documentation breadth, but setup truth is fragmented. Users can still encounter ambiguity (when to run `consent`, `doctor`, `agent`, `mcp`) based on entry point.
- **Risk profile:** Minor onboarding confusion, especially for non-expert users.

## Recommended Fix Order
1. Harden daemon conflict recovery and kill-port behavior (`forceKillPort`) with safer PID parsing and explicit no-PID branch behavior.
2. Reduce global exception surface area; scope known EINVAL workaround closer to callsites if possible.
3. Introduce an explicit non-interactive consent policy flag/env (opt-in bypass), rather than implicit TTY heuristic alone.
4. Add a `--verbose` installer mode (default concise, easy re-run guidance with full logs).
5. Cache `getTools()` results by palette/group tuple to reduce repeat allocations.
6. Add at least one production-path perf smoke in CI (e.g., capture + a11y + one tool roundtrip timing budget).
