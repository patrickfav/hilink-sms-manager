import type { ComponentChildren } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  Bell,
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
  Inbox,
  Link2,
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
import {
  calendarDateKey,
  calendarDateLabel,
  pathMessageRef,
  phoneURL,
  relativeTimeLabel,
  syntheticThreadID,
  tellowsURL,
  timeLabel,
  type DeepLink,
} from './utils'
function setMessagePath(ref: DeepLink | null) {
  const url = new URL(window.location.href)
  url.pathname = ref
    ? ref.messageId
      ? `/sms/${encodeURIComponent(ref.threadId)}/${encodeURIComponent(ref.messageId)}`
      : `/sms/${encodeURIComponent(ref.threadId)}`
    : '/'
  url.hash = ''
  window.history.replaceState(null, '', url)
}
type MessageThread = {
  key: string
  messages: SMS[]
  latest: SMS
  unreadCount: number
}
const maxMessagesPerThread = 150
const maxThreads = 150
function threadKey(message: SMS) {
  if (message.threadId) return message.threadId
  const sender = message.senderDetails?.international || message.sender
  const digits = sender.replace(/\D/g, '')
  return digits || message.sender.trim().toLocaleLowerCase()
}
function internationalSender(message: SMS) {
  return message.senderDetails?.international || message.sender
}
type BrowserNotificationPermission = NotificationPermission | 'unsupported'

function getBrowserNotificationPermission(): BrowserNotificationPermission {
  return typeof window !== 'undefined' && 'Notification' in window
    ? window.Notification.permission
    : 'unsupported'
}

function notificationMessageKey(message: SMS) {
  return `${message.id}\0${message.receivedAt}\0${message.sender}\0${message.text}`
}

function createBrowserNotification(title: string, body: string, tag: string) {
  if (getBrowserNotificationPermission() !== 'granted') return
  let notification: Notification
  try {
    notification = new window.Notification(title, { body, tag })
  } catch {
    return null
  }
  return notification
}

