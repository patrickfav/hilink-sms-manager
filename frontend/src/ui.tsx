import type { ComponentChildren } from 'preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import {
  Check,
  ChevronLeft,
  Copy,
  Inbox,
  LogOut,
  MessageSquare,
  Moon,
  Phone,
  Radio,
  RefreshCw,
  Search,
  Sun,
  Trash2,
  X,
} from 'lucide-preact'
import { api, type SMS, type Status } from './api'

export function detectOTP(text: string) {
  const patterns = [
    /(?:code|otp|verification|verify|security|login|sicherheitscode|verifizierungscode|verification\s+code)\D{0,24}((?:\d[\s-]?){3,7}\d)/i,
    /(?:code|otp|verification|verify|security|login|sicherheitscode|verifizierungscode|verification\s+code)\D{0,24}(\d{4,8})/i,
    /\b(\d{6})\b/,
  ]
  for (const pattern of patterns) {
    const hit = text.match(pattern)
    if (hit) return hit[1].replace(/\D/g, '')
  }
  return null
}
function timeLabel(raw: string) {
  const date = new Date(raw)
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(date)
}
function avatarLetter(name: string) {
  return name.trim().slice(0, 1).toUpperCase()
}
function linkifyText(text: string): ComponentChildren {
  const tokenPattern =
    /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+\d[\d\s().-]{6,}\d))/gi
  const parts: ComponentChildren[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(text))) {
    const rawToken = match[0]
    const trailing = rawToken.match(/[.,!?;:)\]}]+$/)?.[0] || ''
    const visibleToken = trailing ? rawToken.slice(0, -trailing.length) : rawToken
    const isWebUrl = /^(?:https?:\/\/|www\.)/i.test(visibleToken)
    const isEmail = visibleToken.includes('@')
    const href = isWebUrl
      ? `https://transparencyreport.google.com/safe-browsing/search?url=${encodeURIComponent(visibleToken.startsWith('www.') ? `https://${visibleToken}` : visibleToken)}`
      : isEmail
        ? `mailto:${visibleToken}`
        : `tel:${visibleToken.replace(/[^\d+]/g, '')}`
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    parts.push(
      <a
        class="message-link"
        href={href}
        key={`link-${match.index}`}
        title={isWebUrl ? 'Check with Google Safe Browsing' : undefined}
        {...(isWebUrl ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {visibleToken}
      </a>,
    )
    if (trailing) parts.push(trailing)
    cursor = match.index + rawToken.length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}
function ThemeToggle() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'system')
  useEffect(() => {
    const root = document.documentElement
    const preference = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      root.dataset.theme = theme
      root.classList.toggle('dark', theme === 'dark' || (theme === 'system' && preference.matches))
    }
    apply()
    preference.addEventListener('change', apply)
    localStorage.setItem('theme', theme)
    return () => preference.removeEventListener('change', apply)
  }, [theme])
  const isDark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  return (
    <button
      type="button"
      class="icon-button"
      aria-label={`Theme: ${theme}`}
      title={`Theme: ${theme}`}
      onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}
    >
      {isDark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}
