import {
  apiCredential,
  clearApiCredential,
  isApiClient,
  useApiKey,
  useChatGPT,
} from './api-client.js';
import {
  claudeCredential,
  configureClaude,
  useLocalClaude,
} from './claude-connection.js';
import { credentialVault } from './credential-vault.js';

const active = (ai) =>
  ai === 'claude' ? claudeCredential() : apiCredential(ai);

export function credentialSession(root) {
  const vault = credentialVault(root);
  const loaded = new Set();
  const verifiedProviders = new Set();
  const pending = new Map();

  function restore(ai) {
    if (!ai || loaded.has(ai)) return;
    if (ai !== 'claude' && !isApiClient(ai)) return;
    const record = vault.load(ai);
    if (record?.kind === 'claude' && ai === 'claude') configureClaude(record);
    if (record?.kind === 'chatgpt' && ai === 'openai') {
      const { accessToken, expiresAt } = record;
      useChatGPT({ accessToken, expiresAt });
    }
    if (record?.kind === 'api-key' && isApiClient(ai))
      useApiKey(ai, record.key, record.base);
    loaded.add(ai);
  }

  function flush() {
    for (const [ai, change] of pending) {
      if (change.verified && vault.save(ai, change.value)) pending.delete(ai);
    }
  }

  function changed(ai) {
    loaded.add(ai);
    verifiedProviders.delete(ai);
    const value = active(ai);
    if (value) pending.set(ai, { value, verified: false });
  }

  function verified(ai) {
    verifiedProviders.add(ai);
    const change = pending.get(ai);
    if (change) {
      change.verified = true;
      flush();
    }
  }

  function invalid(ai) {
    const credential = active(ai);
    if (credential) vault.clear(ai, credential);
    pending.delete(ai);
    verifiedProviders.delete(ai);
    if (ai === 'claude') useLocalClaude();
    else clearApiCredential(ai);
  }

  async function run(ai, task) {
    restore(ai);
    try {
      return await task();
    } catch (error) {
      if (error.code === 'AUTH_INVALID') invalid(ai);
      throw error;
    }
  }

  return {
    restore,
    changed,
    verified,
    isVerified: (ai) => verifiedProviders.has(ai),
    flush,
    run,
    localClaude() {
      pending.delete('claude');
      verifiedProviders.delete('claude');
      loaded.add('claude');
      useLocalClaude();
    },
  };
}
