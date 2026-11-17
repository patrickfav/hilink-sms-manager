# HiLink SMS Manager

## Purpose

This repository is a small Go service and Preact frontend for reading SMS from
a Huawei HiLink modem. Messages live on the modem; the service keeps only an
in-memory snapshot and optionally forwards new messages to Slack.

## Layout and workflow

- `backend/` contains the HTTP service, modem client, polling service, and
  in-memory SMS store.
- `frontend/` contains the Preact UI. `frontend-dist/` and
  `backend/web/dist/` are generated build output; do not edit them by hand.
- `tests/e2e/` contains Playwright browser tests; Go tests live beside the Go
  packages.
- Keep modem message identity separate from the modem mutation index. Treat
  SMS text, sender values, and modem responses as untrusted input.

## Commands

Use the versions declared in `.nvmrc`, `package.json`, and `backend/go.mod`.

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm fmt:check && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e
```

Use `pnpm dev` for the local mock modem and frontend. Use `cd backend && go
test ./...` for focused backend work. Run the full checks after code changes;
documentation-only changes only need a content/link review.

## Safety and secrets

- Never commit `.env`, `.env.dev`, passwords, webhook URLs, session secrets, or
  modem credentials. Do not log resolved secrets.
- Do not use live modem delete, read-state, reboot, or Slack delivery for tests
  without explicit authorization. Prefer the mock modem and HTTP fakes.
- Preserve authentication, origin checks, secure headers, request-size limits,
  HTTPS validation, and bounded resource usage when changing the service.
- Regenerate frontend assets with `pnpm build:frontend` or `pnpm build`; never
  hand-edit generated output.
