# Senior Engineering Audit — clawdcursor

Date: 2026-05-22

## 1) Executive summary
This repository shows strong momentum and broad capability, but it is not yet production-hardened in several key areas. The core architecture and test breadth are good, but there are avoidable security and reliability risks around auth token handling, typed API boundaries, and environment-dependent test lanes.

## 2) Overall grade
**78/100 (C)**

## 3) Category grades (0–10)
- Architecture: 7.5
- Security: 6.5
- Backend/API: 7.5
- Frontend/UX: 7.5
- Performance: 7.0
- Testing/QA: 7.0
- DevOps/Infra: 8.0
- Developer Experience: 8.0
- Maintainability: 7.5
- Product readiness: 7.0

## 4) Severity-ranked findings
- **P1 | Security | src/surface/dashboard.ts, src/surface/http-utility.ts**
  - Problem: auth token previously injected into client JS and accepted disk-token drift by default.
  - Why it matters: increases credential exposure blast radius and weakens token integrity.
  - Suggested fix: use httpOnly cookie for dashboard auth; make disk-drift acceptance opt-in.
  - **Status: Fixed in this PR.**

- **P1 | Architecture/API | src/surface/mcp-server.ts**
  - Problem: `any`-typed MCP server/transport boundaries.
  - Why it matters: contract drift hidden until runtime.
  - Suggested fix: add explicit SDK-based transport/server types.
  - **Status: Follow-up.**

- **P2 | Performance/Architecture | src/tools/registry.ts**
  - Problem: tool catalog repeatedly rebuilt on lookup paths.
  - Why it matters: avoidable allocation/churn and identity drift risk.
  - Suggested fix: memoize registry and invalidate only on explicit changes.
  - **Status: Follow-up.**

- **P2 | Testing/QA | vitest.config.ts, .github/workflows/cross-platform.yml**
  - Problem: no coverage threshold gate and environment-skipped tests without compensating CI lane.
  - Why it matters: high-risk paths can regress silently.
  - Suggested fix: add coverage gate and dedicated Linux desktop deps lane.
  - **Status: Follow-up.**

- **P3 | DevEx | package.json (postinstall)**
  - Problem: postinstall verification failures are tolerated.
  - Why it matters: setup issues become latent runtime issues.
  - Suggested fix: keep non-blocking behavior but make warning more actionable and explicit in docs.
  - **Status: Follow-up.**

## 5) Risk map (top 5)
1. Token/auth leakage or abuse from overly permissive local trust assumptions.
2. Runtime MCP breakage due to untyped `any` transport contracts.
3. Hidden regressions in OS-specific flows due to skipped tests.
4. Tool-registry perf/correctness drift as feature surface grows.
5. User setup failures that only appear after startup.

## 6) Technical debt map
- MCP boundary typing debt (runtime fragility cost).
- Test lane/environment parity debt (incident/debug cost).
- Auth model simplification debt (future remote-hosting/security cost).
- Registry lifecycle/memoization debt (scaling cost).

## 7) Product-readiness assessment
**Beta-ready**: strong feature set and good CI baseline, but not yet production-hard in auth posture and typed boundary resilience.

## 8) Action plan
### Immediate fixes in this PR
- Removed dashboard token injection into client JS.
- Moved dashboard auth to same-origin httpOnly cookie.
- Made disk-token drift fallback opt-in via `CLAWD_ALLOW_DISK_TOKEN_DRIFT=1`.

### Next PR
- Type MCP server/transport interfaces end-to-end.
- Add coverage thresholds and a desktop-deps CI lane.
- Memoize tool registry.

### Later roadmap
- Full auth hardening for non-loopback scenarios.
- Observability and reliability SLO dashboarding.
- Broader resilience testing for platform-specific adapters.

## Validation commands and outcomes
- npm ci ✅
- npm run lint ✅ (warnings only)
- npm run typecheck ✅
- npm run test:ci ❌ (environment missing `libXtst.so.6` for `@nut-tree-fork/libnut-linux`)
- npm run build ✅
