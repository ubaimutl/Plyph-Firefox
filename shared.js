export const PROVIDERS = [
  {id: 'ollama', name: 'Ollama (local)'},
  {id: 'chatgpt', name: 'ChatGPT Account'},
  {id: 'groq', name: 'Groq'},
  {id: 'cloudflare', name: 'Cloudflare Workers AI'},
  {id: 'bai', name: 'B.AI'},
  {id: 'deepseek', name: 'DeepSeek'},
  {id: 'gemini', name: 'Gemini'},
  {id: 'openrouter', name: 'OpenRouter'},
  {id: 'cerebras', name: 'Cerebras'},
  {id: 'openai', name: 'OpenAI'},
  {id: 'vercel', name: 'Vercel AI Gateway'},
  {id: 'custom_openai', name: 'Custom OpenAI-Compatible'},
];

export const TOOLBAR_BUILTINS = [
  {id: 'ask', name: 'Ask', mode: 'ask'},
  {id: 'correct', name: 'Correct', mode: 'correct'},
  {id: 'rewrite', name: 'Rewrite', mode: 'rewrite'},
  {id: 'prompt', name: 'Run selected prompt', mode: 'prompt'},
];

export const TOOLBAR_LIMIT = 4;

export const DEFAULT_TOOLBAR_ACTIONS = ['ask', 'correct', 'rewrite', 'prompt'];

export function normalizeToolbarActions(value, customActions = []) {
  if (!Array.isArray(value) || !value.length) return [...DEFAULT_TOOLBAR_ACTIONS];
  const known = new Set([
    ...TOOLBAR_BUILTINS.map(item => item.id),
    ...(Array.isArray(customActions) ? customActions : []).map(action => action?.id).filter(Boolean),
  ]);
  return value.filter(id => typeof id === 'string' && known.has(id)).slice(0, TOOLBAR_LIMIT);
}

export function resolveToolbarActions(ids, customActions = []) {
  const enabled = (Array.isArray(customActions) ? customActions : [])
    .filter(action => action?.enabled !== false && action?.name?.trim());
  return (Array.isArray(ids) ? ids : []).slice(0, TOOLBAR_LIMIT).map(id => {
    const builtin = TOOLBAR_BUILTINS.find(item => item.id === id);
    if (builtin) return {id, name: builtin.name, mode: builtin.mode};
    const custom = enabled.find(action => action.id === id);
    if (custom) return {id, name: custom.name, mode: 'custom', actionId: custom.id};
    return null;
  });
}

export const DEFAULT_ACTIONS = [
  {
    id: 'default-professional-email',
    name: 'Professional email',
    prompt: 'Rewrite the selected text as a polished professional email. Preserve all facts and intent. Return only the email.',
    enabled: true, provider: '', model: '', inputMode: 'transform', inputLimit: 0, outputLimit: 0, outputFormat: 'auto',
  },
  {
    id: 'default-summarize',
    name: 'Summarize clearly',
    prompt: 'Summarize the selected text clearly and concisely. Keep the important facts and return only the summary.',
    enabled: true, provider: '', model: '', inputMode: 'transform', inputLimit: 0, outputLimit: 0, outputFormat: 'auto',
  },
  {
    id: 'default-translate',
    name: 'Translate to preferred language',
    prompt: 'Translate the selected text into ${language}. Preserve its meaning, tone, and formatting. Return only the translation.',
    enabled: true, provider: '', model: '', inputMode: 'transform', inputLimit: 0, outputLimit: 0, outputFormat: 'auto',
  },
  {
    id: 'default-explain',
    name: 'Explain simply',
    prompt: 'Explain the selected text in simple, clear language. Keep the answer concise and accurate.',
    enabled: true, provider: '', model: '', inputMode: 'transform', inputLimit: 0, outputLimit: 0, outputFormat: 'auto',
  },
];

