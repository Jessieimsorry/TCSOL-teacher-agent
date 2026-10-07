import { type Provider, type AgentConfig } from '../shared/types.ts';
import type { Store } from './store.ts';
export function endpoint(p: Provider, suffix: string) {
  const base = p.baseUrl.replace(/\/+$/, '');
  if (p.type === 'anthropic' && !base.endsWith('/v1')) return base + '/v1/' + suffix;
  if (p.type === 'ollama') return base.replace(/\/api$/, '') + '/api/' + suffix;
  return base + '/' + suffix;
}
async function checkedFetch(url: string, init: RequestInit, signal: AbortSignal) {
  let response: Response;
  try { response = await fetch(url, { ...init, signal }); } catch (e) {
    if (signal.aborted) throw new Error('请求已取消或超时。');
    throw new Error('无法连接模型服务，请检查地址与网络。');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('模型服务拒绝认证，请检查密钥和权限。');
    if (response.status === 429) throw new Error('模型服务限流或额度不足，请稍后重试。');
    throw new Error(`模型服务返回 HTTP ${response.status}，请检查模型名称与接口配置。`);
  }
  return response.json();
}
export async function generate(store: Store, provider: Provider, config: AgentConfig, system: string, user: string, signal: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(config.timeoutSeconds * 1000);
  const combined = AbortSignal.any([signal, timeout]);
  const key = store.decrypt(provider.secret);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: any, route: string;
  if (provider.type === 'anthropic') {
    headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
    route = 'messages'; body = { model: config.model, max_tokens: config.maxTokens, system, messages: [{ role: 'user', content: user }] };
    if (config.temperature !== undefined && provider.supportsTemperature !== false) body.temperature = config.temperature;
  } else if (provider.type === 'ollama') {
    route = 'chat'; body = { model: config.model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], options: { num_predict: config.maxTokens } };
    if (config.temperature !== undefined && provider.supportsTemperature !== false) body.options.temperature = config.temperature;
    if (key) headers.Authorization = `Bearer ${key}`;
  } else {
    route = 'chat/completions'; headers.Authorization = `Bearer ${key}`;
    body = { model: config.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    const lengthField = provider.tokenParameter || 'max_tokens'; if (lengthField !== 'none') body[lengthField] = config.maxTokens;
    if (config.temperature !== undefined && provider.supportsTemperature !== false) body.temperature = config.temperature;
  }
  const data = await checkedFetch(endpoint(provider, route), { method: 'POST', headers, body: JSON.stringify(body) }, combined);
  const content = provider.type === 'anthropic' ? data.content?.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n') : provider.type === 'ollama' ? data.message?.content : data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回可用文字。');
  return content;
}
export async function listModels(store: Store, p: Provider) {
  const key = store.decrypt(p.secret), headers: Record<string, string> = {};
  if (p.type === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
  else if (key) headers.Authorization = `Bearer ${key}`;
  const data = await checkedFetch(endpoint(p, p.type === 'ollama' ? 'tags' : 'models'), { headers }, AbortSignal.timeout(15000));
  return p.type === 'ollama' ? (data.models || []).map((x: any) => x.name) : (data.data || []).map((x: any) => x.id);
}
