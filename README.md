# HiLink SMS Manager

A single-container web inbox for SMS stored on a Huawei HiLink modem. It keeps only an in-memory snapshot, detects common numeric verification codes, and can best-effort forward newly received messages to Slack.

## Development

Prerequisites: Go 1.27.3+, Node.js 26+, and pnpm 12.5+.

```sh
pnpm install
cd backend && go mod download && cd ..
pnpm dev
```

`pnpm dev` creates a local `.env.dev` from `.env.dev.example` on first run, then starts the mock modem, Go backend with Air reload, and Vite together. Open `http://localhost:5173` and sign in with `admin` / `admin`. These defaults are for local development only. The frontend proxies `/api` to `127.0.0.1:8080`. Use `pnpm build` to generate frontend assets and compile `dist/hilink-sms`.

The mock starts with an empty inbox. Inject a message with:

```sh
curl -X POST http://127.0.0.1:18080/__mock/messages \
  -H 'Content-Type: application/json' \
  -d '{"sender":"+1 555 0100","text":"Your verification code is 482913."}'
```

The SMS appears after the next backend poll. Delete it in the app as usual. The mock stores messages only in memory and binds to loopback by default; it implements only the API subset used by this app and does not establish compatibility with physical modem firmware.

Commands: `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm lint:fix`, `pnpm fmt`, `pnpm fmt:check`, and `pnpm typecheck`.

## Configuration

All application configuration is through environment variables:

| Variable | Required | Default / meaning |
|---|---:|---|
| `HILINK_URL` | no | `http://192.168.8.1` |
| `HILINK_USERNAME` | yes | Modem administrator user |
| `HILINK_PASSWORD` | yes | Modem administrator password |
| `ADDRESS_BOOK` | no | `number:name` pairs separated by `|`, for example `+436991234456:Patrick Favre|+436992234456:Something else` |
| `AUTH_USERNAME` | yes | Web login user |
| `AUTH_PASSWORD_HASH` | yes | bcrypt password hash |
| `POLL_INTERVAL` | no | `15s`; backend modem polling and Slack detection run every `2 × POLL_INTERVAL` (30s by default), after an immediate startup sync |
| `SESSION_TTL` | no | `12h` |
| `SLACK_ENABLED` | no | `false` |
| `SLACK_WEBHOOK_URL` | when enabled | HTTPS Slack incoming webhook |
| `LISTEN_ADDR` | no | `:8080` |
| `TRUSTED_PROXY` | no | Comma-separated proxy CIDRs that may assert HTTPS and forwarded host |

Create credentials without putting the cleartext password in shell history:

```sh
htpasswd -bnBC 12 '' 'choose-a-password' | cut -d: -f2
```

The application generates a cryptographically random session-signing secret in memory at startup. Sessions are invalidated whenever the server restarts. Login cookies are signed, HttpOnly, SameSite Strict, and use the Secure attribute for direct TLS or HTTPS asserted by a configured trusted proxy.

## Docker deployment

Set the required environment values in the deployment environment, then run:

```sh
docker compose up -d --build
```

The sample Compose file binds only to loopback. Put it behind an HTTPS reverse proxy and set `TRUSTED_PROXY` to that proxy's source CIDR. The application serves HTTP internally. Forwarded headers are ignored from untrusted peers. It has no persistent volumes and runs non-root with a read-only root filesystem and dropped capabilities.

## HiLink compatibility

The client uses the legacy HiLink session token, login, device information, SMS list, read-state, and delete XML endpoints. It expects numeric SMS indices and the common `SesTokInfo`/`__RequestVerificationToken` flow. Login, read-state updates, and repeated SMS retrieval were verified against an E8372 running Web UI `17.100.19.00.1217` on 2026-11-16, retrieving nine messages. HiLink exposes marking a message read through `api/sms/set-read`, but does not expose an inverse operation to restore unread state, so the UI follows the modem's reported `Smstat` value. Deletion and the E353/E3131 remain unverified; the modem's firmware is authoritative. Do not treat mocked or unit-level protocol checks as proof of hardware compatibility.

On this E8372 Web UI, the modem password field has a 15-character limit. Pasting a longer password silently truncates it before hashing, so a successful browser login does not prove that the full pasted value is the modem password. Set `HILINK_PASSWORD` to the actual value accepted by that field. The client deliberately uses the configured password unchanged because other firmware may allow longer values. Error `108006` means the modem rejected the credentials; repeated attempts can produce lockout error `108007`. Stop retries and check the browser field's limit before investigating RSA or token handling. After changing `.env.dev`, restart `pnpm dev` so the backend receives the new environment; Air's source reload does not reload that file.

SMS stays in the modem and in process memory only. Polling failures keep the last good snapshot. At startup, the current message set becomes the baseline and is not forwarded. Forwarding is best-effort and does not retry durably. SMS bodies and secrets are not logged.

## Security and limitations

Application authentication is separate from modem authentication. The service exposes no registration or send-SMS function. It uses a restrictive CSP, same-origin checks for state changes, request-size limits, login throttling, and no-store API responses. Slack requests have a bounded timeout and redirects disabled. A numeric six digit string can still be misidentified as an OTP. Network signal details are not yet exposed because modem support is not verified.

The frontend theme preference is stored locally in the browser. There is no database, durable notification queue, settings interface, or persistent SMS cache.
