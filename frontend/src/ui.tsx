import type { ComponentChildren } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
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
import { api, AuthenticationError, type SMS, type Status } from './api'
import modemIcon from './modem.svg'
import slackIcon from './slack.svg'

function timeLabel(raw: string) {
  const date = new Date(raw)
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1) return 'Unknown date'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(date)
}
function relativeTimeLabel(raw: string) {
  const timestamp = new Date(raw).getTime()
  if (!Number.isFinite(timestamp)) return 'Unknown date'
  const seconds = (timestamp - Date.now()) / 1000
  if (Math.abs(seconds) < 10) return 'just now'
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ]
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, unitSeconds] of units) {
    if (Math.abs(seconds) >= unitSeconds || unit === 'second') {
      return formatter.format(Math.round(seconds / unitSeconds), unit)
    }
  }
  return 'just now'
}
function pathMessageId() {
  const match = window.location.pathname.match(/^\/sms\/([^/?#]+)\/?$/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}
function setMessagePath(id: string | null) {
  const url = new URL(window.location.href)
  url.pathname = id ? `/sms/${encodeURIComponent(id)}` : '/'
  url.hash = ''
  window.history.replaceState(null, '', url)
}
function tellowsURL(number: string) {
  const digits = number.replace(/\D/g, '')
  const normalized = number.trim().startsWith('+') ? `+${digits}` : digits
  return normalized ? `https://www.tellows.com/num/${encodeURIComponent(normalized)}` : ''
}
function phoneURL(number: string) {
  const digits = number.replace(/\D/g, '')
  const normalized = number.trim().startsWith('+') ? `+${digits}` : digits
  return normalized ? `tel:${normalized}` : ''
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
function Login({ initialError = '' }: { initialError?: string }) {
  const [username, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(initialError)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (initialError) setError(initialError)
  }, [initialError])
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
        <p class="eyebrow">SMS INBOX</p>
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
  const [authError, setAuthError] = useState('')
  const [items, setItems] = useState<SMS[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [deepLinkId, setDeepLinkId] = useState<string | null>(() => pathMessageId())
  const markingRead = useRef(new Set<string>())
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [signOutConfirm, setSignOutConfirm] = useState(false)
  const [deviceInfoOpen, setDeviceInfoOpen] = useState(false)
  const [slackInfoOpen, setSlackInfoOpen] = useState(false)
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
  const currentCode = current?.isOtp ? current.otpCodes[0] || null : null
  const filtered = useMemo(
    () => items.filter((m) => `${m.sender} ${m.text}`.toLowerCase().includes(query.toLowerCase())),
    [items, query],
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const visibleMessages = filtered.slice(page * pageSize, (page + 1) * pageSize)
  const slackDeliveries = status?.slackDeliveries ?? []
  const deviceLabel =
    [status?.deviceName, status?.hardwareVersion].filter(Boolean).join(' · ') || 'HiLink modem'
  useEffect(() => {
    document.title = unreadCount > 0 ? `HiLink SMS Inbox (${unreadCount})` : 'HiLink SMS Inbox'
  }, [unreadCount])
  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, pageCount - 1))
  }, [pageCount])
  useEffect(() => {
    setPage(0)
  }, [query])
  function handleAuthenticationError(err: unknown) {
    if (!(err instanceof AuthenticationError)) return false
    setAuthError(err.message)
    setAuth(false)
    setItems([])
    setStatus(null)
    setSelected(null)
    setSlackInfoOpen(false)
    setMessagePath(null)
    setDeepLinkId(null)
    setError('')
    return true
  }
  useEffect(() => {
    api
      .session()
      .then((s) => {
        setAuth(s.authenticated)
        if (s.authenticated) setAuthError('')
      })
      .catch((err) => {
        if (!handleAuthenticationError(err)) setAuth(false)
      })
  }, [])
  useEffect(() => {
    const onPathChange = () => setDeepLinkId(pathMessageId())
    window.addEventListener('popstate', onPathChange)
    return () => window.removeEventListener('popstate', onPathChange)
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        !selected ||
        confirm ||
        signOutConfirm ||
        deviceInfoOpen ||
        slackInfoOpen ||
        rebootConfirm ||
        rebooting
      ) {
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      setSelected(null)
      setMessagePath(null)
      setDeepLinkId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selected, confirm, signOutConfirm, deviceInfoOpen, slackInfoOpen, rebootConfirm, rebooting])
  useEffect(() => {
    if (!authenticated || rebooting) return
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
        if (!handleAuthenticationError(e)) {
          setError(e instanceof Error ? e.message : 'Unable to load messages')
        }
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
  }, [authenticated, refreshCount, rebooting])
  async function remove() {
    if (!current) return
    setLoading(true)
    try {
      await api.delete(current.id)
      setItems((prev) => prev.filter((m) => m.id !== current.id))
      setSelected(null)
      setMessagePath(null)
      setDeepLinkId(null)
      setConfirm(false)
      notice('Message deleted')
    } catch (e) {
      if (!handleAuthenticationError(e)) {
        setError(e instanceof Error ? e.message : 'Unable to delete message')
      }
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
    setMessagePath(message.id)
    setDeepLinkId(message.id)
    if (message.read || markingRead.current.has(message.id)) return
    markingRead.current.add(message.id)
    try {
      await api.markRead(message.id)
      setItems((prev) =>
        prev.map((item) => (item.id === message.id ? { ...item, read: true } : item)),
      )
    } catch (e) {
      if (!handleAuthenticationError(e)) {
        setError(e instanceof Error ? e.message : 'Unable to mark message as read')
      }
    } finally {
      markingRead.current.delete(message.id)
    }
  }
  useEffect(() => {
    if (!authenticated || !deepLinkId) return
    const message = items.find((item) => item.id === deepLinkId)
    if (message) void selectMessage(message)
  }, [authenticated, deepLinkId, items])
  async function signOut() {
    setSignOutConfirm(false)
    await api.logout().catch(() => {})
    setAuth(false)
    setAuthError('')
    setItems([])
    setSelected(null)
    setSlackInfoOpen(false)
    setMessagePath(null)
    setDeepLinkId(null)
  }
  async function reboot() {
    setRebootConfirm(false)
    setDeviceInfoOpen(false)
    setRebooting(true)
    const recoveryStartedAt = Date.now()
    const wait = (milliseconds: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
    try {
      try {
        await api.reboot()
      } catch (e) {
        if (handleAuthenticationError(e)) return
        setError(e instanceof Error ? e.message : 'Unable to reboot modem')
      }
      setStatus((currentStatus) =>
        currentStatus
          ? { ...currentStatus, connected: false, error: 'Modem is rebooting.' }
          : currentStatus,
      )
      await wait(Math.max(0, 35000 - (Date.now() - recoveryStartedAt)))
      for (;;) {
        try {
          const data = await api.inbox()
          setItems(data.messages)
          setStatus(data.status)
          setError('')
          break
        } catch (e) {
          if (handleAuthenticationError(e)) return
          await wait(2000)
        }
      }
      notice('Modem back online')
    } catch (e) {
      if (handleAuthenticationError(e)) return
      setError(e instanceof Error ? e.message : 'Unable to recover modem connection')
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
  if (!authenticated) return <Login initialError={authError} />
  return (
    <div class="app-shell">
      <main class="workspace">
        <header class="topbar">
          <div class="brand">
            <span class="brand-mark small">
              <MessageSquare size={16} />
            </span>
            <span>
              HiLink SMS<span class="brand-light"> Inbox</span>
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
                <span
                  class="status-icon modem-icon"
                  style={`--status-icon: url("${modemIcon}")`}
                  aria-hidden="true"
                />
                <span>Modem connected</span>
              </button>
            ) : (
              <div class="connection">
                <span class="dot amber" />
                <span
                  class="status-icon modem-icon"
                  style={`--status-icon: url("${modemIcon}")`}
                  aria-hidden="true"
                />
                <span>Connecting to modem</span>
              </div>
            )}
            <button
              type="button"
              class="connection connection-button slack-connection"
              title={
                status?.slackEnabled
                  ? 'Show Slack forwarding history'
                  : 'Slack notifications disabled; show forwarding history'
              }
              aria-label={
                status?.slackEnabled
                  ? 'Show Slack forwarding history'
                  : 'Slack notifications disabled; show forwarding history'
              }
              onClick={() => setSlackInfoOpen(true)}
            >
              <span class={`dot ${status?.slackEnabled ? 'green' : 'gray'}`} />
              <span
                class="status-icon slack-icon"
                style={`--status-icon: url("${slackIcon}")`}
                aria-hidden="true"
              />
              <span>Slack {status?.slackEnabled ? 'enabled' : 'disabled'}</span>
            </button>
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
                <span class="sync-inline">Last synced {timeLabel(status.lastSync)}</span>
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
                  const code = m.isOtp ? m.otpCodes[0] || null : null
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
                          <time dateTime={m.receivedAt} title={timeLabel(m.receivedAt)}>
                            {relativeTimeLabel(m.receivedAt)}
                          </time>
                        </span>
                        <span class="preview">{linkifyText(m.text)}</span>
                        {code && (
                          <span class="otp-tag">
                            <span>
                              Code detected: <strong>{code}</strong>
                            </span>
                            <button
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
                    onClick={() => {
                      setSelected(null)
                      setMessagePath(null)
                      setDeepLinkId(null)
                    }}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <span class="detail-label">MESSAGE DETAILS</span>
                  {tellowsURL(current.sender) && (
                    <a
                      class="sender-lookup"
                      href={tellowsURL(current.sender)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Check this number on tellows"
                    >
                      <ExternalLink size={14} />
                      <span>Check number</span>
                    </a>
                  )}
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
                  <div class="detail-title-row">
                    <div class="detail-identity">
                      <h2>
                        {current.senderName || !phoneURL(current.sender) ? (
                          current.senderName || current.sender || 'Unknown sender'
                        ) : (
                          <a class="sender-title-phone" href={phoneURL(current.sender)}>
                            {current.sender}
                          </a>
                        )}
                      </h2>
                      {current.senderName && (
                        <a class="sender-number" href={phoneURL(current.sender)}>
                          {current.sender}
                        </a>
                      )}
                    </div>
                    <time
                      class="detail-date"
                      dateTime={current.receivedAt}
                      title={timeLabel(current.receivedAt)}
                    >
                      {timeLabel(current.receivedAt)}
                    </time>
                  </div>
                  <div class="message-text">{linkifyText(current.text)}</div>
                  <div class="char-count">{current.text.length} characters</div>
                  {currentCode && (
                    <div class="code-card">
                      <div>
                        <span class="eyebrow">VERIFICATION CODE</span>
                        <strong>{currentCode}</strong>
                      </div>
                      <button
                        type="button"
                        class="secondary copy-button"
                        onClick={() => void copy(currentCode)}
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
          <span class="footer-disclaimer">
            Self-hosted HiLink API compatible SMS Inbox · reads SMS from your LTE stick ·{' '}
            {deviceLabel}
          </span>
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
              <button
                type="button"
                class="destructive"
                disabled={loading}
                onClick={() => void remove()}
              >
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
      {slackInfoOpen && (
        <div
          class="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSlackInfoOpen(false)
          }}
        >
          <section
            class="dialog slack-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="slack-info-title"
          >
            <div class="dialog-icon">
              <MessageSquare size={19} />
            </div>
            <h2 id="slack-info-title">Slack forwarding history</h2>
            <p>Showing the last 15 successfully forwarded messages.</p>
            {slackDeliveries.length ? (
              <ol class="slack-history">
                {slackDeliveries.map((delivery) => (
                  <li key={`${delivery.sentAt}-${delivery.sender}-${delivery.receivedAt}`}>
                    <strong>{delivery.sender || 'Unknown sender'}</strong>
                    <span>Sent to Slack {timeLabel(delivery.sentAt)}</span>
                    <span>SMS received {timeLabel(delivery.receivedAt)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p class="slack-history-empty">
                {status?.slackEnabled
                  ? 'No SMS has been forwarded to Slack yet.'
                  : 'Slack forwarding is disabled.'}
              </p>
            )}
            <div class="dialog-actions">
              <button type="button" class="secondary" onClick={() => setSlackInfoOpen(false)}>
                Close
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
              <button
                type="button"
                class="destructive"
                disabled={rebooting}
                onClick={() => void reboot()}
              >
                {rebooting ? 'Rebooting…' : 'Reboot'}
              </button>
            </div>
          </section>
        </div>
      )}
      {rebooting && (
        <div class="reboot-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="reboot-progress-title" aria-describedby="reboot-progress-description">
          <section class="reboot-dialog">
            <div class="dialog-icon">
              <RefreshCw class="refresh-spinning" size={19} />
            </div>
            <h2 id="reboot-progress-title">Rebooting modem…</h2>
            <p id="reboot-progress-description">
              The modem is restarting. We’ll return you to the inbox when it is back online.
            </p>
            <div class="reboot-progress" aria-hidden="true">
              <span />
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
