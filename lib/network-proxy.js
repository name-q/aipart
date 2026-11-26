import { execFileSync } from 'node:child_process';
import { EnvHttpProxyAgent } from 'undici';

const localHosts = ['localhost', '127.0.0.1', '[::1]'];
let systemCache;
let cachedDispatcher;

export function parseMacProxy(text) {
  const endpoint = (scheme) => {
    const value = (field) =>
      text.match(
        new RegExp('^\\s*' + scheme + field + '\\s*:\\s*(\\S+)', 'm'),
      )?.[1];
    const port = Number(value('Port'));
    const host = value('Proxy');
    if (
      value('Enable') !== '1' ||
      !host ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      return '';
    try {
      const hostname =
        host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
      const uri = new URL('http://' + hostname + ':' + port);
      return uri.username ||
        uri.password ||
        uri.pathname !== '/' ||
        uri.search ||
        uri.hash
        ? ''
        : uri.origin;
    } catch {
      return '';
    }
  };
  const exceptions =
    text.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/)?.[1] ?? '';
  const noProxy = [...exceptions.matchAll(/^\s*\d+\s*:\s*([^\s/]+)\s*$/gm)]
    .map((entry) => entry[1])
    .join(',');
  return { http: endpoint('HTTP'), https: endpoint('HTTPS'), noProxy };
}

function macProxy() {
  if (process.platform !== 'darwin') return {};
  if (systemCache && Date.now() < systemCache.until)
    return systemCache.settings;
  let settings = {};
  try {
    settings = parseMacProxy(
      execFileSync('/usr/sbin/scutil', ['--proxy'], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {}
  systemCache = { settings, until: Date.now() + 3000 };
  return settings;
}

export function proxyEnvironment(env = process.env) {
  const all = env.all_proxy || env.ALL_PROXY || '';
  const fallback = /^https?:\/\//i.test(all) ? all : '';
  let http = env.http_proxy || env.HTTP_PROXY || fallback;
  let https = env.https_proxy || env.HTTPS_PROXY || fallback;
  let exceptions = env.no_proxy ?? env.NO_PROXY;
  if (!http && !https && !all) {
    const system = macProxy();
    http = system.http;
    https = system.https;
    exceptions ??= system.noProxy;
  }
  if (!http && !https) return env;
  const noProxy =
    exceptions?.trim() === '*'
      ? '*'
      : [...localHosts, exceptions].filter(Boolean).join(',');
  return {
    ...env,
    HTTP_PROXY: http || '',
    http_proxy: http || '',
    HTTPS_PROXY: https || http || '',
    https_proxy: https || http || '',
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

export function fetchWithProxy(url, options) {
  const env = proxyEnvironment();
  const httpProxy = env.http_proxy || env.HTTP_PROXY;
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY;
  const noProxy = env.no_proxy ?? env.NO_PROXY;
  if (
    (!httpProxy && !httpsProxy) ||
    noProxy === '*' ||
    localHosts.includes(new URL(url).hostname)
  )
    return fetch(url, options);
  const key = JSON.stringify([httpProxy, httpsProxy, noProxy]);
  if (cachedDispatcher?.key !== key) {
    const dispatcher = new EnvHttpProxyAgent({
      httpProxy,
      httpsProxy,
      noProxy,
    });
    if (cachedDispatcher)
      void cachedDispatcher.dispatcher.close().catch(() => {});
    cachedDispatcher = { key, dispatcher };
  }
  return fetch(url, { ...options, dispatcher: cachedDispatcher.dispatcher });
}