function Login() {
  const [username, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: Event) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.login(username, password)
      // Start a fresh document so password managers stop tracking the login form
      // while the user interacts with the authenticated inbox.
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main class="login-wrap">
      <section class="login-card">
        <div class="brand-mark">
          <MessageSquare size={21} />
        </div>
        <p class="eyebrow">PRIVATE INBOX</p>
        <h1>Welcome back</h1>
        <p class="muted">Sign in to view messages from your HiLink modem.</p>
        <form onSubmit={submit}>
          <label>
            Username
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              value={username}
              onInput={(e) => setUser((e.target as HTMLInputElement).value)}
              required
            />
          </label>
          <label>
            Password
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              required
            />
          </label>
          {error && (
            <div class="alert" role="alert">
              {error}
            </div>
          )}
          <button type="submit" class="primary full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
            <ChevronLeft class="arrow" size={16} />
          </button>
        </form>
      </section>
    </main>
  )
}
export function App() {
  const [authenticated, setAuth] = useState<boolean | null>(null)
  const [items, setItems] = useState<SMS[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [signOutConfirm, setSignOutConfirm] = useState(false)
  const [deviceInfoOpen, setDeviceInfoOpen] = useState(false)
  const [rebootConfirm, setRebootConfirm] = useState(false)
  const [rebooting, setRebooting] = useState(false)
  const [page, setPage] = useState(0)
  const [refreshCount, setRefreshCount] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshCycle, setRefreshCycle] = useState(0)
  const pageSize = 15
  const refreshInterval = 10000
  const unreadCount = items.filter((message) => !message.read).length
  const current = items.find((m) => m.id === selected) || null
  const filtered = useMemo(
    () => items.filter((m) => `${m.sender} ${m.text}`.toLowerCase().includes(query.toLowerCase())),
    [items, query],
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const visibleMessages = filtered.slice(page * pageSize, (page + 1) * pageSize)
  const deviceLabel =
    [status?.deviceName, status?.hardwareVersion].filter(Boolean).join(' · ') || 'HiLink device'
  useEffect(() => {
    document.title = unreadCount > 0 ? `HiLink SMS (${unreadCount})` : 'HiLink SMS'
  }, [unreadCount])
  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, pageCount - 1))
  }, [pageCount])
  useEffect(() => {
    setPage(0)
  }, [query])
  useEffect(() => {
    api
      .session()
      .then((s) => setAuth(s.authenticated))
      .catch(() => setAuth(false))
  }, [])
  useEffect(() => {
    if (!authenticated) return
    let active = false
    let timer: number | undefined
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || active) return
      active = true
      setRefreshing(true)
      try {
        const data = await api.inbox()
        setItems(data.messages)
        setStatus(data.status)
        setError('')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unable to load messages')
      } finally {
        active = false
        setRefreshing(false)
        setRefreshCycle((cycle) => cycle + 1)
      }
    }
    const stopPolling = () => {
      if (timer !== undefined) {
        window.clearInterval(timer)
        timer = undefined
      }
    }
    const startPolling = () => {
      stopPolling()
      if (document.visibilityState !== 'visible') return
      void refresh()
      timer = window.setInterval(() => void refresh(), refreshInterval)
    }
    const visible = () => {
      if (document.visibilityState === 'visible') startPolling()
      else stopPolling()
    }
    document.addEventListener('visibilitychange', visible)
    startPolling()
    return () => {
      stopPolling()
      document.removeEventListener('visibilitychange', visible)
    }
  }, [authenticated, refreshCount])
  async function remove() {
    if (!current) return
    setLoading(true)
    try {
      await api.delete(current.id)
      setItems((prev) => prev.filter((m) => m.id !== current.id))
      setSelected(null)
      setConfirm(false)
      notice('Message deleted')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to delete message')
    } finally {
      setLoading(false)
    }
  }
  function notice(text: string) {
    setToast(text)
    setTimeout(() => setToast(''), 2200)
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      notice('Copied to clipboard')
    } catch {
      notice('Clipboard access unavailable')
    }
  }
  async function selectMessage(message: SMS) {
    setSelected(message.id)
    if (message.read) return
    try {
      await api.markRead(message.id)
      setItems((prev) =>
        prev.map((item) => (item.id === message.id ? { ...item, read: true } : item)),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to mark message as read')
    }
  }
  async function signOut() {
    setSignOutConfirm(false)
    await api.logout().catch(() => {})
    setAuth(false)
    setItems([])
    setSelected(null)
  }
  async function reboot() {
    setRebooting(true)
    try {
      await api.reboot()
      setRebootConfirm(false)
      setDeviceInfoOpen(false)
      setStatus((currentStatus) =>
        currentStatus
          ? { ...currentStatus, connected: false, error: 'Modem is rebooting.' }
          : currentStatus,
      )
      notice('Modem rebooting…')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to reboot modem')
    } finally {
      setRebooting(false)
    }
  }
  if (authenticated === null)
    return (
      <div class="splash">
        <span class="spinner" />
      </div>
    )
  if (!authenticated) return <Login />
  return (
    <div class="app-shell">
      <main class="workspace">
        <header class="topbar">
          <div class="brand">
            <span class="brand-mark small">
              <MessageSquare size={16} />
            </span>
            <span>
              HiLink<span class="brand-light"> / Inbox</span>
              {status?.phoneNumber && <span class="brand-phone"> · {status.phoneNumber}</span>}
            </span>
          </div>
          <div class="top-actions">
            {status?.connected ? (
              <button
                type="button"
                class="connection connection-button"
                aria-label="Show modem information"
                onClick={() => setDeviceInfoOpen(true)}
              >
                <span class="dot green" />
                <span>Modem connected</span>
              </button>
            ) : (
              <div class="connection">
                <span class={`dot ${status?.connected ? 'green' : 'gray'}`} />
                <span>Connecting to modem</span>
              </div>
            )}
            <span class="top-divider" />
            <ThemeToggle />
            <button
              type="button"
              class="icon-button"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => setSignOutConfirm(true)}
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <div class="page-heading">
          <div class="heading-copy">
            <p class="eyebrow">MESSAGES</p>
            <h1>
              Your inbox <span class="count">{items.length}</span>
              {unreadCount > 0 && (
                <span class="unread-count">
                  <span class="unread-mark" /> {unreadCount} unread
                </span>
              )}
            </h1>
            <div class="heading-subline">
              <p class="muted">Messages received on your modem appear here.</p>
              {status?.lastSync && !status.error && !error && !status.storageFull && (
                <span class="sync-inline">
                  <span class="dot green" /> Last synced {timeLabel(status.lastSync)}
                </span>
              )}
            </div>
          </div>
          <div class="refresh-control">
            <button
              type="button"
              class="secondary refresh"
              disabled={refreshing}
              onClick={() => {
                setRefreshCycle((cycle) => cycle + 1)
                setRefreshCount((n) => n + 1)
              }}
            >
              <RefreshCw class={refreshing ? 'refresh-spinning' : ''} size={16} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
              <div class="refresh-progress" aria-hidden="true">
                <span
                  class="refresh-progress-fill"
                  key={refreshCycle}
                  style={{ animationDuration: `${refreshInterval}ms` }}
                />
              </div>
            </button>
          </div>
        </div>
        {(error || status?.error || status?.storageFull || !status?.lastSync) && (
          <div
            class={`sync-note ${error || status?.error || status?.storageFull ? 'sync-error' : ''}`}
            role={error || status?.error || status?.storageFull ? 'alert' : undefined}
          >
            <span class={`dot ${status?.connected ? 'green' : 'amber'}`} />
            <span>
              {error ||
                status?.error ||
                (status?.storageFull
                  ? 'SMS storage is full; delete messages on the modem to receive new SMS.'
                  : 'Waiting for first sync')}
            </span>
          </div>
        )}
        <section class={`inbox-panel ${current ? 'has-detail' : ''}`}>
          <div class="list-pane">
            <div class="list-toolbar">
              <div class="search">
                <Search size={16} />
                <input
                  type="search"
                  name="message-search"
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-op-ignore="true"
                  aria-label="Search messages"
                  placeholder="Search messages…"
                  value={query}
                  onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                />
                {query && (
                  <button
                    type="button"
                    class="clear-search"
                    aria-label="Clear search"
                    onClick={() => setQuery('')}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <span class="list-total">
                {filtered.length} {filtered.length === 1 ? 'message' : 'messages'}
              </span>
            </div>
            <div class="message-list">
              {filtered.length === 0 ? (
                <div class="empty">
                  <div class="empty-icon">
                    <Inbox size={22} />
                  </div>
                  <h2>{items.length ? 'No results found' : 'Your inbox is clear'}</h2>
                  <p>
                    {items.length
                      ? 'Try another sender or keyword.'
                      : 'New text messages will show up here.'}
                  </p>
                </div>
              ) : (
                visibleMessages.map((m) => {
                  const code = detectOTP(m.text)
                  return (
                    <div
                      class={`message-row ${selected === m.id ? 'selected' : ''} ${m.read ? '' : 'unread'}`}
                      key={m.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => void selectMessage(m)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          void selectMessage(m)
                        }
                      }}
                    >
                      <span class="sender-avatar">
                        {m.senderName ? avatarLetter(m.senderName) : <Phone size={16} />}
                      </span>
                      <span class="row-content">
                        <span class="row-head">
                          <strong>{m.senderName || m.sender || 'Unknown sender'}</strong>
                          <time>{timeLabel(m.receivedAt)}</time>
                        </span>
                        <span class="preview">{linkifyText(m.text)}</span>
                        {code && (
                          <span class="otp-tag">
                            <span>
                              Code detected: <strong>{code}</strong>
                            </span>
                            <button
                              type="button"
                              type="button"
                              class="copy-code-link"
                              aria-label={`Copy code ${code}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                void copy(code)
                              }}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              <Copy size={13} aria-hidden="true" />
                            </button>
                          </span>
                        )}
                      </span>
                    </div>
                  )
                })
              )}
            </div>
            {filtered.length > pageSize && (
              <nav class="pagination" aria-label="Message pages">
                <button
                  type="button"
                  class="secondary pagination-button"
                  disabled={page === 0}
                  onClick={() => setPage((currentPage) => Math.max(0, currentPage - 1))}
                >
                  Previous
                </button>
                <span>
                  Page {page + 1} of {pageCount}
                </span>
                <button
                  type="button"
                  class="secondary pagination-button"
                  disabled={page === pageCount - 1}
                  onClick={() => setPage((currentPage) => Math.min(pageCount - 1, currentPage + 1))}
                >
                  Next
                </button>
              </nav>
            )}
          </div>
          <section class="detail-pane">
            {current ? (
              <>
                <div class="detail-header">
                  <button
                    type="button"
                    class="icon-button back"
                    aria-label="Back to inbox"
                    onClick={() => setSelected(null)}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <span class="detail-label">MESSAGE DETAILS</span>
                  <button
                    type="button"
                    class="icon-button danger-icon"
                    aria-label="Delete message"
                    onClick={() => setConfirm(true)}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
                <div class="detail-body">
                  <h2>{current.senderName || current.sender || 'Unknown sender'}</h2>
                  {current.senderName && <p class="sender-number">{current.sender}</p>}
                  <p class="detail-date">Received {timeLabel(current.receivedAt)}</p>
                  <div class="message-text">
                    <span>{linkifyText(current.text)}</span>
                    <span class="char-count">{current.text.length} characters</span>
                  </div>
                  {detectOTP(current.text) && (
                    <div class="code-card">
                      <div>
                        <span class="eyebrow">VERIFICATION CODE</span>
                        <strong>{detectOTP(current.text)}</strong>
                      </div>
                      <button
                        type="button"
                        class="secondary copy-button"
                        onClick={() => void copy(detectOTP(current.text)!)}
                      >
                        <Copy size={15} /> Copy code
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div class="detail-empty">
                <Radio size={24} />
                <p>Select a message to read</p>
                <span>Choose a message from your inbox.</span>
              </div>
            )}
          </section>
        </section>
        <footer class="footer">
          <span>{deviceLabel}</span>
        </footer>
      </main>
      {toast && (
        <div class="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {confirm && (
        <div
          class="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirm(false)
          }}
        >
          <section
            class="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <div class="dialog-icon">
              <Trash2 size={19} />
            </div>
            <h2 id="delete-title">Delete this message?</h2>
            <p>This will permanently delete the SMS from your modem.</p>
            <div class="dialog-actions">
              <button type="button" class="secondary" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button type="button" class="destructive" disabled={loading} onClick={() => void remove()}>
                {loading ? 'Deleting…' : 'Delete message'}
              </button>
            </div>
          </section>
        </div>
      )}
      {signOutConfirm && (
        <div
          class="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSignOutConfirm(false)
          }}
        >
          <section
            class="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="signout-title"
          >
            <div class="dialog-icon">
              <LogOut size={19} />
            </div>
            <h2 id="signout-title">Are you sure you want to sign out?</h2>
            <p>You can sign back in whenever you want.</p>
            <div class="dialog-actions">
              <button type="button" class="secondary" onClick={() => setSignOutConfirm(false)}>
                Cancel
              </button>
              <button type="button" class="destructive" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </section>
        </div>
      )}
      {deviceInfoOpen && status?.connected && (
        <div
          class="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeviceInfoOpen(false)
          }}
        >
          <section
            class="dialog device-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="device-info-title"
          >
            <div class="dialog-icon">
              <Radio size={19} />
            </div>
            <h2 id="device-info-title">Modem information</h2>
            <dl class="device-info-list">
              <dt>Device name</dt>
              <dd>{status.deviceName || 'Unknown'}</dd>
              <dt>IMEI</dt>
              <dd>{status.imei || 'Unknown'}</dd>
              <dt>IMSI</dt>
              <dd>{status.imsi || 'Unknown'}</dd>
              <dt>My number</dt>
              <dd>{status.phoneNumber || 'Unknown'}</dd>
              <dt>Hardware version</dt>
              <dd>{status.hardwareVersion || 'Unknown'}</dd>
              <dt>Software version</dt>
              <dd>{status.softwareVersion || 'Unknown'}</dd>
              <dt>Web UI version</dt>
              <dd>{status.webUIVersion || 'Unknown'}</dd>
              <dt>LAN MAC address</dt>
              <dd>{status.lanMacAddress || 'Unknown'}</dd>
              <dt>WAN IP address</dt>
              <dd>{status.wanIpAddress || 'Unknown'}</dd>
            </dl>
            <div class="dialog-actions">
              <button type="button" class="secondary" onClick={() => setDeviceInfoOpen(false)}>
                Close
              </button>
              <button type="button" class="destructive" onClick={() => setRebootConfirm(true)}>
                Reboot
              </button>
            </div>
          </section>
        </div>
      )}
      {rebootConfirm && (
        <div
          class="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRebootConfirm(false)
          }}
        >
          <section
            class="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reboot-title"
          >
            <div class="dialog-icon">
              <RefreshCw size={19} />
            </div>
            <h2 id="reboot-title">Reboot modem?</h2>
            <p>The modem will disconnect briefly while it restarts.</p>
            <div class="dialog-actions">
              <button type="button" class="secondary" onClick={() => setRebootConfirm(false)}>
                Cancel
              </button>
              <button type="button" class="destructive" disabled={rebooting} onClick={() => void reboot()}>
                {rebooting ? 'Rebooting…' : 'Reboot'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