export const DEFAULTS = {
  provider: 'groq',
  ollamaUrl: 'http://127.0.0.1:11434',
  customOpenAiUrl: '',
  cloudflareAccountId: '',
  cloudflareReasoningEnabled: false,
  chatgptAccountId: '',
  chatgptThinkingEffort: 'auto',
  chatgptWelcomeShown: false,
  models: {
    ollama: 'qwen2.5-coder:1.5b', groq: 'openai/gpt-oss-120b',
    cloudflare: '@cf/qwen/qwen3-30b-a3b-fp8', bai: 'deepseek-v4-flash',
    deepseek: 'deepseek-v4-flash',
    gemini: 'gemini-3.5-flash-lite', openrouter: 'openrouter/free',
    cerebras: 'gpt-oss-120b', openai: 'gpt-4.1-mini',
    vercel: 'openai/gpt-5.4-mini', custom_openai: '', chatgpt: '',
  },
  apiKeys: {},
  apiKeyVault: null,
  prompts: {
    correct: 'Correct grammar, spelling, punctuation, clarity, and style. Preserve the language, meaning, and tone. Return only the corrected text, unchanged if already correct.',
    rewrite: 'Rewrite for clarity and natural flow. Preserve the language, meaning, and tone. Add no ideas or commentary. Return only the improved text.',
    prompt: 'Follow the provided instruction precisely. Produce the requested result directly. Do not add introductory commentary unless requested.',
  },
  variables: {language: 'English', tone: 'professional', style: 'clear and concise'},
  promptOptions: {provider: '', model: '', inputLimit: 0, outputLimit: 0, outputFormat: 'auto'},
  customActions: DEFAULT_ACTIONS,
  toolbarActions: [...DEFAULT_TOOLBAR_ACTIONS],
  previewResults: true,
  previewShowChanges: false,
  selectionTrigger: true,

  historyEnabled: false,
  history: [],
  historyLimit: 50,
  feedbackPlacement: 'bottom',
  defaultActionsSeeded: false,
};

const API_KEY_SESSION = 'apiKeyVaultSession';
const VAULT_ITERATIONS = 250000;

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function deriveVaultKey(password, salt, extractable = false, iterations = VAULT_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {name: 'PBKDF2', hash: 'SHA-256', salt, iterations},
    material,
    {name: 'AES-GCM', length: 256},
    extractable,
    ['encrypt', 'decrypt'],
  );
}

