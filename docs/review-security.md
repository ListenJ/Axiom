# Security Review Report — openclaw-fusion

**Date:** 2026-07-14
**Scope:** Core security files in `src/utils/`, `src/sandbox/`, `src/routes/api-keys.ts`, `src/routes/models.ts`, `src/core/config-center.ts`, `src/mcp/tools/`, `.env`, and related files.
**Methodology:** Static analysis of source code, environment files, and git history.

---

## Finding Severity

| Severity | Meaning |
|----------|---------|
| **CRITICAL** | Vulnerable to immediate exploitation; secrets or PII currently exposed |
| **WARNING** | Potential vulnerability requiring design attention or hardening |
| **INFO** | Best-practice improvement, documentation gap, or hardening suggestion |

---

## CRITICAL Findings

### C-1: Live API Key in `.env` File (Secrets Exposure)

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\.env` line 5 |
| **Value** | `ZHIPU_API_KEY=c72aeb15874d4d90990abe67009b2202.EPo0PP9b2zF6RqR6` |
| **Risk** | A real, live API key for ZhipuAI (GLM) is stored in plaintext in the project's `.env` file. Although `.env` is gitignored (line 15 of `.gitignore`), it is present on disk and could be exfiltrated via sandbox breakout, directory traversal, supply-chain attack on dependencies, or accidental commit if `.gitignore` rules change. |
| **Evidence** | `.env` line 5: `ZHIPU_API_KEY=c72aeb15874d4d90990abe67009b2202.EPo0PP9b2zF6RqR6` |
| **Fix** | 1. Immediately revoke this key at the ZhipuAI platform. 2. Generate a fresh key and store it in a secrets manager (e.g., 1Password CLI, HashiCorp Vault, or encrypted env file). 3. Remove the plaintext `.env` file and consider using `.env.production` with restricted file permissions. |

---

### C-2: Environment-Variable Substitution Leaks Secrets from Configuration

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\core\config-center.ts` line 504 |
| **Snippet** | `return obj.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");` |
| **Risk** | The `resolveEnvVars` function recursively resolves `${VAR_NAME}` patterns in YAML/JSON configuration values by reading `process.env[name]`. If an attacker can control any part of the configuration YAML (e.g., via plugin system, config injection, or file write), they can exfiltrate **any** environment variable — including `AXIOM_AUTH_TOKEN`, `DEEPSEEK_API_KEY`, `ZHIPU_API_KEY`, `DATABASE_URL`, etc. — by embedding `${AXIOM_AUTH_TOKEN}` or similar. This function is called at startup on `config-center.ts` line 134: `this.yamlData = resolveEnvVars(YAML.parse(raw))`. |
| **Fix** | 1. Restrict substitution to a whitelist of known-safe config keys (e.g., `PORT`, `LOG_LEVEL`). 2. Never resolve from `process.env` directly; use `readString()` and validate against an allowlist. 3. Sanitize the output to prevent secret leakage in error messages or API responses. |

---

### C-3: API Key Last-4 Exposure via `/providers` Endpoint

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\routes\models.ts` lines 48-52 |
| **Snippet** | `apiKeyLast4: process.env.SILICONFLOW_API_KEY?.slice(-4) ?? ""` |
| **Risk** | The `/providers` endpoint (GET) exposes the last 4 characters of every configured API key. While only the last 4 chars are revealed, this substantially reduces the keyspace for brute-force attacks and can be used to confirm which keys are valid. The `/api-keys` endpoint correctly implements masked output (`sk-aaaa****`), but the `/providers` endpoint does not. Additionally, this endpoint has **no authentication check**. |
| **Fix** | 1. Remove `apiKeyLast4` from API responses entirely. 2. Add `requireAuth()` to `handleListProviders` and `handleTestProvider`. 3. Alternatively, use the same masking function as `api-key-store.ts` (`maskKey()`). |

---

### C-4: Arbitrary SQL Query Execution via CLI `db:query` Command

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\cli.ts` lines 258-271 |
| **Snippet** | `const sql = args.join(" ");` … `const rows = db.query(sql).all();` |
| **Risk** | The `db:query` CLI command takes arbitrary user-supplied SQL and executes it against the SQLite database with no validation or restrictions. While this is a CLI command (requiring local access), it can be invoked through the sandbox if an attacker gains shell access, or through MCP tools that execute CLI commands. This could allow data destruction, exfiltration of API keys stored in the database, or arbitrary file reads via `ATTACH DATABASE`. |
| **Fix** | 1. Remove the `db:query` command or restrict it to a whitelist of SELECT queries. 2. Never expose this through any API or MCP tool. 3. Add a confirmation prompt for any destructive operations. |

