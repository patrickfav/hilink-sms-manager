# Huawei HiLink SMS Manager
## Implementation Specification

**Status:** Ready for implementation  
**Target:** Self-hosted, single-container application  
**Primary use case:** Receiving SMS verification codes and optionally forwarding them to Slack

---

## 1. Project objective

Build a lightweight, secure, self-hosted SMS management application that communicates with a Huawei HiLink LTE USB modem.

The application provides a modern web interface for reading and deleting SMS messages, detecting verification codes, and optionally forwarding newly received messages to Slack.

The application is primarily intended for private hosting, but must follow production-grade security practices.

### Engineering priorities

1. **Simplicity:** Minimal architecture, dependencies, configuration, and operational overhead.
2. **Security:** Modern, secure defaults throughout the application.
3. **Maintainability:** Readable, idiomatic code with minimal abstractions.
4. **Developer experience:** Fast feedback, hot reload, automated testing, and simple commands.
5. **Aesthetics:** Beautiful, minimalist, modern interface.
6. **Resource efficiency:** Low idle memory usage and small container image.

### Global engineering principle

Prefer standard libraries, built-in framework functionality, established conventions, and sensible defaults.

This principle applies to **everything**: backend, frontend, styling, security, testing, tooling, and deployment.

Before introducing a dependency or abstraction, determine whether the existing stack already provides an adequate solution.

Do not sacrifice security or correctness merely to avoid a dependency. Never implement custom cryptographic primitives.

Avoid overengineering and speculative extensibility.

---

## 2. Technology stack

| Component | Technology |
|---|---|
| Backend | Go, current stable release |
| HTTP routing | Go `net/http` |
| XML handling | Go `encoding/xml` |
| Frontend | Preact + TypeScript |
| Frontend build | Vite |
| Package manager | pnpm |
| Styling | Tailwind CSS v4 |
| Icons | Lucide |
| Go hot reload | Air |
| Backend tests | Go `testing` |
| Frontend tests | Vitest |
| E2E tests | Playwright |
| Deployment | Docker / OCI |
| Target architecture | Linux AMD64 |
| Runtime image | Distroless static, non-root |
| Configuration | Environment variables only |
| Persistence | None |

Avoid additional frameworks unless there is a compelling justification.

### Development commands

The root project must support:

```bash
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm test:e2e
pnpm lint
pnpm typecheck
```

`pnpm dev` must start both the frontend and backend.

- Vite provides frontend HMR.
- Air watches Go source files, recompiles, and restarts the backend.
- Vite proxies API requests to the Go backend.
- No manual restarts during ordinary development.

Use pnpm as the development task orchestrator without unnecessarily coupling Go dependency management to Node.js.

---

## 3. Architecture

### Single Go application

The backend handles:

- Huawei HiLink API communication
- Modem authentication and session management
- SMS polling
- In-memory SMS snapshots
- Slack forwarding
- Application authentication
- JSON API
- Embedded frontend assets
- Health and status endpoints

### Frontend

The Preact application communicates exclusively with the Go backend.

The browser must never directly access the modem or Slack webhook.

### No database

Do not introduce:

- PostgreSQL, SQLite, or another database
- Redis
- Message brokers
- Persistent SMS caches
- Durable forwarding queues
- External session storage
- Configuration files
- A separate production frontend server

The modem is the source of truth for SMS messages.

The application maintains only temporary runtime state.

### Suggested repository structure

```text
hilink-sms/
├── backend/
│   ├── cmd/
│   │   └── server/
│   ├── internal/
│   │   ├── hilink/
│   │   ├── sms/
│   │   ├── auth/
│   │   ├── forwarding/
│   │   └── httpapi/
│   ├── web/
│   │   └── dist/
│   ├── go.mod
│   └── go.sum
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   └── lib/
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
├── tests/
│   ├── e2e/
│   └── mock-hilink/
├── Dockerfile
├── compose.yaml
├── package.json
├── pnpm-lock.yaml
└── README.md
```

This structure is illustrative. Keep it simpler if appropriate.

---

## 4. Huawei HiLink integration

### Known hardware information

- Huawei HiLink LTE USB modem
- USB ID: `12d1:14db`
- Identified as E353/E3131 family
- Exact model and firmware not conclusively established
- Default address: `http://192.168.8.1`
- Web UI requires administrator login
- SMS reception has been verified