function notifyAboutNewMessage(message: SMS) {
  const sender = internationalSender(message) || 'Unknown sender'
  const body = message.text.length > 180 ? `${message.text.slice(0, 177)}…` : message.text
  const notification = createBrowserNotification(
    `New SMS from ${sender}`,
    body || 'New message received.',
    `sms-${message.id}`,
  )
  if (!notification) return
  notification.onclick = () => {
    window.focus()
    if (message.threadId) {
      const url = new URL(window.location.href)
      url.pathname = `/sms/${encodeURIComponent(message.threadId)}/${encodeURIComponent(message.id)}`
      url.hash = ''
      window.history.replaceState(null, '', url)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
    notification.close()
  }
}

function avatarLetter(name: string) {
  return name.trim().slice(0, 1).toUpperCase()
}
function countryName(country?: string) {
  if (!country) return 'Unknown'
  try {
    return (
      new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' }).of(country) || country
    )
  } catch {
    return country
  }
}
function phoneTypeLabel(type?: string) {
  if (!type) return 'Unknown'
  if (type === 'VoIP') return type
  return type.charAt(0).toUpperCase() + type.slice(1)
}
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function highlightText(text: string, query: string, keyPrefix: string): ComponentChildren {
  const search = query.trim()
  if (!search) return text
  const pattern = new RegExp(escapeRegExp(search), 'gi')
  const parts: ComponentChildren[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    parts.push(<mark key={`${keyPrefix}-${match.index}`}>{match[0]}</mark>)
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.length > 0 ? parts : text
}
function matchesSearch(message: SMS, search: string) {
  return `${internationalSender(message)} ${message.sender} ${message.senderName || ''} ${message.text}`
    .toLowerCase()
    .includes(search)
}
function linkifyText(text: string, codes: string[] = [], highlight = ''): ComponentChildren {
  const tokenSources = [
    `https?://[^\\s<>"']+`,
    `www\\.[^\\s<>"']+`,
    `[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}`,
    `(?:\\+\\d[\\d\\s().-]{6,}\\d)`,
    ...codes.map(escapeRegExp),
  ]
  const tokenPattern = new RegExp(`(${tokenSources.join('|')})`, 'gi')
  const parts: ComponentChildren[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(text))) {
    const rawToken = match[0]
    const trailing = rawToken.match(/[.,!?;:)\]}]+$/)?.[0] || ''
    const visibleToken = trailing ? rawToken.slice(0, -trailing.length) : rawToken
    const isDetectedCode = codes.some((code) => code.toLowerCase() === visibleToken.toLowerCase())
    if (isDetectedCode) {
      if (match.index > cursor) {
        parts.push(highlightText(text.slice(cursor, match.index), highlight, `text-${match.index}`))
      }
      parts.push(
        <code class="message-code" key={`code-${match.index}`}>
          {highlightText(visibleToken, highlight, `code-${match.index}`)}
        </code>,
      )
      if (trailing) parts.push(highlightText(trailing, highlight, `trailing-${match.index}`))
      cursor = match.index + rawToken.length
      continue
    }
    const isWebUrl = /^(?:https?:\/\/|www\.)/i.test(visibleToken)
    const isEmail = visibleToken.includes('@')
    const href = isWebUrl
      ? `https://transparencyreport.google.com/safe-browsing/search?url=${encodeURIComponent(visibleToken.startsWith('www.') ? `https://${visibleToken}` : visibleToken)}`
      : isEmail
        ? `mailto:${visibleToken}`
        : `tel:${visibleToken.replace(/[^\d+]/g, '')}`
    if (match.index > cursor) {
      parts.push(highlightText(text.slice(cursor, match.index), highlight, `text-${match.index}`))
    }
    parts.push(
      <a
        class="message-link"
        href={href}
        key={`link-${match.index}`}
        title={isWebUrl ? 'Check with Google Safe Browsing' : undefined}
        {...(isWebUrl ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {highlightText(visibleToken, highlight, `link-${match.index}`)}
      </a>,
    )
    if (trailing) parts.push(highlightText(trailing, highlight, `trailing-${match.index}`))
    cursor = match.index + rawToken.length
  }
  if (cursor < text.length)
    parts.push(highlightText(text.slice(cursor), highlight, `text-${cursor}`))
  return parts
}
function VerificationCodeWidget({
  code,
  onCopy,
  label = 'Verification code:',
}: {
  code: string
  onCopy: (code: string) => void
  label?: string
}) {
  return (
    <span class="otp-tag verification-code-widget">
      <span class="verification-code-label">{label}</span>
      <strong>{code}</strong>
      <button
        type="button"
        class="copy-code-link"
        aria-label={`Copy code ${code}`}
        onClick={(event) => {
          event.stopPropagation()
          onCopy(code)
        }}
      >
        <Copy size={13} aria-hidden="true" />
      </button>
    </span>
  )
}
function useScrollShadows(dependency: number) {
  const ref = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState({ top: false, bottom: false })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => {
      setPosition({
        top: element.scrollTop > 1,
        bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 1,
      })
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element)
    return () => {
      element.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [dependency])
  const className = [
    position.top ? 'has-scroll-shadow-top' : '',
    position.bottom ? 'has-scroll-shadow-bottom' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return {
    ref: (element: HTMLElement | null) => {
      ref.current = element
    },
    className,
  }
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
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(null)
  const [seenUnreadIds, setSeenUnreadIds] = useState<Set<string>>(() => new Set())
  const [deepLink, setDeepLink] = useState<DeepLink | null>(() => pathMessageRef())
  const markingRead = useRef(new Set<string>())
  const messageRefs = useRef(new Map<string, HTMLElement>())
  const selectedThreadRef = useRef<HTMLDivElement | null>(null)
  const [selectedThreadFloating, setSelectedThreadFloating] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [signOutConfirm, setSignOutConfirm] = useState(false)
  const [deviceInfoOpen, setDeviceInfoOpen] = useState(false)
  const [senderInfoOpen, setSenderInfoOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [browserNotificationPermission, setBrowserNotificationPermission] =
    useState<BrowserNotificationPermission>(() => getBrowserNotificationPermission())
  const knownMessageKeys = useRef<Set<string> | null>(null)
  const [rebootConfirm, setRebootConfirm] = useState(false)
  const [rebooting, setRebooting] = useState(false)
  const [refreshCount, setRefreshCount] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshCycle, setRefreshCycle] = useState(0)
  const refreshInterval = 10000
  const unreadCount = items.filter((message) => !message.read).length
  const current = items.find((m) => m.id === selected) || null
  const threads = useMemo(() => {
    const grouped = new Map<string, SMS[]>()
    for (const message of items) {
      const key = threadKey(message)
      const messages = grouped.get(key) || []
      messages.push(message)
      grouped.set(key, messages)
    }
    return [...grouped.entries()]
      .map(([key, messages]): MessageThread => {
        const sorted = messages
          .slice()
          .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
        const limited = sorted.slice(0, maxMessagesPerThread)
        return {
          key,
          messages: limited,
          latest: limited[0],
          unreadCount: limited.filter((message) => !message.read).length,
        }
      })
      .sort((a, b) => {
        const dateDifference =
          new Date(b.latest.receivedAt).getTime() - new Date(a.latest.receivedAt).getTime()
        if (dateDifference !== 0) return dateDifference
        return a.key.localeCompare(b.key)
      })
      .slice(0, maxThreads)
  }, [items])
  const currentThread = selectedThreadKey
    ? threads.find((thread) => thread.key === selectedThreadKey) || null
    : current
      ? threads.find((thread) => thread.key === threadKey(current)) || null
      : null
  const threadContact = currentThread?.latest || current
  const senderInternationalNumber =
    threadContact?.senderDetails?.international || threadContact?.sender || ''
  const senderCheckNumberURL = tellowsURL(senderInternationalNumber)
  const threadMessages = currentThread?.messages || []
  const filteredThreads = useMemo(() => {
    const search = query.toLowerCase()
    return threads.filter((thread) =>
      thread.messages.some((message) => matchesSearch(message, search)),
    )
  }, [threads, query])
  const visibleThreadMessages = useMemo(() => {
    const search = query.toLowerCase()
    return search
      ? threadMessages.filter((message) => matchesSearch(message, search))
      : threadMessages
  }, [threadMessages, query])
  const listScrollShadows = useScrollShadows(filteredThreads.length)
  const detailScrollShadows = useScrollShadows(visibleThreadMessages.length)
  useEffect(() => {
    const element = selectedThreadRef.current
    if (!element || !selectedThreadKey) {
      setSelectedThreadFloating(false)
      return
    }
    const media = window.matchMedia('(min-width: 641px)')
    const update = () => {
      if (!media.matches || getComputedStyle(element).position !== 'sticky') {
        setSelectedThreadFloating(false)
        return
      }
      const style = getComputedStyle(element)
      const stickyTop = Number.parseFloat(style.top) || 0
      const rect = element.getBoundingClientRect()
      setSelectedThreadFloating(rect.top <= stickyTop + 0.5 && rect.bottom > stickyTop)
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [selectedThreadKey, filteredThreads.length, query])
  const slackDeliveries = status?.slackDeliveries ?? []
  const browserNotificationsAvailable = browserNotificationPermission !== 'unsupported'
  const browserNotificationsAllowed = browserNotificationPermission === 'granted'
  const browserNotificationsBlocked = browserNotificationPermission === 'denied'
  const deviceLabel =
    [status?.deviceName, status?.hardwareVersion].filter(Boolean).join(' · ') || 'HiLink modem'
  useEffect(() => {
    document.title = unreadCount > 0 ? `HiLink SMS Inbox (${unreadCount})` : 'HiLink SMS Inbox'
  }, [unreadCount])
  useEffect(() => {
    const syncBrowserNotificationPermission = () => {
      setBrowserNotificationPermission(getBrowserNotificationPermission())
    }
    window.addEventListener('focus', syncBrowserNotificationPermission)
    document.addEventListener('visibilitychange', syncBrowserNotificationPermission)
    return () => {
      window.removeEventListener('focus', syncBrowserNotificationPermission)
      document.removeEventListener('visibilitychange', syncBrowserNotificationPermission)
    }
  }, [])
  function handleAuthenticationError(err: unknown) {
    if (!(err instanceof AuthenticationError)) return false
    setAuthError(err.message)
    setAuth(false)
    setItems([])
    setStatus(null)
    setSelected(null)
    setSelectedThreadKey(null)
    setSeenUnreadIds(new Set())
    setSenderInfoOpen(false)
    setNotificationsOpen(false)
    knownMessageKeys.current = null
    setMessagePath(null)
    setDeepLink(null)
    setError('')
    return true
  }
  function applyInboxData(data: Awaited<ReturnType<typeof api.inbox>>) {
    const previousMessageKeys = knownMessageKeys.current
    if (previousMessageKeys) {
      for (const message of data.messages) {
        if (!previousMessageKeys.has(notificationMessageKey(message))) {
          notifyAboutNewMessage(message)
        }
      }
    }
    knownMessageKeys.current = new Set(data.messages.map(notificationMessageKey))
    setItems(data.messages)
    setStatus(data.status)
    setSeenUnreadIds((previous) => {
      const next = new Set(previous)
      for (const message of data.messages) {
        if (message.read) next.delete(message.id)
      }
      return next
    })
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
    const onPathChange = () => setDeepLink(pathMessageRef())
    window.addEventListener('popstate', onPathChange)
    return () => window.removeEventListener('popstate', onPathChange)
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || rebooting) return
      if (rebootConfirm) {
        setRebootConfirm(false)
        return
      }
      if (confirm) {
        setConfirm(false)
        return
      }
      if (signOutConfirm) {
        setSignOutConfirm(false)
        return
      }
      if (senderInfoOpen) {
        setSenderInfoOpen(false)
        return
      }
      if (deviceInfoOpen) {
        setDeviceInfoOpen(false)
        return
      }
      if (notificationsOpen) {
        setNotificationsOpen(false)
        return
      }
      if (!selected && !selectedThreadKey) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      setSelected(null)
      setSelectedThreadKey(null)
      setMessagePath(null)
      setDeepLink(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    selected,
    confirm,
    signOutConfirm,
    deviceInfoOpen,
    senderInfoOpen,
    notificationsOpen,
    rebootConfirm,
    rebooting,
    selectedThreadKey,
  ])
  useEffect(() => {
    if (!authenticated || rebooting) return
    let active = false
    let timer: number | undefined
    const refresh = async () => {
      if (
        (document.visibilityState !== 'visible' &&
          getBrowserNotificationPermission() !== 'granted') ||
        active
      )
        return
      active = true
      setRefreshing(true)
      try {
        const data = await api.inbox()
        applyInboxData(data)
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
      if (
        document.visibilityState !== 'visible' &&
        getBrowserNotificationPermission() !== 'granted'
      )
        return
      void refresh()
      timer = window.setInterval(() => void refresh(), refreshInterval)
    }
    const visible = () => {
      startPolling()
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
    const deletedThreadId = current.threadId || (await syntheticThreadID(current.sender))
    const deletedThreadKey = threadKey(current)
    setLoading(true)
    try {
      await api.delete(current.id)
      setItems((prev) => prev.filter((m) => m.id !== current.id))
      setSelectedThreadKey(deletedThreadKey)
      setSelected(null)
      const threadRef = { threadId: deletedThreadId, messageId: null }
      setMessagePath(threadRef)
      setDeepLink(threadRef)
      setRefreshCount((count) => count + 1)
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
  async function enableBrowserNotifications() {
    if (!browserNotificationsAvailable) {
      notice('Browser notifications are not supported')
      return
    }
    const permission = await window.Notification.requestPermission()
    setBrowserNotificationPermission(permission)
    if (permission === 'granted') notice('Browser notifications enabled')
    else if (permission === 'denied') notice('Browser notifications were blocked')
  }
  function sendTestBrowserNotification() {
    const notification = createBrowserNotification(
      'HiLink SMS Manager',
      'Browser notifications are working.',
      'hilink-sms-test',
    )
    notice(notification ? 'Test notification sent' : 'Unable to send test notification')
  }
  async function markThreadRead(thread: MessageThread) {
    const unreadMessages = thread.messages.filter((message) => !message.read)
    if (!unreadMessages.length) return
    for (const unreadMessage of unreadMessages) {
      if (markingRead.current.has(unreadMessage.id)) continue
      markingRead.current.add(unreadMessage.id)
      try {
        await api.markRead(unreadMessage.id)
        setItems((prev) =>
          prev.map((item) => (item.id === unreadMessage.id ? { ...item, read: true } : item)),
        )
        setSeenUnreadIds((previous) => {
          const next = new Set(previous)
          next.add(unreadMessage.id)
          return next
        })
      } catch (e) {
        if (handleAuthenticationError(e)) return
        setError(e instanceof Error ? e.message : 'Unable to mark message as read')
      } finally {
        markingRead.current.delete(unreadMessage.id)
      }
    }
  }
  async function selectThread(thread: MessageThread, updatePath = true) {
    setSelectedThreadKey(thread.key)
    setSelected(null)
    if (updatePath) {
      const threadId = thread.latest.threadId || (await syntheticThreadID(thread.latest.sender))
      const ref = { threadId, messageId: null }
      setMessagePath(ref)
      setDeepLink(ref)
    }
    void markThreadRead(thread)
  }
  async function selectMessage(message: SMS, updatePath = true) {
    setSelected(message.id)
    const thread = threads.find((candidate) => candidate.key === threadKey(message))
    if (thread) setSelectedThreadKey(thread.key)
    if (updatePath) {
      const threadId = message.threadId || (await syntheticThreadID(message.sender))
      const ref = { threadId, messageId: message.id }
      setMessagePath(ref)
      setDeepLink(ref)
    }
    if (thread) void markThreadRead(thread)
  }
  useEffect(() => {
    if (!authenticated || !deepLink) return
    if (deepLink.messageId) {
      const message = items.find((item) => item.id === deepLink.messageId)
      if (message) void selectMessage(message)
      return
    }
    const thread = threads.find((candidate) => candidate.key === deepLink.threadId)
    if (thread) void selectThread(thread, false)
  }, [authenticated, deepLink?.messageId, deepLink?.threadId, items, threads])
  useEffect(() => {
    if (!deepLink?.messageId || !current) return
    const messageElement = messageRefs.current.get(current.id)
    if (!messageElement) return
    window.requestAnimationFrame(() => {
      messageElement.scrollIntoView({ block: 'center', behavior: 'auto' })
    })
  }, [deepLink?.messageId, current?.id, threadMessages.length])
  async function signOut() {
    setSignOutConfirm(false)
    await api.logout().catch(() => {})
    setAuth(false)
    setAuthError('')
    setItems([])
    setSeenUnreadIds(new Set())
    setSelected(null)
    setSelectedThreadKey(null)
    setSenderInfoOpen(false)
    setNotificationsOpen(false)
    knownMessageKeys.current = null
    setMessagePath(null)
    setDeepLink(null)
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
          applyInboxData(data)
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
              class="connection connection-button notifications-connection"
              title="Show notification settings"
              aria-label="Show notification settings"
              onClick={() => setNotificationsOpen(true)}
            >
              <span
                class={`dot ${browserNotificationsAllowed || status?.slackEnabled ? 'green' : 'gray'}`}
              />
              <span class="notifications-icon" aria-hidden="true">
                <Bell size={15} />
              </span>
              <span>Notifications</span>
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
            <p class="eyebrow">{status?.phoneNumber || 'THREADS'}</p>
            <div class="heading-title-row">
              <h1>
                Your inbox <span class="count">{items.length}</span>
                {unreadCount > 0 && (
                  <span class="unread-count">
                    <span class="unread-mark" /> {unreadCount} unread
                  </span>
                )}
              </h1>
            </div>
          </div>
          <div class="heading-side">
            <div class="refresh-control">
              <button
                type="button"
                class={`secondary refresh ${refreshing ? 'is-refreshing' : ''}`}
                disabled={refreshing}
                onClick={() => {
                  setRefreshCycle((cycle) => cycle + 1)
                  setRefreshCount((n) => n + 1)
                }}
              >
                <div class="refresh-progress" aria-hidden="true">
                  <span
                    class="refresh-progress-fill"
                    key={refreshCycle}
                    style={refreshing ? undefined : { animationDuration: `${refreshInterval}ms` }}
                  />
                </div>
                <span class="refresh-content">
                  <RefreshCw class={refreshing ? 'refresh-spinning' : ''} size={16} />
                  {refreshing ? 'Refreshing…' : 'Refresh'}
                </span>
              </button>
            </div>
            {status?.lastSync && !status.error && !error && !status.storageFull && (
              <span class="sync-inline">Last synced {timeLabel(status.lastSync)}</span>
            )}
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
        <section class={`inbox-panel ${currentThread ? 'has-detail' : ''}`}>
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
                {filteredThreads.length} {filteredThreads.length === 1 ? 'sender' : 'senders'}
              </span>
            </div>
            <div class={`scroll-shadow-frame message-scroll-frame ${listScrollShadows.className}`}>
              <div ref={listScrollShadows.ref} class="message-list">
                {filteredThreads.length === 0 ? (
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
                  filteredThreads.map((thread) => {
                    const latest = thread.latest
                    const sender =
                      latest.senderName || internationalSender(latest) || 'Unknown sender'
                    const latestCode = latest.isOtp ? latest.otpCodes[0] || null : null
                    return (
                      <div
                        ref={selectedThreadKey === thread.key ? selectedThreadRef : undefined}
                        class={`message-row thread-row ${selectedThreadKey === thread.key ? 'selected' : ''} ${selectedThreadKey === thread.key && selectedThreadFloating ? 'floating' : ''} ${thread.unreadCount ? 'unread' : ''}`}
                        key={thread.key}
                      >
                        <button
                          type="button"
                          class="thread-row-main"
                          aria-label={`${sender}, ${thread.messages.length} ${thread.messages.length === 1 ? 'message' : 'messages'}, last message ${relativeTimeLabel(latest.receivedAt)}`}
                          onClick={() => void selectThread(thread)}
                        >
                          <span class="sender-avatar">
                            {latest.senderName ? (
                              avatarLetter(latest.senderName)
                            ) : (
                              <Phone size={16} />
                            )}
                          </span>
                          <span class="row-content">
                            <span class="row-head">
                              <span class="row-sender">
                                <strong>{sender}</strong>
                                {latest.senderName && internationalSender(latest) && (
                                  <span class="row-sender-number">
                                    {internationalSender(latest)}
                                  </span>
                                )}
                              </span>
                              <time
                                dateTime={latest.receivedAt}
                                title={timeLabel(latest.receivedAt)}
                              >
                                {relativeTimeLabel(latest.receivedAt)}
                              </time>
                            </span>
                            <span class="preview">{latest.text}</span>
                          </span>
                        </button>
                        <div class="thread-row-footer">
                          {latestCode && (
                            <VerificationCodeWidget
                              code={latestCode}
                              label="Code:"
                              onCopy={(value) => void copy(value)}
                            />
                          )}
                          <span class="thread-row-meta">
                            {thread.messages.length}{' '}
                            {thread.messages.length === 1 ? 'message' : 'messages'}
                            {thread.unreadCount > 0 && ` · ${thread.unreadCount} unread`}
                          </span>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>
          <div class="thread-scroll-frame">
            <section class="detail-pane thread-pane">
              {currentThread ? (
                <>
                  <div class="detail-header">
                    <button
                      type="button"
                      class="icon-button back"
                      aria-label="Back to inbox"
                      onClick={() => {
                        setSelected(null)
                        setSelectedThreadKey(null)
                        setMessagePath(null)
                        setDeepLink(null)
                      }}
                    >
                      <ChevronLeft size={18} />
                    </button>
                    <span class="detail-label">CONVERSATION</span>
                  </div>
                  <div
                    class={`scroll-shadow-frame thread-body-scroll-frame ${detailScrollShadows.className}`}
                  >
                    <div ref={detailScrollShadows.ref} class="thread-body-scroll-content">
                      <div class="detail-body">
                        <div class="thread-heading">
                          <div class="detail-identity">
                            {threadContact && (
                              <button
                                type="button"
                                class="sender-trigger connection-button"
                                aria-haspopup="dialog"
                                aria-label={`Show sender details for ${threadContact.senderName || internationalSender(threadContact) || 'Unknown sender'}`}
                                onClick={() => setSenderInfoOpen(true)}
                              >
                                <span class="sender-trigger-copy">
                                  <span class="sender-trigger-name">
                                    {threadContact.senderName ||
                                      threadContact.sender ||
                                      'Unknown sender'}
                                  </span>
                                  {threadContact.senderName && (
                                    <span class="sender-trigger-number">
                                      {internationalSender(threadContact)}
                                    </span>
                                  )}
                                </span>
                              </button>
                            )}
                          </div>
                          <div class="thread-count">
                            <span>
                              {query
                                ? `${visibleThreadMessages.length} of ${currentThread?.messages.length || 0} messages`
                                : `${currentThread?.messages.length || 0} ${currentThread?.messages.length === 1 ? 'message' : 'messages'}`}
                            </span>
                            {currentThread?.messages.length ? (
                              <time
                                class="thread-earliest"
                                dateTime={
                                  currentThread.messages[currentThread.messages.length - 1]
                                    .receivedAt
                                }
                                title={timeLabel(
                                  currentThread.messages[currentThread.messages.length - 1]
                                    .receivedAt,
                                )}
                              >
                                earliest message{' '}
                                {relativeTimeLabel(
                                  currentThread.messages[currentThread.messages.length - 1]
                                    .receivedAt,
                                )}
                              </time>
                            ) : null}
                          </div>
                        </div>
                        <div class="thread-messages" aria-label="Messages in this thread">
                          {visibleThreadMessages.length > 0 ? (
                            visibleThreadMessages.map((message, index) => {
                              const previous = visibleThreadMessages[index - 1]
                              const showDate =
                                !previous ||
                                calendarDateKey(previous.receivedAt) !==
                                  calendarDateKey(message.receivedAt)
                              const sender =
                                message.senderName ||
                                internationalSender(message) ||
                                'Unknown sender'
                              return (
                                <div
                                  class={`thread-entry ${showDate ? 'has-date-divider' : ''}`}
                                  key={message.id}
                                >
                                  {showDate && (
                                    <div class="thread-date-divider">
                                      <time dateTime={message.receivedAt}>
                                        {calendarDateLabel(message.receivedAt)}
                                      </time>
                                    </div>
                                  )}
                                  <article
                                    id={`message-${message.id}`}
                                    ref={(element) => {
                                      if (element) messageRefs.current.set(message.id, element)
                                      else messageRefs.current.delete(message.id)
                                    }}
                                    class={`thread-message ${message.id === selected ? 'selected' : ''}`}
                                  >
                                    <div class="thread-message-meta">
                                      <div class="thread-message-select">
                                        {seenUnreadIds.has(message.id) && (
                                          <span
                                            class="unread-marker"
                                            title="Unread when this thread was opened"
                                            aria-hidden="true"
                                          />
                                        )}
                                        <button
                                          type="button"
                                          class="thread-message-date"
                                          aria-pressed={message.id === selected}
                                          aria-label={`Select message from ${sender}, ${timeLabel(message.receivedAt)}`}
                                          onClick={() => void selectMessage(message)}
                                        >
                                          <time
                                            dateTime={message.receivedAt}
                                            title={timeLabel(message.receivedAt)}
                                          >
                                            {relativeTimeLabel(message.receivedAt)}
                                          </time>
                                        </button>
                                        {message.threadId && (
                                          <a
                                            class="thread-message-link"
                                            href={`/sms/${encodeURIComponent(message.threadId)}/${encodeURIComponent(message.id)}`}
                                            aria-label="Open direct link to this message"
                                            title="Open direct link to this message"
                                            onClick={(event) => event.stopPropagation()}
                                          >
                                            <Link2 size={13} aria-hidden="true" />
                                          </a>
                                        )}
                                      </div>
                                      <span class="thread-char-count">
                                        {message.text.length}{' '}
                                        {message.text.length === 1 ? 'character' : 'characters'}
                                      </span>
                                      <button
                                        type="button"
                                        class="thread-message-delete"
                                        aria-label={`Delete message from ${sender}, ${timeLabel(message.receivedAt)}`}
                                        onClick={() => {
                                          setSelected(message.id)
                                          setConfirm(true)
                                        }}
                                      >
                                        <Trash2 size={12} aria-hidden="true" />
                                      </button>
                                    </div>
                                    <div class="thread-message-text">
                                      {linkifyText(
                                        message.text,
                                        message.isOtp ? message.otpCodes : [],
                                        query,
                                      )}
                                    </div>
                                    {message.isOtp && message.otpCodes.length > 0 && (
                                      <div
                                        class="thread-message-codes"
                                        aria-label="Verification codes"
                                      >
                                        {message.otpCodes.map((code) => (
                                          <VerificationCodeWidget
                                            key={code}
                                            code={code}
                                            onCopy={(value) => void copy(value)}
                                          />
                                        ))}
                                      </div>
                                    )}
                                  </article>
                                </div>
                              )
                            })
                          ) : (
                            <div class="thread-filter-empty">
                              No matching messages in this thread.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div class="detail-empty">
                  <Radio size={24} />
                  <p>Select a thread to view</p>
                  <span>Choose a conversation from your inbox.</span>
                </div>
              )}
            </section>
          </div>
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
      {senderInfoOpen && threadContact && (
        <div
          class="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSenderInfoOpen(false)
          }}
        >
          <section
            class="dialog sender-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sender-info-title"
          >
            <div class="dialog-icon sender-dialog-icon">
              <Phone size={19} />
            </div>
            <h2 id="sender-info-title">
              {threadContact.senderName || threadContact.sender || 'Unknown sender'}
            </h2>
            <p>Sender details for this conversation.</p>
            <dl class="sender-info-list">
              <dt>Country</dt>
              <dd>
                {threadContact.senderDetails?.country
                  ? `${countryName(threadContact.senderDetails.country)} (${threadContact.senderDetails.country})`
                  : 'Unknown'}
              </dd>
              <dt>Number type</dt>
              <dd>{phoneTypeLabel(threadContact.senderDetails?.type)}</dd>
              <dt>Calling code</dt>
              <dd>
                {threadContact.senderDetails?.countryCallingCode
                  ? `+${threadContact.senderDetails.countryCallingCode}`
                  : 'Unknown'}
              </dd>
              {threadContact.senderDetails?.nationalDestinationCode && (
                <>
                  <dt>National destination code</dt>
                  <dd>{threadContact.senderDetails.nationalDestinationCode}</dd>
                </>
              )}
              {threadContact.senderName && (
                <>
                  <dt>Name</dt>
                  <dd>{threadContact.senderName}</dd>
                </>
              )}
              <dt>International format</dt>
              {threadContact.senderDetails?.international ? (
                <dd class="sender-info-copy">
                  <span>{threadContact.senderDetails.international}</span>
                  {phoneURL(internationalSender(threadContact)) && (
                    <a
                      class="phone-format-link"
                      href={phoneURL(internationalSender(threadContact))}
                      aria-label="Call sender using international format"
                      title="Call sender"
                    >
                      <Phone size={13} aria-hidden="true" />
                    </a>
                  )}
                  <button
                    type="button"
                    class="copy-code-link"
                    aria-label="Copy international format"
                    onClick={() => void copy(threadContact.senderDetails?.international || '')}
                  >
                    <Copy size={13} aria-hidden="true" />
                  </button>
                </dd>
              ) : (
                <dd>Unknown</dd>
              )}
              <dt>National format</dt>
              {threadContact.senderDetails?.national ? (
                <dd class="sender-info-copy">
                  <span>{threadContact.senderDetails.national}</span>
                  {phoneURL(internationalSender(threadContact)) && (
                    <a
                      class="phone-format-link"
                      href={phoneURL(internationalSender(threadContact))}
                      aria-label="Call sender using national format"
                      title="Call sender"
                    >
                      <Phone size={13} aria-hidden="true" />
                    </a>
                  )}
                  <button
                    type="button"
                    class="copy-code-link"
                    aria-label="Copy national format"
                    onClick={() => void copy(threadContact.senderDetails?.national || '')}
                  >
                    <Copy size={13} aria-hidden="true" />
                  </button>
                </dd>
              ) : (
                <dd>Unknown</dd>
              )}
            </dl>
            <div class="dialog-actions">
              <button type="button" class="secondary" onClick={() => setSenderInfoOpen(false)}>
                Close
              </button>
              {senderCheckNumberURL && (
                <a
                  class="sender-lookup"
                  href={senderCheckNumberURL}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Check this number on tellows"
                >
                  <ExternalLink size={14} />
                  <span>Check number</span>
                </a>
              )}
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
              <dt>Server URL</dt>
              <dd>{status.serverUrl || 'Unknown'}</dd>
              <dt>Device name</dt>
              <dd>{status.deviceName || 'Unknown'}</dd>
              <dt>IMEI</dt>
              <dd>{status.imei || 'Unknown'}</dd>
              <dt>IMSI</dt>
              <dd>{status.imsi || 'Unknown'}</dd>
              <dt>My number</dt>
              {status.phoneNumber ? (
                <dd class="device-info-copy">
                  <span>{status.phoneNumber}</span>
                  <button
                    type="button"
                    class="copy-code-link"
                    aria-label="Copy my number"
                    onClick={() => void copy(status.phoneNumber || '')}
                  >
                    <Copy size={13} aria-hidden="true" />
                  </button>
                </dd>
              ) : (
                <dd>Unknown</dd>
              )}
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
      {notificationsOpen && (
        <div
          class="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setNotificationsOpen(false)
          }}
        >
          <section
            class="dialog notifications-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notifications-title"
          >
            <div class="dialog-icon">
              <Bell size={19} />
            </div>
            <h2 id="notifications-title">Notifications</h2>
            <section class="notification-section" aria-labelledby="browser-notifications-title">
              <div class="notification-section-heading">
                <div>
                  <h3 id="browser-notifications-title">Browser notifications</h3>
                  <p>Get an alert when a new SMS is found during a server refresh.</p>
                </div>
                <span class={`notification-state ${browserNotificationsAllowed ? 'is-on' : ''}`}>
                  <span class={`dot ${browserNotificationsAllowed ? 'green' : 'gray'}`} />
                  {browserNotificationsAllowed
                    ? 'Allowed'
                    : browserNotificationsBlocked
                      ? 'Blocked'
                      : 'Off'}
                </span>
              </div>
              <div class="notification-actions">
                <button
                  type="button"
                  class="secondary notification-enable"
                  disabled={
                    !browserNotificationsAvailable ||
                    browserNotificationsAllowed ||
                    browserNotificationsBlocked
                  }
                  onClick={() => void enableBrowserNotifications()}
                >
                  {browserNotificationsBlocked
                    ? 'Allow notifications in browser settings'
                    : browserNotificationsAllowed
                      ? 'Browser notifications enabled'
                      : browserNotificationsAvailable
                        ? 'Enable browser notifications'
                        : 'Browser notifications unavailable'}
                </button>
                <button
                  type="button"
                  class="secondary notification-test"
                  disabled={!browserNotificationsAllowed}
                  onClick={sendTestBrowserNotification}
                >
                  Send test notification
                </button>
              </div>
            </section>
            <section class="notification-section" aria-labelledby="slack-notifications-title">
              <div class="notification-section-heading">
                <div>
                  <h3 id="slack-notifications-title">Slack</h3>
                  <p>
                    {status?.slackEnabled
                      ? 'Slack forwarding is enabled.'
                      : 'Slack forwarding is disabled.'}
                  </p>
                </div>
                <span class={`notification-state ${status?.slackEnabled ? 'is-on' : ''}`}>
                  <span class={`dot ${status?.slackEnabled ? 'green' : 'gray'}`} />
                  {status?.slackEnabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
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
            </section>
            <div class="dialog-actions">
              <button type="button" class="secondary" onClick={() => setNotificationsOpen(false)}>
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
        <div
          class="reboot-backdrop"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="reboot-progress-title"
          aria-describedby="reboot-progress-description"
        >
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