---

### C-5: SQL Injection via String Interpolation in CLI

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\cli.ts` line 184 |
| **Snippet** | `db.query(\`SELECT COUNT(*) as c FROM ${t}\`).get()` |
| **Risk** | Although the table names in this specific call come from a hardcoded array (lines 181: `const tables = ["conversations", "tasks", "knowledge", ...]`), the pattern of string interpolation for table names is dangerous. If `t` were ever to come from user input (or if the hardcoded array is modified later), this becomes a SQL injection vector. The pattern also sets a bad precedent for future code. |
| **Fix** | 1. Keep the hardcoded array but validate table names against a whitelist. 2. Add a helper function that validates table names before using them. 3. Prefer parameterized queries for all SQL operations. |

---

## WARNING Findings

### W-1: In-Memory API Key Plaintext Storage (No Encryption at Rest)

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\utils\api-key-store.ts` lines 48, 63-68; `D:\openclaw-fusion\src\utils\api-key-persistence.ts` lines 64-75 |
| **Risk** | API keys are stored in plaintext in both the in-memory `Map` (`store` at line 48) and in the SQLite `api_key_overrides` table (line 74). The SQLite database file (`data/agent.db` by default) is not encrypted. If the database file is accessed (via file read, backup, or exfiltration), all runtime API keys are compromised. |
| **Fix** | 1. Encrypt API keys at rest using a deterministic encryption scheme (e.g., AES-256-GCM with a key derived from `AXIOM_AUTH_TOKEN`). 2. Decrypt on read from the store. 3. Consider using OS-level keychains (Keychain, Credential Manager, Secret Service) for the encryption key. |

---

### W-2: Process Sandbox Command Injection

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\sandbox\process-sandbox.ts` lines 28-48 |
| **Snippet** | `args = ["-c", \`\${limits.join("; ")}; \${opts.command} \${(opts.args ?? []).join(" ")}\`]` |
| **Risk** | On Linux, the sandbox constructs a shell command by concatenating `opts.command` and `opts.args` with a semicolon separator into a single `sh -c` string. If `opts.command` contains shell metacharacters (e.g., ``; rm -rf /``), they are executed. The permission checks in `permissions.ts` run **before** sandbox execution and can block some dangerous patterns, but the sandbox itself has no input sanitization. Additionally, `Bun.spawn` with `["sh", "-c", command]` passes the entire string to the shell, enabling full shell injection. On Windows, `opts.args` are passed as arguments to `cmd.exe /c`, which is slightly safer but still vulnerable. |
| **Fix** | 1. Sanitize the command string within the sandbox itself (defense in depth). 2. Prefer `Bun.spawn` with separate command+args (no shell) whenever possible, or use `child_process.spawn` with `shell: false`. 3. Apply the same high-risk pattern checks used in `permissions.ts` inside the sandbox. |

---

### W-3: Docker Sandbox Arbitrary Host Directory Mount

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\sandbox\docker-sandbox.ts` lines 56-58 |
| **Snippet** | `const mountDir = opts.cwd || "/tmp"` … `dockerArgs.push("-v", \`\${mountDir}:/workspace:ro\`)` |
| **Risk** | If `opts.cwd` is attacker-controlled, an attacker can mount **any** host directory (e.g., `/`, `/etc`, `/home`) into the container as `/workspace`. While it is mounted read-only (`:ro`), this still allows reading arbitrary files on the host, including `.env`, SSH keys, and database files. The only thing preventing this is the caller's intent — there is no path validation. |
| **Fix** | 1. Resolve `opts.cwd` against a sandboxed base directory (e.g., only allow paths under the project root). 2. Validate that the resolved path is within an allowed directory using `path.resolve()` and prefix checking. 3. Reject paths containing `..` or starting with `/`. |

---

### W-4: Shell Command Injection in `workspace-snapshot.ts`

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\mcp\tools\workspace-snapshot.ts` lines 114-115, 158, 170-172, 179, 216-218, 268-269, 274-275, 281-282, 286-287 |
| **Snippet** | `execSync(\`git commit -m "\${commitMsg.replace(/"/g, '\\"')}" --allow-empty\`, ...)` (line 114-115) |
| **Risk** | Multiple `execSync` calls construct shell commands using template literals with user-influenced data. The `commitMsg` variable is sanitized only for double quotes but not for backticks, `$()`, or other shell metacharacters. The `snapshotId` and `file` variables are used unsanitized in commands like `git show ${snapshotId}:${file}`, `git ls-tree -r --name-only ${snapshotId}`, and `git cat-file -t ${snapshotId}`. While these are typically internal/controlled values, MCP tools could allow indirect invocation. |
| **Fix** | 1. Use `spawn()` with separate arguments instead of `execSync()` with shell strings. 2. If `execSync()` must be used, sanitize all interpolated values with `shell-quote` or similar escaping. 3. Validate `snapshotId` against `/^[a-f0-9]{7,40}$/` before using it. |

---

### W-5: Shell Execution via `codegraph-index.ts` with `shell: true`

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\memory\codegraph-index.ts` line 88 |
| **Snippet** | `const proc = spawn(bin, args, { cwd: cwd || process.cwd(), shell: true });` |
| **Risk** | The `shell: true` option passes the command through a shell, enabling shell injection if `bin` or `args` contain user-influenced content. While `bin` comes from `getCodegraphBin()` (which searches a hardcoded list), `args` could potentially be influenced via MCP tool parameters. |
| **Fix** | Remove `shell: true`. The `spawn` function without `shell: true` still resolves the binary via PATH and passes arguments directly to the process. |

---

### W-6: Terminal Tool Command Sanitization Bypass

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\mcp\tools\terminal.ts` lines 33-51 |
| **Risk** | The `sanitizeCommand` function uses regex patterns to block dangerous commands. However, it can be bypassed with: (1) Unicode homoglyphs (e.g., `ｒｍ` instead of `rm`), (2) Command wrapping (e.g., `$(rm -rf /)`), (3) Environment variable expansion (e.g., `${SHELL}` to get shell path), (4) Base64-encoded commands piped to shell (e.g., `echo "cm0gLXJmIC8=" | base64 -d | sh`). The `killProcess` function (line 253) builds shell commands with template literals: `` `kill -${normalizedSignal.replace("SIG", "")} ${pid}` `` which is then passed to `executeCommand` with `shell: true`. While `pid` is typed as `number`, any type-coercion bug could expose injection. |
| **Fix** | 1. Block all shell metacharacters (`;`, `|`, `` ` ``, `$()`, `${}`, `\`) in the sanitizer instead of using pattern allowlists. 2. Use separate argument arrays with `spawn()` instead of shell strings. 3. Validate and stringify `pid` explicitly: `String(pid)`. |

---

### W-7: Direct `process.env` Access Bypassing `readString` Wrapper

| Attribute | Detail |
|-----------|--------|
| **Files** | Multiple files across the codebase — see evidence |
| **Evidence** | `src/main.ts:283`, `src/knowledge/pipeline.ts:39`, `src/knowledge/sources/github-trending.ts:87`, `src/memory/vault-manager.ts:60-62`, `src/router/models/providers.ts:41`, `src/routes/models.ts:48-52`, `src/utils/proxy-fetch.ts:275-285`, `src/utils/adaptive-proxy.ts:151`, `src/utils/logger.ts:237-247`, `src/core/config-center.ts:154,504,585-593` |
| **Risk** | Direct `process.env` access bypasses the `readString`/`readInt`/`readBool` typed getters defined in `src/utils/env.ts`. This means: (a) no default values are applied, (b) validation is skipped, (c) logging of accessed keys is bypassed, (d) the centralized env-snapshotting mechanism for tests is ineffective. In particular, `config-center.ts` line 504 uses `process.env[name]` directly without validation, which is part of the env-var injection attack surface. |
| **Fix** | 1. Audit all direct `process.env` accesses and migrate to `readString()` / `readInt()` / `readBool()`. 2. Add a lint rule (e.g., `no-process-env`) to prevent future direct accesses. |

---

### W-8: In-Memory Rate Limiter (No Persistence, Bypass on Restart)

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\utils\rate-limiter.ts` lines 16-18, 116-119; `D:\openclaw-fusion\src\utils\security.ts` lines 126-157 |
| **Risk** | Both the `RateLimiter` (rate-limiter.ts) and `checkRateLimit` (security.ts) store rate-limit state in plain `Map<string, ...>` objects with no persistence. An attacker can: (a) wait for a server restart to reset all rate limits, (b) use IP rotation to bypass IP-based limiting, (c) exhaust server memory by creating many unique keys. The `checkRateLimit` function (security.ts) has no cleanup mechanism for stale entries, unlike the `RateLimiter.cleanup()` method. |
| **Fix** | 1. Persist rate-limit state in SQLite or Redis for cross-restart durability. 2. Add automatic cleanup of stale entries in `checkRateLimit`. 3. Consider using a sliding-window with a token-bucket algorithm stored in SQLite. 4. Add request body size validation middleware. |

---

### W-9: No Input Validation on Provider `baseURL` in Model Routes

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\routes\models.ts` lines 61-86 (handleAddModel) |
| **Risk** | The `handleAddModel` handler accepts a `baseURL` from the request body (line 74: `baseURL: body.baseURL ? String(body.baseURL) : undefined`) and stores it in `model-config.json`. It does **not** validate the URL protocol or perform SSRF protection. When this URL is used later to make API calls, it could be used for Server-Side Request Forgery (SSRF) to internal services. In contrast, the `/api-keys` endpoint correctly validates baseURL (line 56-64 of `api-keys.ts`). |
| **Fix** | 1. Apply the same `isValidBaseURL` validation from `api-keys.ts`. 2. Block private IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) for baseURLs. |

---

### W-10: No Authentication on `/providers` and `/models` Endpoints

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\routes\models.ts` lines 55-126 |
| **Risk** | The handlers `handleListModels`, `handleAddModel`, `handleDeleteModel`, `handleListProviders`, and `handleTestProvider` have no authentication middleware. Unlike `/api-keys` (which requires `AXIOM_AUTH_TOKEN`), these endpoints are open to anyone who can reach the server. The `/providers` endpoint exposes API key metadata, and `/models` allows modifying model configurations. |
| **Fix** | 1. Add a `requireAuth()` call at the top of each handler. 2. Reuse the same `requireAuth` function from `src/routes/api-keys.ts` (or move it to a shared middleware module). |

---

### W-11: Default CORS Configuration Allows `*` Origin

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\utils\security.ts` lines 99, 114-115 |
| **Snippet** | `const { allowedOrigins = ["*"], ... } = options || {};` … `if (allowedOrigins.includes("*")) { headers["Access-Control-Allow-Origin"] = "*"; }` |
| **Risk** | The default CORS configuration in `createCorsHeaders` sets `Access-Control-Allow-Origin: *` when no explicit allowed origins are provided. While `main.ts` (line 352-353) overrides this with a specific origin list from CORS_ORIGINS env var, any code path calling `createCorsHeaders` without the `allowedOrigins` option will default to `*`, which allows any website to make cross-origin requests. |
| **Fix** | 1. Remove the `["*"]` default and require explicit origins. 2. In `main.ts`, explicitly pass the default origins rather than relying on the function default. |

---

### W-12: Permission Middleware Bypass — Direct Calls to Sandbox

| Attribute | Detail |
|-----------|--------|
| **Files** | `D:\openclaw-fusion\src\utils\permission-middleware.ts` vs `D:\openclaw-fusion\src\sandbox\index.ts` |
| **Risk** | The `checkToolPermission` middleware only checks known tool names (`execute_command`, `shell`, `bash`, `delete_file`, `remove`, `rm`). Any code path that calls `executeInSandbox()` or `dockerSandbox.execute()` directly (without going through the middleware) bypasses all permission checks. There is no enforcement layer at the sandbox level itself. If new tool names are added without updating the middleware, they also bypass checks. |
| **Fix** | 1. Move permission checks into the sandbox `execute()` function itself (defense in depth). 2. Create a unified execution entry point that always applies permission checks. 3. Use a decorator or wrapper pattern to ensure checks cannot be bypassed. |

---

### W-13: No Timeout on Docker Container Cleanup

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\sandbox\docker-sandbox.ts` lines 70-75 |
| **Snippet** | `setTimeout(() => { try { Bun.spawnSync(["docker", "kill", containerName], {}); } catch {} … }, timeout + 5000)` |
| **Risk** | If the Docker sandbox fails to clean up the container (e.g., `docker kill` fails silently due to the empty catch block), containers accumulate as zombie/leaked resources. Each leaked container consumes disk space (container layers) and may hold network ports or volumes. An attacker could exhaust server resources by repeatedly triggering sandbox executions. |
| **Fix** | 1. Log the failure when `docker kill` or `docker rm` fails. 2. Add a fallback cleanup mechanism (e.g., periodic `docker prune` or tracking container names for cleanup on next start). 3. Use `--rm` flag which is already present (line 31: `"run", "--rm"`), but the kill may prevent proper cleanup. |

---

## INFO Findings

### I-1: Confirmation IDs Use Weak Randomness

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\utils\permissions.ts` line 81 |
| **Snippet** | `const id = Math.random().toString(36).slice(2, 10)` |
| **Risk** | `Math.random()` is not cryptographically secure. An attacker who can observe multiple confirmation IDs could predict future IDs and approve high-risk operations without user consent. |
| **Fix** | Use `crypto.randomUUID()` or `require("crypto").randomBytes(16).toString("hex")` instead. |

---

### I-2: Confirmation State Stored in Memory (No Persistence Across Requests)

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\utils\permissions.ts` lines 75, 80-102 |
| **Risk** | The `pendingConfirmations` map is entirely in-memory. If the server restarts or crashes, all pending confirmations are lost. The 5-minute expiry (line 85: `Date.now() + 300_000`) mitigates this somewhat, but a server restart during a pending confirmation would allow the operation to be re-initiated without consequence. |
| **Fix** | This is an acceptable design trade-off for a single-server deployment, but consider persisting to SQLite for multi-server deployments. The current implementation is acceptable for the stated architecture. |

---

### I-3: No Certificate Pinning or TLS Configuration

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\utils\security.ts` lines 4-12 |
| **Risk** | The security headers include HSTS (line 33-34) but there is no certificate pinning, mutual TLS (mTLS), or TLS version enforcement documented or configured. API keys are transmitted over plain HTTP on localhost by default. |
| **Fix** | 1. Document TLS requirements for production deployments. 2. Consider adding `Strict-Transport-Security` header with `preload` only in production (already done: line 32). 3. This is acceptable for localhost development but should be flagged for production. |

---

### I-4: Redis Password in Plaintext (If Redis Is Used)

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\utils\redis-client.ts` lines 20, 340 |
| **Snippet** | `password?: string;` … `password: parsed.password || undefined,` |
| **Risk** | If Redis is configured with a password (via `REDIS_URL` containing credentials in the userinfo portion), the password is passed in plaintext. This is standard for Redis but should be noted. The password could leak through error messages or logging. |
| **Fix** | 1. Ensure Redis passwords are never logged. 2. Consider using Redis ACLs or TLS client certificates instead of passwords. |

---

### I-5: Proxy URL Credentials in Plaintext

| Attribute | Detail |
|-----------|--------|
| **Files** | `D:\openclaw-fusion\src\utils\proxy-fetch.ts` line 225, `D:\openclaw-fusion\src\utils\adaptive-proxy.ts` line 151 |
| **Snippet** | `auth: url.username ? \`\${url.username}:\${url.password}\` : undefined` |
| **Risk** | Proxy authentication credentials are extracted from URLs and stored in memory as plaintext strings. These could leak through error messages, logs, or memory dumps. |
| **Fix** | 1. Mask credentials in log output. 2. Consider using environment-specific proxy configurations. |

---

### I-6: Logging Contains Sensitive Data in Plaintext

| Attribute | Detail |
|-----------|--------|
| **Files** | `D:\openclaw-fusion\src\utils\logger.ts` — numerous log statements throughout the codebase |
| **Risk** | Several log statements output variable values that could contain sensitive data. Notably, `src/utils/api-key-store.ts` line 69: `logger.info(\`[ApiKeyStore] Override set for provider: \${provider}\`)` — while this does not log the key itself, other log statements throughout the codebase use `JSON.stringify` on request bodies, responses, and error objects, which may inadvertently include API keys, tokens, or other secrets. The `sanitizeRequestBody` function in `security.ts` (lines 49-78) exists but is not used universally. |
| **Fix** | 1. Apply `sanitizeRequestBody` to all log entries that include request/response data. 2. Add a logging wrapper that automatically redacts known sensitive fields. 3. Review all `logger.*` calls for potential secret leakage. |

---

### I-7: CSP Includes `unsafe-inline`

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\utils\security.ts` line 39 |
| **Snippet** | `script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'` |
| **Risk** | The Content-Security-Policy header includes `'unsafe-inline'` for both scripts and styles. This weakens XSS protection because any injected script or style tag will execute. However, this may be required by the frontend framework (SPA). |
| **Fix** | 1. Remove `unsafe-inline` and use nonces or hashes if the frontend framework supports it. 2. If `unsafe-inline` is required, document the exception and add additional XSS protections (X-XSS-Protection is already set and is deprecated). |

---

### I-8: No CSRF Protection

| Attribute | Detail |
|-----------|--------|
| **Files** | All route handlers |
| **Risk** | There is no Cross-Site Request Forgery (CSRF) protection. While the `x-api-key` header requirement for `/api-keys` mitigates CSRF on that endpoint, the `/models` and `/providers` endpoints have no authentication and no CSRF token. If an attacker can lure a logged-in admin to visit a malicious site, that site could make cross-origin requests to modify model configurations. |
| **Fix** | 1. Add CSRF tokens for state-changing requests (POST, PUT, DELETE). 2. Use `SameSite=Strict` or `SameSite=Lax` cookies. 3. Verify Origin/Referer headers for state-changing requests. |

---

### I-9: Sandbox Network Isolation Documentation Gap

| Attribute | Detail |
|-----------|--------|
| **File** | `D:\openclaw-fusion\src\sandbox\process-sandbox.ts` lines 41-44 |
| **Snippet** | `logger.warn("[Sandbox] Network isolation requires Docker sandbox")` |
| **Risk** | The process sandbox cannot enforce network isolation on Linux without network namespaces (which require root). The warning is logged but no action is taken. If the Docker sandbox is unavailable and the process sandbox is used, sandboxed commands have full network access. This is a design limitation, not a bug. |
| **Fix** | Document this limitation prominently. Consider implementing network namespace support for Linux via `unshare()` or using seccomp to restrict socket-related syscalls. |

---

### I-10: `ZHIPU_API_KEY` Referenced in Code Outside Controlled Paths

| Attribute | Detail |
|-----------|--------|
| **Files** | `D:\openclaw-fusion\src\knowledge\pipeline.ts:39`, `D:\openclaw-fusion\src\routes\models.ts:49`, `D:\openclaw-fusion\src\router\models\providers.ts:50` |
| **Risk** | The `ZHIPU_API_KEY` environment variable is referenced directly via `process.env` in multiple locations (not through the `api-key-store` abstraction). This means the runtime API key override system does **not** apply to ZHIPU_API_KEY in the `knowledge/pipeline.ts` and `routes/models.ts` code paths — if a user sets a runtime override for `zhipu`, the knowledge pipeline will still use the `process.env` value. |
| **Fix** | 1. Add `zhipu` provider support to `api-key-store.ts` (currently it only has `zhipu` missing from `PROVIDER_CONFIG`? Let me verify). Actually, looking at `PROVIDER_CONFIG` in `api-key-store.ts` (lines 27-34), there is no `zhipu` entry. 2. Add `zhipu` to `PROVIDER_CONFIG`. 3. Update all code paths to use `getEffectiveApiKey()` instead of `process.env.ZHIPU_API_KEY`. |

---

## Summary Table

| # | Severity | Area | Description |
|---|----------|------|-------------|
| C-1 | **CRITICAL** | Secrets | Live API key in `.env` file |
| C-2 | **CRITICAL** | Config | Env var substitution leaks all secrets via config |
| C-3 | **CRITICAL** | API | API key last-4 exposed on unauthenticated endpoint |
| C-4 | **CRITICAL** | SQL | Arbitrary SQL execution via CLI `db:query` |
| C-5 | **WARNING** | SQL | SQL injection via table name interpolation |
| W-1 | **WARNING** | Storage | API keys in plaintext in SQLite (no encryption at rest) |
| W-2 | **WARNING** | Sandbox | Process sandbox command injection via shell concatenation |
| W-3 | **WARNING** | Sandbox | Docker sandbox arbitrary host directory mount |
| W-4 | **WARNING** | Shell | Shell command injection in workspace-snapshot MCP tool |
| W-5 | **WARNING** | Shell | `shell: true` in codegraph-index.ts spawn |
| W-6 | **WARNING** | Shell | Terminal tool sanitization bypass + killProcess injection |
| W-7 | **WARNING** | Env | Direct `process.env` access bypassing `readString` |
| W-8 | **WARNING** | Rate | In-memory rate limiter, bypassable on restart |
| W-9 | **WARNING** | SSRF | No baseURL validation in model routes |
| W-10 | **WARNING** | Auth | No auth on `/providers` and `/models` endpoints |
| W-11 | **WARNING** | CORS | Default CORS allows wildcard origin |
| W-12 | **WARNING** | Auth | Permission middleware bypassable via direct sandbox calls |
| W-13 | **WARNING** | Ops | Docker container cleanup may leak resources |
| I-1 | **INFO** | Crypto | Weak `Math.random()` for confirmation IDs |
| I-2 | **INFO** | Design | Confirmation state in-memory only |
| I-3 | **INFO** | TLS | No TLS configuration documented |
| I-4 | **INFO** | Storage | Redis password in plaintext |
| I-5 | **INFO** | Storage | Proxy credentials in plaintext |
| I-6 | **INFO** | Logging | Sensitive data may be logged |
| I-7 | **INFO** | CSP | CSP includes `unsafe-inline` |
| I-8 | **INFO** | CSRF | No CSRF protection |
| I-9 | **INFO** | Sandbox | Process sandbox lacks network isolation |
| I-10 | **INFO** | Consistency | ZHIPU_API_KEY not managed by api-key-store |

---

## Recommended Immediate Actions

1. **Revoke the leaked `ZHIPU_API_KEY`** (value: `c72aeb15874d4d90990abe67009b2202.EPo0PP9b2zF6RqR6`) at the ZhipuAI platform.
2. **Add authentication** to `/providers` and `/models` endpoints (reuse `requireAuth` from `api-keys.ts`).
3. **Remove `apiKeyLast4`** from provider responses in `routes/models.ts`.
4. **Restrict `resolveEnvVars`** to a whitelist of safe config keys.
5. **Add input sanitization** to the process sandbox `execute()` function (defense in depth).
6. **Audit all `process.env`** direct accesses and migrate to `readString()`.
7. **Disable `db:query` CLI command** for production builds.
8. **Encrypt API keys at rest** in the SQLite database.

---

## Files Reviewed

| File | Lines | Focus |
|------|-------|-------|
| `src/utils/permissions.ts` | 102 | Permission checks, confirmation system |
| `src/utils/permission-middleware.ts` | 33 | Tool permission middleware |
| `src/sandbox/index.ts` | 23 | Sandbox provider selection |
| `src/sandbox/types.ts` | 29 | Sandbox type definitions |
| `src/sandbox/process-sandbox.ts` | 82 | Process-level sandbox |
| `src/sandbox/docker-sandbox.ts` | 100 | Docker sandbox |
| `src/utils/api-key-store.ts` | 179 | API key runtime override store |
| `src/utils/api-key-persistence.ts` | 83 | API key SQLite persistence |
| `src/utils/security.ts` | 158 | Security headers, CORS, rate limiting, sanitization |
| `src/utils/env.ts` | 323 | Environment variable handling |
| `src/utils/approval-bridge.ts` | 228 | HITL approval bridge |
| `src/routes/api-keys.ts` | 166 | API key management routes |
| `src/routes/models.ts` | 126 | Model/provider management routes |
| `src/routes/types.ts` | 36 | Route context types |
| `src/core/config-center.ts` | 601 | Configuration center (env var resolution) |
| `src/mcp/tools/terminal.ts` | 274 | Terminal command execution |
| `src/mcp/tools/workspace-snapshot.ts` | 352 | Git-based workspace snapshots |
| `src/memory/codegraph-index.ts` | 577 | Code graph indexing |
| `src/main.ts` | 576 | Application entry point |
| `src/utils/rate-limiter.ts` | 120 | Rate limiting |
| `.env` | 15 | Environment variables (live) |
| `.env.example` | 32 | Environment template |
| `.env.production.example` | 92 | Production environment template |
| `.gitignore` | 135 | Git ignore rules |

---

*Report generated by automated security review.*