### API

HiLink uses a proprietary HTTP/XML API.

Potential endpoints include:

```text
/api/webserver/SesTokInfo
/api/user/state-login
/api/user/login
/api/sms/sms-list
/api/sms/delete-sms
/api/monitoring/status
```

Endpoint support and request methods vary by firmware.

### Reference implementation

Primary reference:

https://github.com/Salamek/huawei-lte-api

Use the implementation to understand:

- Session establishment
- Authentication
- Request-verification tokens
- XML payloads
- SMS retrieval
- Pagination
- SMS deletion
- Error responses

### Implementation requirements

Use Go's standard HTTP and XML libraries.

Implement:

- Cookie handling
- Verification-token handling
- Modem login
- Session renewal
- Authentication failure handling
- SMS retrieval and pagination
- SMS deletion
- Unicode and multipart SMS handling
- Request timeouts
- Graceful recovery after temporary failures

Never expose modem credentials or tokens to the browser.

### Compatibility verification

**The actual modem firmware is the authoritative source.**

Begin by investigating its API behavior.

If physical modem access is unavailable, use existing implementations as references and document unverified assumptions.

Do not claim real-device compatibility based solely on mocked tests.

---

## 5. Application features

### 5.1 Authentication

Provide a simple login screen.

Requirements:

- One configured user
- Username and password
- Password hash supplied through environment configuration
- Secure session cookie
- Session expiration
- Logout
- Login rate limiting
- No registration
- No password reset workflow
- No user-management interface

Keep application authentication separate from modem authentication.

### 5.2 SMS inbox

Display received messages with:

- Sender
- Timestamp
- Message preview
- Read/unread status, if supported
- New-message indication

Sort newest first.

Provide appropriate loading, empty, and error states.

### 5.3 Message detail

Display:

- Full message text
- Sender
- Timestamp
- Available metadata
- Copy-message action
- Delete action

Support marking messages as read where the modem provides this functionality.

### 5.4 OTP detection

Automatically detect likely verification codes.

Examples:

```text
Your verification code is 482913.
```

```text
Use 123456 to sign in.
```

Display the extracted code prominently with a one-click copy action.

Requirements:

- Support common numeric OTP formats
- Avoid false positives where practical
- Preserve the original message
- Never depend on an external service

### 5.5 SMS deletion

Deleting an SMS must delete it from the modem.

- Require confirmation
- Provide clear success/error feedback
- Update the in-memory snapshot
- Keep the UI consistent with the modem
- Handle deletion failures safely

### 5.6 Polling

The backend owns a single SMS polling loop.

Default interval: **15 seconds**.

Requirements:

- Prevent overlapping polls
- Fetch the required message pages
- Preserve the last successful snapshot on failures
- Recover after temporary modem disconnections
- Support graceful shutdown
- Avoid unbounded memory growth

The frontend separately polls the backend's cached SMS API.

Frontend polling:

- Active while the page is visible
- Paused while hidden
- Immediate refresh on becoming visible
- No overlapping requests

Do not introduce WebSockets or server-sent events initially.

### 5.7 Modem status

Display a small status indicator containing:

- Connected/disconnected state
- Last successful synchronization
- Relevant error status
- Optional network/signal information, if supported

### Excluded from MVP

- Sending SMS
- SMS composition
- Sent-message management
- Multiple users
- Multiple modems
- Advanced filtering
- Database-backed history
- Durable notification queues

---

## 6. Slack forwarding

Implement optional forwarding of newly received SMS messages through a Slack incoming webhook.

### Delivery semantics

**Best-effort, near-real-time delivery.**

No durable delivery guarantees are required.

### Behavior

1. Start the backend polling loop.
2. Retrieve the initial SMS snapshot.
3. Treat existing messages as already seen.
4. Forward nothing during initialization.
5. Detect newly appearing SMS identities on subsequent successful polls.
6. Forward new messages when Slack forwarding is enabled.
7. Maintain only in-memory tracking.

### Requirements

- Forward all newly received messages.
- Do not forward historical messages at startup.
- Do not catch up after application restarts.
- Do not maintain a persistent queue.
- Do not repeatedly forward unchanged messages.
- Use bounded HTTP timeouts.
- Avoid blocking the polling loop on Slack requests.
- Prevent uncontrolled retries.
- Handle Slack failures gracefully.

