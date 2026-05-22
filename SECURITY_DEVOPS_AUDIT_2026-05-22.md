# Security + DevOps/Infra Audit (2026-05-22)

## Scope reviewed
- AuthN/Z and HTTP transport hardening
- Secrets handling and token lifecycle
- Input validation and unsafe defaults
- CI/CD and dependency posture

## Top findings

### 1) Dashboard injects bearer token directly into client-side JS
**Severity:** High

The dashboard route injects the full bearer token into inline HTML/JS so browser-side code can call `/mcp`.

- `mountDashboard()` substitutes `__CLAWD_TOKEN_PLACEHOLDER__` with the live token.
- Comments acknowledge this is only acceptable for localhost assumptions.

**Risk:** Any XSS in dashboard HTML/JS (current or future), malicious browser extension, or host misbind can exfiltrate the API bearer token and allow full MCP tool execution as the local user.

**Evidence:** `src/surface/dashboard.ts` lines 11-18.

**Recommendation:** Move to server-managed session auth (httpOnly + sameSite cookies), eliminate token exposure in DOM/JS, add strict CSP + nonce and consider disabling dashboard in production/headless runs.

---

### 2) Auth gate accepts rewritten on-disk token (token drift acceptance)
**Severity:** Medium

`requireAuth` accepts either in-memory token or a newly read disk token if token file changed.

**Risk:** If an attacker/process can write `~/.clawdcursor/token`, they can rotate the token and immediately gain API access without restarting daemon. This weakens token integrity guarantees and can hide unauthorized token replacement.

**Evidence:** `src/surface/http-utility.ts` lines 101-119.

**Recommendation:** Fail closed on token drift by default (reject rewritten token), and require explicit admin action to rotate token. If drift compatibility is required, gate behind opt-in env flag and emit high-severity alert.

---

### 3) Host bind is configurable; trust model depends on localhost-only deployment
**Severity:** Medium

Server defaults to `127.0.0.1`, but runtime binds to configurable `config.server.host`.

**Risk:** If set to `0.0.0.0` or LAN interface, auth/token model and dashboard token-in-JS become significantly riskier; CORS does not protect non-browser clients.

**Evidence:** `src/types.ts` lines 138-142 and `src/surface/cli.ts` lines 445-449.

**Recommendation:** Enforce loopback-only by default at runtime (hard block non-loopback unless explicit `--allow-remote` with loud warnings), optionally require mTLS/reverse proxy auth for remote mode.

---

### 4) Postinstall verification is allowed to fail silently
**Severity:** Low

`postinstall` runs `node scripts/verify-install.js || true`.

**Risk:** Broken or partial install verification can be ignored, reducing deployment reliability and potentially masking integrity/setup problems.

**Evidence:** `package.json` line 47.

**Recommendation:** Remove `|| true` for CI/release installs, or conditionally allow soft-fail only in local dev with explicit warning and telemetry.

---

### 5) CI coverage is good, but lacks explicit dependency-vuln gate
**Severity:** Low

CI runs lint/typecheck/tests across OS matrix and CodeQL is configured. Dependabot is enabled.

**Gap:** No explicit failing gate for known npm advisories (e.g., `npm audit --production` with policy thresholds) and no SBOM/artifact attestations.

**Evidence:** `.github/workflows/cross-platform.yml` lines 38-57; `.github/workflows/codeql.yml`; `.github/dependabot.yml`.

**Recommendation:** Add scheduled + PR audit gate (or OSV/Snyk/Trivy), generate SBOM (CycloneDX/SPDX), and adopt provenance attestations for release artifacts.
