# Security

## Reporting a vulnerability

Please report vulnerabilities **privately** via GitHub Security Advisories ("Report a vulnerability" on the repository's Security tab). Do not open public issues and do not include personal data.

## Threat model (single user, runs on your own computer)

The data is personal: job applications, notes, resumes and contacts. It never leaves the machine except when you import a job URL (the posting is fetched) or explicitly ask Claude to read a posting. The main risks:

- other websites or other devices on the network reaching the local API
- SSRF through user-supplied URLs (your router, printers, local services, cloud metadata)
- prompt injection via scraped job pages
- XSS from scraped content
- personal data leaking into the repository, logs, screenshots or backups
- accidental loss: resets, failed migrations, bad restores

## Controls

### Local server and access

- **Loopback only.** The server listens on `127.0.0.1`; it is not reachable from other devices.
- **Host check (DNS rebinding).** Requests whose `Host` is not `127.0.0.1:<port>` / `localhost:<port>` are rejected before the app runs, so a malicious website that rebinds its domain to 127.0.0.1 gets `403`.
- **Cross-origin writes blocked.** State-changing requests must come from the app's own origin (`Origin` / `Sec-Fetch-Site`); `Origin: null` and cross-site requests are rejected. Only JSON and multipart bodies are accepted. No CORS headers are sent, so other sites cannot read API responses.
- **Single user.** The identity is the owner of the local database, never a value from the browser. Every query is still scoped by `user_id` (tested), so the multi-user boundary stays intact.
- **Headers:** a strict CSP (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP; API responses are `no-store`. The page loads nothing from third parties.

### SSRF (URL import)

`src/server/extraction/safe-fetch.ts` + `net.ts`:

- http/https only; ports 80/443 only; credentials in URLs rejected.
- Literal private, loopback, link-local, CGNAT, multicast and documentation IPv4/IPv6 addresses are blocked (including IPv4-mapped, NAT64 and 6to4 forms, and `169.254.169.254`); internal names (`localhost`, `*.local`, `*.internal`, single-label hosts) are blocked.
- Every DNS answer (A and AAAA) is checked, **and the address is checked again when the connection is made** (custom `lookup` on the HTTP agent), so DNS rebinding between the check and the request is refused. Tested with a public name that resolves to 127.0.0.1.
- Redirects are followed manually and re-validated at every hop (max 5); 12 s timeout, 3 MB cap, content-type allow-list. Proxy environment variables are ignored.

### Respecting site rules

- No login, CAPTCHA or bot-protection bypass; such pages return `access_restricted`.
- LinkedIn, Indeed, Glassdoor, ZipRecruiter and Monster are never fetched. The link is saved and you paste the description instead.

### AI and prompt injection (optional Claude Code)

- Off by default; runs only when you tick "Use Claude AI" for an extraction. Only the posting text is sent.
- The CLI runs with **no tools** (`--tools ""`), `--safe-mode` (no CLAUDE.md, hooks, plugins, skills, MCP), `--strict-mcp-config`, no session persistence, in an empty temporary directory, with an allow-listed environment (no `ANTHROPIC_*` keys, provider switches or proxies).
- **Billing guard:** it runs only when `claude auth status` reports subscription sign-in (`claude.ai`). API keys, tokens, helpers and cloud-provider auth are refused.
- System instructions are separate from the untrusted posting, which is wrapped in delimiters with look-alikes stripped. Output is data only, validated with zod against a JSON schema; each field must cite a verbatim quote from the posting, sensitive fields without one are dropped, and salary numbers must appear in the quote.

### AI drafts and the Claude Desktop extension

- The extension (`integrations/claude-desktop`) is a dependency-free MCP server with two tools: `create_job_draft` and `check_job_url` (answers yes/no only). It has no file, shell or database access, can only reach `127.0.0.1`/`localhost`, and cannot read, edit, save or delete jobs. Claude Desktop asks before each tool use.
- Drafts are verified on the server: values claimed from the posting need an exact quote found in the job description; sensitive fields (salary, visa, authorization, eligibility, work mode, deadline) are dropped unless verified; web-sourced values need a source link; inferences are flagged. A draft becomes a job only through the normal review → apply path after the user clicks Save.
- Nothing about existing jobs is returned to the AI tool.

### XSS

- React escapes all output; no `dangerouslySetInnerHTML`. Scraped HTML becomes plain text server-side. External links use `rel="noopener noreferrer nofollow"`.

### Files

- Documents are stored under `~/Library/Application Support/CareerAtlas/documents/` with random keys, written atomically, owner-only permissions, served only after an ownership check.
- Uploads: size limit, MIME allow-list, magic-byte check. Downloads: `Content-Disposition`, `nosniff`, `no-store`, a sandboxing CSP (PDFs get a locked-down CSP without `sandbox` so the built-in viewer works).
- CSV export neutralizes spreadsheet formula injection.

### Data at rest, backups and integrity

- Database, documents, config and logs are owner-only (`umask 077`, files `0600`, folders `0700`), outside the repository. Use FileVault for full-disk encryption.
- Weekly AES-256-GCM encrypted backups to `~/CareerAtlasBackups`; key in `~/.config/career-atlas/backup.key` (separate, `0600`, never printed or logged). Every backup is test-restored before it counts; tampering is detected (GCM auth tag + checksums).
- Safe lifecycle: no silent database recreation, lock-verified migrations, verified backup before any migration, downgrade refusal, dev/test/demo instances cannot open the personal folder. See [docs/DATA_PROTECTION.md](docs/DATA_PROTECTION.md).

### Secrets, logging and repository hygiene

- No personal data or secrets in the repository: databases, `*.sqlite*`, `*.enc`, dumps, exports, PDFs, `.env*` are git-ignored. A pre-commit hook runs `npm run check:secrets` (keys, tokens, private keys, non-example emails, dumps, databases, backups); CI repeats it and runs gitleaks over the full history.
- Minimal logging: request id, method, route pattern, error class and a scrubbed message (`scrubLogText` removes SQL, parameters and quoted strings). Never request bodies, notes, JD text, resumes or tokens. Error responses never include stack traces or SQL.
- CI uses no secrets and read-only permissions.

## Before making the repository public

Follow [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md). If anything sensitive was ever committed, publish from a fresh history instead of flipping visibility.
