import { useEffect, useMemo, useState } from 'preact/hooks'
import {
  Activity,
  Check,
  ChevronLeft,
  Copy,
  Inbox,
  LogOut,
  MessageSquare,
  Moon,
  Radio,
  Search,
  Sun,
  Trash2,
  X,
} from 'lucide-preact'
import { api, type SMS, type Status } from './api'

export function detectOTP(text: string) {
  const patterns = [
    /(?:code|otp|verification|verify|security|login|sicherheitscode|verifizierungscode|verification\s+code)\D{0,24}(\d{4,8})/i,
    /\b(\d{6})\b/,
  ]
  for (const pattern of patterns) {
    const hit = text.match(pattern)
    if (hit) return hit[1]
  }
  return null
}
function timeLabel(raw: string) {
  const date = new Date(raw)
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  )
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
      class="icon-button"
      aria-label={`Theme: ${theme}`}
      title={`Theme: ${theme}`}
      onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}
    >
      {isDark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}
function Login({ onLogin }: { onLogin: () => void }) {
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
      onLogin()
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
              autoComplete="username"
              value={username}
              onInput={(e) => setUser((e.target as HTMLInputElement).value)}
              required
            />
          </label>
          <label>
            Password
            <input
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
          <button class="primary full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
            <ChevronLeft class="arrow" size={16} />
          </button>
        </form>
        <div class="login-foot">
          <span class="dot green" /> Private connection
        </div>
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
  const [refreshCount, setRefreshCount] = useState(0)
  const current = items.find((m) => m.id === selected) || null
  const filtered = useMemo(
    () => items.filter((m) => `${m.sender} ${m.text}`.toLowerCase().includes(query.toLowerCase())),
    [items, query],
  )
  useEffect(() => {
    api
      .session()
      .then((s) => setAuth(s.authenticated))
      .catch(() => setAuth(false))
  }, [])
  useEffect(() => {
    if (!authenticated) return
    let active = false
    let timer: number
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || active) return
      active = true
      try {
        const data = await api.inbox()
        setItems(data.messages)
        setStatus(data.status)
        setError('')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unable to load messages')
      } finally {
        active = false
      }
    }
    void refresh()
    timer = window.setInterval(() => void refresh(), 10000)
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(timer)
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
  async function signOut() {
    await api.logout().catch(() => {})
    setAuth(false)
    setItems([])
    setSelected(null)
  }
  if (authenticated === null)
    return (
      <div class="splash">
        <span class="spinner" />
      </div>
    )
  if (!authenticated) return <Login onLogin={() => setAuth(true)} />
  return (
    <div class="app-shell">
      <aside class="rail">
        <div class="rail-brand">
          <MessageSquare size={19} />
        </div>
        <div class="rail-line" />
        <button aria-label="Inbox" class="rail-item active">
          <Inbox size={19} />
        </button>
        <div class="rail-bottom">
          <button class="rail-item" aria-label="Sign out" onClick={signOut}>
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <div class="brand">
            <span class="brand-mark small">
              <MessageSquare size={16} />
            </span>
            <span>
              HiLink<span class="brand-light"> / Inbox</span>
            </span>
          </div>
          <div class="top-actions">
            <div class="connection">
              <span class={`dot ${status?.connected ? 'green' : 'gray'}`} />
              <span>{status?.connected ? 'Modem connected' : 'Connecting to modem'}</span>
            </div>
            <span class="top-divider" />
            <ThemeToggle />
            <button class="avatar" aria-label="Sign out" title="Sign out" onClick={signOut}>
              H
            </button>
          </div>
        </header>
        <div class="page-heading">
          <div>
            <p class="eyebrow">MESSAGES</p>
            <h1>
              Your inbox <span class="count">{items.length}</span>
            </h1>
            <p class="muted">Messages received on your modem appear here.</p>
          </div>
          <button class="secondary refresh" onClick={() => setRefreshCount((n) => n + 1)}>
            <Activity size={16} /> Refresh
          </button>
        </div>
        <div
          class={`sync-note ${status?.error || error ? 'sync-error' : ''}`}
          role={error || status?.error ? 'alert' : undefined}
        >
          <span class={`dot ${status?.connected ? 'green' : 'amber'}`} />
          <span>
            {error ||
              status?.error ||
              (status?.lastSync
                ? `Last synced ${timeLabel(status.lastSync)}`
                : 'Waiting for first sync')}
          </span>
        </div>
        <section class={`inbox-panel ${current ? 'has-detail' : ''}`}>
          <div class="list-pane">
            <div class="list-toolbar">
              <div class="search">
                <Search size={16} />
                <input
                  aria-label="Search messages"
                  placeholder="Search messages…"
                  value={query}
                  onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                />
                {query && (
                  <button
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
                filtered.map((m) => (
                  <button
                    class={`message-row ${selected === m.id ? 'selected' : ''}`}
                    key={m.id}
                    onClick={() => setSelected(m.id)}
                  >
                    <span class="sender-avatar">{(m.sender || '?').slice(-1)}</span>
                    <span class="row-content">
                      <span class="row-head">
                        <strong>{m.sender || 'Unknown sender'}</strong>
                        <time>{timeLabel(m.receivedAt)}</time>
                      </span>
                      <span class="preview">{m.text}</span>
                      {detectOTP(m.text) && <span class="otp-tag">Code detected</span>}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
          <section class="detail-pane">
            {current ? (
              <>
                <div class="detail-header">
                  <button
                    class="icon-button back"
                    aria-label="Back to inbox"
                    onClick={() => setSelected(null)}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <span class="detail-label">MESSAGE DETAILS</span>
                  <button
                    class="icon-button danger-icon"
                    aria-label="Delete message"
                    onClick={() => setConfirm(true)}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
                <div class="detail-body">
                  <div class="sender-avatar large">{(current.sender || '?').slice(-1)}</div>
                  <h2>{current.sender || 'Unknown sender'}</h2>
                  <p class="detail-date">Received {timeLabel(current.receivedAt)}</p>
                  <div class="message-text">{current.text}</div>
                  {detectOTP(current.text) && (
                    <div class="code-card">
                      <div>
                        <span class="eyebrow">VERIFICATION CODE</span>
                        <strong>{detectOTP(current.text)}</strong>
                      </div>
                      <button
                        class="secondary copy-button"
                        onClick={() => void copy(detectOTP(current.text)!)}
                      >
                        <Copy size={15} /> Copy code
                      </button>
                    </div>
                  )}
                  <button class="secondary copy-message" onClick={() => void copy(current.text)}>
                    <Copy size={15} /> Copy message
                  </button>
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
          <span>
            <span class="dot green" /> Your messages stay private
          </span>
          <span>HiLink SMS Manager</span>
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
              <button class="secondary" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button class="destructive" disabled={loading} onClick={() => void remove()}>
                {loading ? 'Deleting…' : 'Delete message'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
