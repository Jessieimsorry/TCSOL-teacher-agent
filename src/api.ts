export async function api<T = any>(path: string, body?: any, method?: string): Promise<T> {
  const response = await fetch('/api' + path, { method: method || (body === undefined ? 'GET' : 'POST'), ...(body instanceof FormData ? { body } : body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作失败'); return data;
}
export const date = (s: string) => new Date(s).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
