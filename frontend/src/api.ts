export type SMS = {
  id: string
  threadId: string
  sender: string
  senderName?: string
  text: string
  receivedAt: string
  read: boolean
  isOtp: boolean
  otpCodes: string[]
}
export type SlackDelivery = {
  sentAt: string
  sender: string
  receivedAt: string
}
export type Status = {
  connected: boolean
  lastSync: string | null
  error?: string
  messageCount: number
  serverUrl?: string
  phoneNumber?: string
  deviceName?: string
  imei?: string
  imsi?: string
  hardwareVersion?: string
  softwareVersion?: string
  webUIVersion?: string
  lanMacAddress?: string
  wanIpAddress?: string
  storageFull?: boolean
  slackEnabled: boolean
  slackDeliveries?: SlackDelivery[]
}

export class AuthenticationError extends Error {
  constructor(message = 'Authentication required.') {
    super(message)
    this.name = 'AuthenticationError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const message = data.error || `Request failed (${response.status})`
    if (response.status === 401 || message === 'Authentication required.') {
      throw new AuthenticationError(message)
    }
    throw new Error(message)
  }
  if (response.status === 202 || response.status === 204) return undefined as T
  return response.json()
}
export const api = {
  session: () => request<{ authenticated: boolean }>('/api/auth/session'),
  login: (username: string, password: string) =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  inbox: () => request<{ messages: SMS[]; status: Status }>('/api/sms'),
  message: (id: string) => request<SMS>(`/api/sms/${encodeURIComponent(id)}`),
  markRead: (id: string) =>
    request<void>(`/api/sms/${encodeURIComponent(id)}/read`, { method: 'POST' }),
  reboot: () => request<void>('/api/device/reboot', { method: 'POST' }),
  delete: (id: string) => request<void>(`/api/sms/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
