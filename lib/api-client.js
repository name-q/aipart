import { openAIBase } from './chatgpt-auth.js';
import { readResponsesStream, responseText } from './responses-stream.js';

const providers = {
  openai: {
    name: 'OpenAI',
    key: 'OPENAI_API_KEY',
    base: 'OPENAI_BASE_URL',
    url: openAIBase,
    route: '/responses',
  },
  deepseek: {
    name: 'DeepSeek',
    key: 'DEEPSEEK_API_KEY',
    base: 'DEEPSEEK_BASE_URL',
    url: 'https://api.deepseek.com/v1',
    route: '/chat/completions',
  },
};
const sessionKeys = new Map();
let chatgpt;
export const isApiClient = (name) => Object.hasOwn(providers, name);
export const apiKeyName = (name) => providers[name].key;

function apiBase(name, value) {
  const provider = providers[name];
  let url;
  try {
    url = new URL(value ?? (process.env[provider.base] || provider.url));
  } catch {
    throw Error(provider.base + ' 不是有效的 API 地址');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error(provider.base + ' 必须使用 HTTPS，本地回环地址可使用 HTTP');
  return url.href.replace(/\/+$/, '');
}

export function useApiKey(name, key, base) {
  const token = key.trim();
  if (!token || /[\s\p{Cc}]/u.test(token)) throw Error('API Key 格式无效');
  sessionKeys.set(name, {
    kind: 'api-key',
    key: token,
    base: apiBase(name, base),
  });
  if (name === 'openai') chatgpt = undefined;
}

export function apiCredential(name) {
  if (usesChatGPT(name)) return { kind: 'chatgpt', ...chatgpt };
  return sessionKeys.get(name);
}

export function clearApiCredential(name) {
  sessionKeys.delete(name);
  if (name === 'openai') chatgpt = undefined;
}

export function useChatGPT(connection) {
  chatgpt = connection;
}
const usesChatGPT = (name) => name === 'openai' && Boolean(chatgpt);
export function hasCredential(name) {
  return usesChatGPT(name)
    ? chatgpt.expiresAt > Date.now()
    : Boolean(
        (
          sessionKeys.get(name)?.key ?? process.env[providers[name].key]
        )?.trim(),
      );
}
async function call(name, path, body) {
  const provider = providers[name];
  const subscription = usesChatGPT(name);
  const key = subscription
    ? hasCredential(name)
      ? chatgpt.accessToken
      : undefined
    : (sessionKeys.get(name)?.key ?? process.env[provider.key])?.trim();
  if (!key)
    throw Object.assign(
      Error(
        name === 'openai'
          ? '请选择使用 ChatGPT 登录，或设置 OPENAI_API_KEY。'
          : '请设置 ' + provider.key + '，或在菜单输入 API Key。',
      ),
      { code: subscription ? 'AUTH_INVALID' : 'AUTH_REQUIRED' },
    );
  const base = subscription
    ? openAIBase
    : apiBase(name, sessionKeys.get(name)?.base);
  const url = new URL(base + path);
  let response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + key,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(body ? 90000 : 12000),
      redirect: 'error',
    });
  } catch (error) {
    if (error.name === 'TimeoutError')
      throw Object.assign(
        Error(provider.name + ' 请求超时，可以切换工具后继续。'),
        { code: 'SCAN_TIMEOUT' },
      );
    throw Error(
      subscription
        ? '无法连接 OpenAI 官方 API，请检查网络。'
        : provider.name + ' API 连接失败，请检查网络和 ' + provider.base + '。',
    );
  }
  if (response.status === 401 || response.status === 403)
    throw Object.assign(
      Error(
        subscription
          ? 'ChatGPT 登录已失效或未获得订阅授权，请重新登录。'
          : provider.name + ' API 拒绝访问，请检查 API Key 和项目权限。',
      ),
      { code: response.status === 401 ? 'AUTH_INVALID' : 'AUTH_REQUIRED' },
    );
  if (response.status === 429)
    throw Error(provider.name + ' API 当前受额度或速率限制。');
  if (body?.stream && response.ok) return readResponsesStream(response.body);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (
      data?.error?.code === 'model_not_found' ||
      (body &&
        /model.*not (?:found|exist|available)|invalid model/i.test(
          data?.error?.message ?? '',
        ))
    )
      throw Object.assign(
        Error(provider.name + ' API 不支持所选模型，请换一个模型。'),
        { code: 'MODEL_UNAVAILABLE' },
      );
    throw Error(
      provider.name + ' API 请求失败（HTTP ' + response.status + '）。',
    );
  }
  return data;
}

export async function apiModels(name) {
  const data = await call(name, '/models');
  if (usesChatGPT(name)) {
    if (!Array.isArray(data?.models))
      throw Error('OpenAI 未返回可用的 ChatGPT 模型目录。');
    return data.models
      .filter((m) => m?.visibility === 'list' && typeof m.slug === 'string')
      .map((m) => ({
        id: m.slug,
        label: typeof m.display_name === 'string' ? m.display_name : m.slug,
      }));
  }
  if (!Array.isArray(data?.data)) throw Error('服务方未返回可用的模型目录。');
  return data.data
    .filter(
      (m) =>
        typeof m?.id === 'string' &&
        !/(?:audio|realtime|embedding|image|transcrib|whisper|\btts\b|moderation|search)/i.test(
          m.id,
        ),
    )
    .sort(
      (a, b) =>
        (b.created ?? 0) - (a.created ?? 0) ||
        b.id.localeCompare(a.id, 'en', { numeric: true }),
    )
    .map((m) => ({ id: m.id, label: m.id }));
}

export async function apiReply(name, model, messages) {
  if (!model) {
    model = (await apiModels(name))[0]?.id;
    if (!model) throw Error('当前 API 未返回可用模型，请指定 --model。');
  }
  const subscription = usesChatGPT(name);
  const body = subscription
    ? { model, input: messages, store: false, stream: true }
    : name === 'openai'
      ? {
          model,
          input: messages,
          store: false,
          text: { format: { type: 'json_object' } },
          max_output_tokens: 4096,
        }
      : {
          model,
          messages,
          response_format: { type: 'json_object' },
          max_tokens: 4096,
        };
  const data = await call(name, providers[name].route, body);
  const text = subscription
    ? data
    : name === 'openai'
      ? responseText(data)
      : data?.choices?.[0]?.message?.content;
  if (!text?.trim())
    throw Error(providers[name].name + ' API 没有返回可读取的文本。');
  return { model, text };
}