### Important edge cases

A failed modem poll must not reset the SMS snapshot.

A partial or paginated result must not accidentally cause historical messages to appear new.

Changes to read/unread status must not trigger forwarding.

If Slack forwarding is enabled while the application is already running, the current SMS snapshot remains the baseline.

A successful HTTP response from Slack followed by a process crash may result in an occasional duplicate. Exactly-once delivery is not required.

### Slack message format

Keep notifications simple:

- Sender
- Received timestamp
- Complete SMS text

Avoid unnecessary formatting or external dependencies.

Do not log SMS contents or webhook secrets.

### Configuration

Slack forwarding is configured exclusively through environment variables.

No configuration UI.

---

## 7. Configuration

**All configuration must be supplied through environment variables.**

No configuration files, database, or runtime settings editor.

### Proposed environment variables

| Variable | Purpose |
|---|---|
| `HILINK_URL` | Modem base URL |
| `HILINK_USERNAME` | Modem administrator username |
| `HILINK_PASSWORD` | Modem administrator password |
| `AUTH_USERNAME` | Web application username |
| `AUTH_PASSWORD_HASH` | Web application password hash |
| `POLL_INTERVAL` | Backend polling interval |
| `SLACK_ENABLED` | Enable/disable Slack forwarding |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook |
| `LISTEN_ADDR` | HTTP listener address |
| `TRUSTED_PROXY` | Optional trusted reverse-proxy configuration |

Use secure defaults where possible.

### Configuration rules

- Validate configuration at startup.
- Fail fast on missing or invalid required values.
- Never print secret values.
- Require a webhook only when Slack is enabled.
- Treat configuration as immutable at runtime.
- Configuration changes require recreating the container.
- Do not provide settings modification endpoints.
- Do not silently fall back to insecure credentials.

Environment variables are the configuration interface. Docker Compose may use environment substitution or external secret injection, but the application itself must not read configuration files.

---

## 8. Frontend design and aesthetics

### Design direction

Create a beautiful, minimalist, modern interface inspired by **shadcn/ui**.

The aesthetic is important and should receive deliberate attention.

Visual characteristics:

- Clean typography
- Generous spacing
- Subtle borders
- Muted, restrained colors
- Consistent border radii
- Minimal visual clutter
- Refined hover and focus states
- Polished dialogs and forms
- Consistent icons
- Thoughtful loading and empty states

Avoid the appearance of a traditional router administration interface.

### Styling

Use Tailwind CSS v4.

Prefer lightweight, reusable Preact components.

Do not introduce a large React component framework merely to reproduce the shadcn aesthetic.

Use Lucide icons.

### Themes

Support:

- Light mode
- Dark mode
- Automatic system-theme detection

Default to the operating system's preference.

A user-selected theme may be stored locally in the browser.

This is presentation preference state, not server-side application configuration.

### Responsive design

**Mobile and desktop are equally important.**

Mobile requirements:

- Single-column inbox
- Comfortable touch targets
- Readable typography
- Easy navigation
- Accessible copy/delete actions
- No horizontal overflow
- Appropriate handling of narrow screens

Desktop requirements:

- Efficient use of available space
- Optional master-detail layout
- Keyboard navigation
- Clear visual hierarchy

### Accessibility

- Semantic HTML
- Accessible labels
- Visible focus indicators
- Keyboard-operable controls
- Appropriate contrast
- Accessible dialogs
- Respect reduced-motion preferences

---

## 9. Backend API

Expose a small, authenticated JSON API.

Suggested endpoints:

```text
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/session

GET    /api/sms
GET    /api/sms/{id}
DELETE /api/sms/{id}

GET    /api/status

GET    /healthz
```

An additional read-status endpoint may be introduced if required.

### API principles

- JSON request and response bodies
- Consistent error format
- Strict HTTP method handling
- Appropriate status codes
- Request-size limits
- Context cancellation
- Timeouts
- No unnecessary generic CRUD abstractions

Use Go's standard `net/http` router.

### Polling architecture

The backend serves the latest successfully retrieved snapshot rather than querying the modem independently for every browser request.

This prevents unnecessary modem traffic and avoids competing requests.

Clearly communicate when cached data may be stale.

### Health endpoint

`/healthz` should report whether the application process is healthy.

A temporarily unavailable modem must not automatically make the process unhealthy.

