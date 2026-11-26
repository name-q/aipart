const providers = {
  openai: {
    name: 'OpenAI',
    key: 'OPENAI_API_KEY',
    base: 'OPENAI_BASE_URL',
    url: 'https://api.openai.com/v1',
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
export const isApiClient = (name) => Object.hasOwn(providers, name);
export const apiKeyName = (name) => providers[name].key;

export function useApiKey(name, key) {
  const token = key.trim();
  if (!token || /[\s\p{Cc}]/u.test(token)) throw Error('API Key 格式无效');
  sessionKeys.set(name, token);
}

async function call(name, path, body) {
  const provider = providers[name];
  const key = (sessionKeys.get(name) ?? process.env[provider.key])?.trim();
  if (!key)
    throw Object.assign(
      Error('请设置 ' + provider.key + '，或在菜单输入本次使用的 API Key。'),
      { code: 'AUTH_REQUIRED' },
    );
  let url;
  try {
    url = new URL(
      (process.env[provider.base] || provider.url).replace(/\/+$/, '') + path,
    );
  } catch {
    throw Error(provider.base + ' 不是有效的 API 地址');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password
  )
    throw Error(provider.base + ' 必须使用 HTTPS，本地回环地址可使用 HTTP');
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
      provider.name + ' API 连接失败，请检查网络和 ' + provider.base + '。',
    );
  }
  if (response.status === 401 || response.status === 403)
    throw Object.assign(
      Error(provider.name + ' API 拒绝访问，请检查 API Key 和项目权限。'),
      { code: 'AUTH_REQUIRED' },
    );
  if (response.status === 429)
    throw Error(provider.name + ' API 当前受额度或速率限制。');
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
  const ids = Array.isArray(data?.data) ? data.data.map((m) => m?.id) : [];
  return ids
    .filter(
      (id) =>
        typeof id === 'string' &&
        (name !== 'openai' || /^(gpt-|o\d|chatgpt-|codex-)/i.test(id)) &&
        !/(?:audio|realtime|embedding|image|transcrib|whisper|\btts\b|moderation|search)/i.test(
          id,
        ),
    )
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .map((id) => ({ id, label: id }));
}

export async function apiReply(name, model, messages) {
  if (!model) {
    model = (await apiModels(name))[0]?.id;
    if (!model) throw Error('当前 API 未返回可用模型，请指定 --model。');
  }
  const body =
    name === 'openai'
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
  const text =
    name === 'openai'
      ? data?.output
          ?.flatMap((item) => item.content ?? [])
          .filter((part) => part.type === 'output_text')
          .map((part) => part.text)
          .join('')
      : data?.choices?.[0]?.message?.content;
  if (!text?.trim())
    throw Error(providers[name].name + ' API 没有返回可读取的文本。');
  return { model, text };
}
