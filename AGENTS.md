# HiLink SMS Manager

## Completion checks

After completing any feature or bug fix, run all quality checks from
[CI](.github/workflows/ci.yml) before reporting the work as complete:

```sh
pnpm lint && pnpm fmt:check && pnpm typecheck && pnpm test && pnpm build
```

- Use the Node.js and pnpm versions declared in [package.json](package.json)
  and the Go version declared in [backend/go.mod](backend/go.mod).
- If dependencies are missing, install them with `pnpm install --frozen-lockfile`.
- Fix formatting with the repository's formatter (`pnpm exec oxfmt <changed-files>`);
  do not rely on manual formatting. Format changed Go files with `gofmt`.
- Fix check failures and rerun affected checks after the final edits. Editor
  diagnostics do not replace the TypeScript compiler or the other CI checks.
- Report which checks passed. If a check cannot run, state the exact blocker
  and which checks remain unverified; do not claim that validation passed.
- Documentation-only changes do not require the application test/build suite.
  Review their content, commands, and links instead.

## Scope and credentials

- Keep changes focused on the requested feature or fix.
- Never print or commit secrets from local environment files.
- Publishing images and deploying to the homelab require explicit user authorization.