Modem connectivity belongs in `/api/status`.

---

## 10. Security

**Security is a mandatory acceptance criterion.**

The application handles sensitive verification messages and must use modern defensive defaults.

### 10.1 Authentication

- Secure password hashing
- Prefer established, minimal dependencies
- Bcrypt is acceptable
- Constant-time comparison where applicable
- Login rate limiting
- Generic authentication failure messages
- Session expiration
- Logout and invalidation
- No default credentials

Do not build custom password-hashing algorithms.

### 10.2 Session security

Use secure, authenticated session cookies.

Requirements:

- `HttpOnly`
- `Secure` in HTTPS deployments
- `SameSite=Strict`
- Appropriate expiration
- Cryptographically secure session identifiers or authenticated cookie contents
- No sensitive modem or Slack credentials in cookies

Prefer an approach that does not require persistent server-side session storage.

### 10.3 HTTP security headers

Implement a restrictive Content Security Policy.

Production should avoid:

- `unsafe-inline` scripts
- `unsafe-eval`
- Unnecessary third-party origins

Prefer a policy conceptually equivalent to:

```text
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data:;
connect-src 'self';
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
form-action 'self';
```

Adjust only where technically justified.

Also configure:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Strict-Transport-Security` on HTTPS responses
- Appropriate `Permissions-Policy`
- Protection against framing
- `Cache-Control: no-store` for sensitive responses

HSTS must be applied correctly when TLS terminates at a trusted reverse proxy.

Do not blindly trust forwarded headers from arbitrary clients.

### 10.4 API protection

- Require authentication for every SMS endpoint
- Protect state-changing operations against CSRF
- Validate input
- Limit request sizes
- Enforce HTTP methods
- Avoid unnecessary CORS support
- Prevent information leakage through errors
- Reject unexpected content types where appropriate

Use Go's built-in cross-origin protections where suitable.

### 10.5 Sensitive information

Never log:

- SMS contents
- OTP codes
- Passwords
- Session cookies
- Huawei authentication tokens
- Slack webhook URLs

Use structured logging with Go's standard `log/slog`.

### 10.6 Upstream communication

The modem URL must be configured at startup.

Never accept arbitrary upstream URLs from browser requests.

Restrict redirects and avoid forwarding authentication material to unexpected destinations.

Use HTTPS for Slack requests and enforce reasonable timeouts.

### 10.7 Frontend security

- Avoid unsafe HTML injection
- Do not use `dangerouslySetInnerHTML` with untrusted content
- Do not load unnecessary external scripts
- Avoid third-party analytics
- Never store application credentials in local storage
- Do not expose secrets in frontend bundles

### 10.8 Security validation

Include tests for:

- Unauthenticated API access
- Invalid credentials
- Login rate limiting
- Session expiration
- Logout
- CSRF attempts
- Malicious inputs
- Security headers
- Sensitive-data leakage

Use appropriate dependency vulnerability checks, including `govulncheck` and frontend dependency auditing.

Do not weaken security controls merely to make tests pass.

---

## 11. Production build and deployment

### Single executable

Use Go's `embed` package to bundle the Vite-generated frontend directly into the Go binary.

Build sequence:

1. Install frontend dependencies using pnpm.
2. Compile the Preact frontend with Vite.
3. Place generated assets inside the Go embedding directory.
4. Compile the Go application with the embedded assets.
5. Copy the executable into the distroless runtime image.

Use `CGO_ENABLED=0` where compatible with the implementation.

### Container

Target:

```text
linux/amd64
```

Use a multi-stage Dockerfile.

Recommended runtime:

```text
gcr.io/distroless/static-debian13:nonroot
```

Pin base images to appropriate stable versions or digests for reproducibility.

### Runtime requirements

- One container
- One Go executable
- No Node.js runtime
- No Nginx
- No database
- No persistent volumes
- Non-root execution
- Read-only filesystem
- No unnecessary Linux capabilities
- `no-new-privileges`
- Graceful SIGTERM handling

Ensure required TLS CA certificates are available.

### Docker Compose

Provide a working Compose example.

Use environment variables for all configuration.

Include appropriate restart policy and security restrictions.

Do not require privileged mode or direct USB passthrough when the modem's HTTP interface is already reachable over the network.

### Reverse proxy

The application should work behind an existing HTTPS reverse proxy such as Traefik.

Requirements:

- Correct HTTPS cookie behavior
- Correct HSTS behavior
- Explicit trusted-proxy handling
- No unnecessary public exposure
- No dependency on Traefik-specific APIs

The application itself serves HTTP internally.

Document the expected TLS termination model.

---

## 12. Automated testing

Testing must be implemented alongside functionality.

### 12.1 Backend unit tests

Use Go's built-in testing tools.

Cover:

- XML parsing
- HiLink request generation
- Authentication and token handling
- Session renewal
- SMS pagination
- Unicode messages
- Multipart messages
- Snapshot comparison
- New-message detection
- Slack forwarding
- Forwarding failures
- Configuration validation
- Authentication and authorization

Use Go's race detector where appropriate.

### 12.2 Frontend unit tests

Use Vitest and Preact Testing Library.

Cover:

- Login form
- Inbox rendering
- Empty states
- Loading states
- Message detail
- OTP extraction
- Copy functionality
- Delete confirmation
- Error handling
- Theme switching
- Relevant accessibility behavior

### 12.3 HiLink mock server

Implement a lightweight Go mock server reproducing the relevant Huawei XML API.

It should simulate:

- Session initialization
- Authentication
- Verification tokens
- SMS listing
- SMS deletion
- Pagination
- New-message arrival
- Expired sessions
- Modem errors
- Temporary disconnections

Provide deterministic ways for tests to inject messages and control mock behavior.

The mock must reflect documented HiLink behavior rather than inventing a simplified protocol.

### 12.4 Slack mock

Provide a lightweight HTTP endpoint for capturing outgoing webhook requests.

Tests must verify:

- Existing messages are not forwarded at startup
- Newly received messages are forwarded
- Repeated polls do not cause duplicate forwarding
- Slack failures do not crash the application
- Disabled forwarding sends no requests

### 12.5 Playwright E2E tests

Run the actual application against the mock HiLink server.

At minimum, implement this scenario:

1. Start the application.
2. Open the login page.
3. Authenticate.
4. Verify the empty inbox.
5. Inject an SMS into the mock modem.
6. Wait for polling to discover the message.
7. Verify that it appears in the inbox.
8. Open the message.
9. Verify the complete text.
10. Verify OTP detection.
11. Copy the OTP and verify clipboard contents.
12. Delete the message.
13. Verify it disappears.
14. Verify the mock modem received the deletion request.
15. Verify Slack forwarding occurred exactly once.

Also test:

- Authentication failures
- Session expiration
- Modem unavailability
- Light and dark themes
- Mobile viewport
- Desktop viewport

### Test infrastructure

Prefer Playwright's built-in web server orchestration and lightweight mock processes.

**Do not introduce Testcontainers initially.**

Tests must run without:

- A physical Huawei modem
- A real Slack workspace
- A database
- External network dependencies

Make the polling interval configurable to keep tests fast.

---

## 13. Observability and error handling

Keep observability simple.

Use Go's standard structured logger.

### Logging

Log:

- Application startup
- Configuration validation failures
- Modem connection state changes
- Authentication failures
- Polling failures
- Slack delivery failures
- Graceful shutdown

Never log sensitive contents.

Avoid excessive repeated logs during prolonged modem outages.

### Error handling

The application must handle:

- Modem unavailable
- Modem authentication expired
- Malformed XML
- HTTP timeouts
- Unexpected modem responses
- Slack failures
- SMS deletion failures
- Browser network interruptions

Failures must not crash the application unnecessarily.

The UI should provide clear, concise, nontechnical error messages.

---

## 14. Documentation

Provide a concise but complete README.

Include:

- Project overview
- Architecture
- Development prerequisites
- `pnpm dev` instructions
- Build instructions
- Testing instructions
- Environment-variable reference
- Docker deployment
- Reverse-proxy considerations
- Huawei modem compatibility notes
- Security considerations
- Slack forwarding semantics
- Known limitations

Include a working Docker Compose example.

Document how to generate a suitable application password hash and session secret.

Do not include real credentials or webhook URLs.

---

## 15. Implementation milestones

### Milestone 1 — Project foundation

- Initialize Go backend
- Initialize Preact frontend
- Configure Vite
- Configure pnpm scripts
- Configure Air
- Establish development proxy
- Implement embedded static assets
- Create initial Dockerfile

**Acceptance:** `pnpm dev` provides working frontend and backend hot reload; the production build produces one executable serving both.

### Milestone 2 — HiLink integration

- Investigate API behavior
- Implement XML client
- Implement authentication
- Implement SMS listing
- Implement SMS deletion
- Add mock server
- Add protocol unit tests

**Acceptance:** SMS retrieval and deletion work against the mock, with firmware-specific assumptions documented.

### Milestone 3 — Authentication and API

- Implement application login
- Implement secure sessions
- Protect API endpoints
- Implement SMS JSON API
- Implement health/status endpoints

**Acceptance:** Unauthenticated users cannot access SMS data, and authentication security tests pass.

### Milestone 4 — Frontend

- Implement responsive layout
- Implement light/dark themes
- Implement login screen
- Implement inbox
- Implement message detail
- Implement OTP extraction
- Implement deletion
- Implement status indicators

**Acceptance:** Core workflows function on mobile and desktop.

### Milestone 5 — Polling and Slack

- Implement backend polling loop
- Implement in-memory snapshot comparison
- Implement Slack webhook integration
- Implement forwarding configuration
- Handle failures and reconnects

**Acceptance:** Newly arriving SMS messages are detected and forwarded once during ordinary operation; existing startup messages are not forwarded.

### Milestone 6 — Testing and hardening

- Complete Go unit tests
- Complete frontend unit tests
- Complete Playwright E2E suite
- Validate security headers
- Review authentication and CSRF protections
- Run dependency vulnerability checks
- Review container security

**Acceptance:** All automated tests pass and no known high-severity security issues remain unresolved without documented justification.

### Milestone 7 — Deployment and documentation

- Finalize multi-stage Docker build
- Validate distroless runtime
- Validate AMD64 image
- Validate read-only filesystem
- Finalize Docker Compose
- Complete README

**Acceptance:** The application starts from environment configuration alone and requires no persistent volumes or external services beyond the modem and optional Slack webhook.

---

## 16. Final acceptance criteria

The project is complete when all of the following are satisfied:

- [ ] Single Go backend with standard-library HTTP routing
- [ ] Preact + TypeScript frontend
- [ ] Vite HMR and Go hot reload
- [ ] One-command development workflow through pnpm
- [ ] Huawei HiLink client with authentication and SMS retrieval
- [ ] SMS inbox and detail view
- [ ] OTP detection and one-click copying
- [ ] SMS deletion on the modem
- [ ] Backend polling with in-memory snapshots
- [ ] Optional Slack forwarding
- [ ] No forwarding of historical messages at startup
- [ ] No database or durable queue
- [ ] Configuration exclusively through environment variables
- [ ] Secure application authentication
- [ ] Restrictive CSP and appropriate HTTP security headers
- [ ] CSRF protection and login rate limiting
- [ ] No sensitive information in logs
- [ ] Responsive mobile and desktop UI
- [ ] Light and dark themes
- [ ] Modern, shadcn-inspired visual design
- [ ] Accessible interactive controls
- [ ] Go unit tests
- [ ] Frontend unit tests
- [ ] Playwright E2E tests using a mock modem
- [ ] Security-focused automated tests
- [ ] Frontend embedded into the Go executable
- [ ] Single Linux AMD64 distroless container
- [ ] Non-root, read-only runtime
- [ ] No persistent volumes
- [ ] Working Docker Compose example
- [ ] Complete setup and deployment documentation

---

## 17. Instructions to the implementation agent

Implement this application incrementally, following the milestones above.

**Do not expand the scope without a concrete requirement.**

Prioritize simplicity, security, correctness, and maintainability over architectural sophistication.

Use idiomatic Go and TypeScript.

Prefer established defaults and standard-library functionality.

Avoid introducing dependencies when the existing stack already provides an adequate solution.

Write tests alongside the implementation.

Use the Huawei LTE API reference implementation to guide protocol development, but document any assumptions that cannot be validated without physical hardware.

Do not claim real-modem compatibility until it has been tested against the target device.

Do not introduce persistent state, additional services, or complex infrastructure.

Treat visual quality as an explicit requirement, not an afterthought.

At the end of each milestone, run the relevant tests and verify its acceptance criteria before proceeding.

**The final deliverable must be a secure, polished, lightweight SMS manager that runs as a single immutable container and can be developed, tested, and deployed with minimal effort.**
