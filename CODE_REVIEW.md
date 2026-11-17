# HiLink SMS Manager code review

Review date: 2026-11-17

Scope: backend, Huawei HiLink client, frontend, tests, development scripts,
container build, and CI configuration.

The review was static. The environment refused to execute the repository's
Node, pnpm, and Go binaries (`operation not permitted`), so the automated test,
lint, typecheck, and build results remain unverified.

Implementation status: all findings listed below have been addressed in the
working tree; the checks above still need to be run in an environment that can
execute the toolchain.

## Executive summary

The application has a coherent small architecture and good baseline security
controls: signed HttpOnly sessions, origin checks for state-changing requests,
bounded request bodies, strict response headers, and no persistent message
database. The most important correctness issues are at the modem boundary and
in notification deduplication. There are also resource-exhaustion risks in
authentication and Slack forwarding, plus a development bootstrap issue that
can leave the embedded frontend without its assets.

## Findings

### High priority

#### CR-01: Delete/read can address the wrong modem message

Location: [`backend/internal/hilink/client.go`](backend/internal/hilink/client.go#L284), [`backend/internal/hilink/client.go`](backend/internal/hilink/client.go#L355), [`backend/internal/app/http.go`](backend/internal/app/http.go#L354)

`List` prefers the modem's `<ID>` and only falls back to `<Index>`, but
`Delete` and `MarkRead` interpret their argument as `<Index>`. If a firmware
returns an ID different from the index, the UI can fail to delete/mark a
message or operate on a different message. The current tests omit `<ID>`, so
they do not exercise this contract.

Recommended fix: keep the stable UI identity and modem index as separate
fields throughout the store/API, and pass `Message.Index` to modem mutation
methods. Validate that indexes are positive. Add a test where `<ID>` and
`<Index>` differ.

#### CR-02: Unsupported modem dates can repeatedly forward the same SMS

Location: [`backend/internal/hilink/client.go`](backend/internal/hilink/client.go#L328), [`backend/internal/hilink/client.go`](backend/internal/hilink/client.go#L347), [`backend/internal/sms/sms.go`](backend/internal/sms/sms.go#L39), [`backend/internal/app/service.go`](backend/internal/app/service.go#L137)

When a date is not one of three accepted layouts, the client substitutes
`time.Now()`. The service's identity includes the timestamp, so the same SMS
gets a new identity on every poll and can be forwarded to Slack repeatedly.
The displayed time is also misleading. RFC3339, fractional seconds, and
timezone variants are currently not accepted.

Recommended fix: parse all formats emitted by supported firmware, preserve a
stable fallback, and base deduplication primarily on the modem index/ID rather
than a mutable parsed timestamp. Add a malformed/RFC3339 date regression test.

#### CR-03: Login rate limiting is an unbounded memory sink and proxy-hostile

Location: [`backend/internal/app/http.go`](backend/internal/app/http.go#L445), [`backend/internal/app/http.go`](backend/internal/app/http.go#L459)

Every blocked request is appended to the per-IP slice, so a client can create
unbounded timestamps during the five-minute window. IP entries are also never
removed unless a successful login happens. In addition, `clientIP` ignores
trusted proxy forwarding headers; all users behind one reverse proxy share one
rate-limit bucket and logs record the proxy rather than the client.

Recommended fix: use a bounded token bucket or fixed-window counter with
expiry and a maximum number of tracked principals. When `TRUSTED_PROXY` is
configured, parse the forwarded client address only from the trusted hop and
keep the current fallback for untrusted peers. Add proxy and cleanup tests.

### Medium priority

#### CR-04: Device information is permanently skipped after an initial outage

Location: [`backend/internal/app/service.go`](backend/internal/app/service.go#L120)

Device information is loaded only when `poll` is called with `initial=true`.
If the modem is unavailable at process start, the first later successful poll
loads messages but never loads the phone number or device metadata. The test
name explicitly preserves this behavior, so the gap is not accidental test
coverage.

Recommended fix: track `deviceInfoLoaded` independently and retry once after
the first successful list, or load device information whenever the cached
device record is empty.

#### CR-05: SMS pagination silently truncates large inboxes

Location: [`backend/internal/hilink/client.go`](backend/internal/hilink/client.go#L300)

The client stops after 100 pages (2,000 messages) and returns success without
reporting that more data may exist. It also ignores `PageCount`, making the
boundary behavior dependent on an extra empty-page request.

Recommended fix: use `PageCount`/total count when available, continue until
the modem reports completion, and return an explicit error if a defensible
server-side safety limit is reached. Add an exact-boundary and over-boundary
pagination test.

#### CR-06: A clean development checkout can embed missing frontend assets

Location: [`scripts/dev.sh`](scripts/dev.sh#L15), [`.gitignore`](.gitignore#L3)

The dev script checks only for `backend/web/dist/index.html`. The generated
asset files are ignored, while the unignored HTML can still reference hashed JS
and CSS files that are absent in a clean checkout. In that state, the Go
backend embeds an HTML shell whose assets return 404s and the script skips the
frontend build.

Recommended fix: check for the asset files referenced by `index.html`, or
always run `pnpm build:frontend` before starting the backend in development.
Prefer one documented generated-artifact policy and test it from a clean
checkout.

#### CR-07: Slack forwarding has no backpressure and does not reuse connections

Location: [`backend/internal/app/service.go`](backend/internal/app/service.go#L153), [`backend/internal/app/service.go`](backend/internal/app/service.go#L57)

Each newly detected message starts an independent goroutine. A large inbox
change or repeated modem event can create an unbounded number of concurrent
webhook requests. Error responses are closed without draining their bodies,
which reduces HTTP connection reuse. There is also no shutdown wait for
already-started deliveries.

Recommended fix: use a bounded worker queue with a clear overflow policy,
drain response bodies before closing, and wait for workers during shutdown.
Keep the current best-effort behavior explicit in the queue policy.

#### CR-08: `Store.Replace` mutates its caller's slice

Location: [`backend/internal/sms/sms.go`](backend/internal/sms/sms.go#L57)

The method sorts the supplied slice before copying it. That is surprising for
a store snapshot API and can cause data races or unexpected ordering changes
when a caller retains the slice.

Recommended fix: copy first, sort the copy, then publish it under the lock.

### Lower priority quality and maintainability issues

- [`backend/internal/app/http.go`](backend/internal/app/http.go#L76) falls back
  to the SPA index for unknown `/api` paths instead of returning JSON 404s.
  This makes API mistakes harder to diagnose and can confuse monitoring.
- [`backend/internal/app/service.go`](backend/internal/app/service.go#L111)
  classifies modem authentication failures by matching error text. A typed
  error or sentinel would be less brittle.
- [`backend/internal/app/slack.go`](backend/internal/app/slack.go#L29)
  contains the unused `slackPayload` wrapper; remove it or use it in tests.
  The frontend calls `detectOTP` three times while rendering one detail view
  ([`frontend/src/ui.tsx`](frontend/src/ui.tsx#L660)), which is small today but
  needlessly repeats regex work.
- [`backend/internal/hilink/client.go`](backend/internal/hilink/client.go#L152)
  hardcodes a 245-byte RSA chunk, which only matches a 2048-bit key. Derive
  the PKCS#1 v1.5 maximum from the received key size so other HiLink firmware
  does not fail at login.
- [`Dockerfile`](Dockerfile#L17) hardcodes `GOARCH=amd64`; document the
  supported platform or publish a multi-architecture image if ARM hosts are
  in scope.

## Recommended implementation order

1. Fix CR-01 and CR-02, because they can delete/read the wrong SMS or create
   duplicate external notifications.
2. Bound and proxy-correct the authentication limiter (CR-03).
3. Fix post-outage metadata loading and pagination (CR-04 and CR-05).
4. Repair clean-checkout asset bootstrapping and add bounded Slack delivery
   (CR-06 and CR-07).
5. Apply the store/API cleanup and lower-priority maintainability changes.

## Missing regression coverage

Add focused tests for modem ID/index separation, date variants and stable
notification identity, 100+ page inboxes, initial modem outage recovery,
trusted-proxy rate limiting, limiter eviction, unknown API routes, and a clean
development asset bootstrap. The existing unit and browser tests cover the
happy path but do not cover these failure boundaries.
