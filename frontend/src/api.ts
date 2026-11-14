export type SMS = { id: string; sender: string; text: string; receivedAt: string; read: boolean }
export type Status = { connected: boolean; lastSync: string | null; error?: string; messageCount: number }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `Request failed (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}
export const api = {
  session: () => request<{ authenticated: boolean }>('/api/auth/session'),
  login: (username: string, password: string) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  inbox: () => request<{ messages: SMS[]; status: Status }>('/api/sms'),
  message: (id: string) => request<SMS>(`/api/sms/${encodeURIComponent(id)}`),
  delete: (id: string) => request<void>(`/api/sms/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