async function importVaultKey(rawKey) {
  return crypto.subtle.importKey('raw', base64ToBytes(rawKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptApiKeys(apiKeys, key, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(apiKeys || {}));
  const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, plaintext);
  return {
    version: 1,
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2-SHA-256',
    iterations: VAULT_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptApiKeys(vault, key) {
  const plaintext = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: base64ToBytes(vault.iv)},
    key,
    base64ToBytes(vault.ciphertext),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export async function enableApiKeyVault(apiKeys, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveVaultKey(password, salt, true);
  const rawKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
  const vault = await encryptApiKeys(apiKeys, key, salt);
  await browser.storage.session.set({[API_KEY_SESSION]: {apiKeys: {...apiKeys}, rawKey}});
  await browser.storage.local.set({apiKeyVault: vault});
  await browser.storage.local.remove('apiKeys');
  return vault;
}

export async function unlockApiKeyVault(vault, password) {
  if (!vault?.salt || !vault?.iv || !vault?.ciphertext) throw new Error('The encrypted API-key vault is invalid.');
  const salt = base64ToBytes(vault.salt);
  const key = await deriveVaultKey(password, salt, true, Number(vault.iterations) || VAULT_ITERATIONS);
  let apiKeys;
  try {
    apiKeys = await decryptApiKeys(vault, key);
  } catch {
    throw new Error('Incorrect vault password.');
  }
  const rawKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
  delete apiKeys.ollama;
  await browser.storage.session.set({[API_KEY_SESSION]: {apiKeys, rawKey}});
  return apiKeys;
}

export async function lockApiKeyVault() {
  await browser.storage.session.remove(API_KEY_SESSION);
}

export async function disableApiKeyVault(apiKeys) {
  await browser.storage.local.set({apiKeys: {...apiKeys}, apiKeyVault: null});
  await browser.storage.session.remove(API_KEY_SESSION);
}

export async function resetApiKeyVault() {
  await browser.storage.local.set({apiKeys: {}, apiKeyVault: null});
  await browser.storage.session.remove(API_KEY_SESSION);
}

export async function saveSettings(settings) {
  const saved = {...settings};
  delete saved.vaultLocked;
  if (saved.apiKeyVault) {
    const session = (await browser.storage.session.get(API_KEY_SESSION))[API_KEY_SESSION];
    if (session?.rawKey) {
      const key = await importVaultKey(session.rawKey);
      const salt = base64ToBytes(saved.apiKeyVault.salt);
      saved.apiKeyVault = await encryptApiKeys(saved.apiKeys, key, salt);
      await browser.storage.session.set({
        [API_KEY_SESSION]: {apiKeys: {...saved.apiKeys}, rawKey: session.rawKey},
      });
    }
    delete saved.apiKeys;
    await browser.storage.local.set(saved);
    await browser.storage.local.remove('apiKeys');
    settings.apiKeyVault = saved.apiKeyVault;
    return;
  }
  await browser.storage.local.set(saved);
}

export async function getSettings() {
  const saved = await browser.storage.local.get(DEFAULTS);
  let apiKeys = {...DEFAULTS.apiKeys, ...(saved.apiKeys || {})};
  let vaultLocked = false;
  if (saved.apiKeyVault) {
    const session = (await browser.storage.session.get(API_KEY_SESSION))[API_KEY_SESSION];
    if (session?.apiKeys) apiKeys = {...session.apiKeys};
    else {
      apiKeys = {};
      vaultLocked = true;
    }
  }

  delete apiKeys.ollama;
  return {
    ...DEFAULTS, ...saved,
    models: {...DEFAULTS.models, ...(saved.models || {})},
    toolbarActions: normalizeToolbarActions(saved.toolbarActions, saved.customActions),
    apiKeys,
    vaultLocked,
    prompts: {...DEFAULTS.prompts, ...(saved.prompts || {})},
    variables: {...DEFAULTS.variables, ...(saved.variables || {})},
    promptOptions: {...DEFAULTS.promptOptions, ...(saved.promptOptions || {})},
  };
}

export function enabledActions(settings) {
  return (settings.customActions || []).filter(action => action.enabled !== false && action.name?.trim());
}

export function isMarkdown(text) {
  const input = String(text || '').trim();
  if (!input || input.length < 3) return false;

  if (/^```[a-z0-9_-]*\s*\n[\s\S]*?\n```$/m.test(input)) return true;

  if (/^\|[^\n|]+\|[^\n|]+\|\s*\n\|(?:\s*:?-+:?\s*\|){2,}/m.test(input)) return true;

  if (/\[[^\n\]]{1,120}\]\(https?:\/\/[^\s\)]+\)/.test(input)) return true;

  let score = 0;

  if (/^#{1,6}\s+[A-Za-z0-9]/m.test(input)) score++;

  if (/^>\s+[A-Za-z0-9]/m.test(input)) score++;

  if (/^(?:[*+-]|\d+\.)\s+\S+.+\n\s*(?:[*+-]|\d+\.)\s+\S+/m.test(input)) score++;

  if (/(?:^|\s)\*\*(?!\s)[^*\n]+(?<!\s)\*\*(?=\s|[.,!?;:)]|$)/.test(input) ||
      /(?:^|\s)__(?!\s)[^_\n]+(?<!\s)__(?=\s|[.,!?;:)]|$)/.test(input)) {
    score++;
  }

  return score >= 2;
}

export function resolveOutputFormat(action, text, effectivePrompt = '') {
  const mode = action?.outputFormat || 'auto';
  if (mode === 'text') return 'text';
  if (mode === 'markdown') return 'markdown';

  const promptStr = String(effectivePrompt || action?.prompt || '').toLowerCase();

  if (/\b(plain\s*text|no\s*markdown|without\s*markdown|remove\s*markdown|strip\s*markdown|unformatted)\b/i.test(promptStr)) {
    return 'text';
  }

  if (/\b(as\s*markdown|in\s*markdown|markdown\s*format|format\s*as\s*md|markdown\s*table|markdown\s*list|markdown\s*code)\b/i.test(promptStr)) {
    return 'markdown';
  }

  if (isMarkdown(text)) {
    return 'preserve-markdown';
  }

  return 'text';
}
