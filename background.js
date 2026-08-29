import {DEFAULTS, DEFAULT_ACTIONS, enabledActions, getSettings} from './shared.js';

const PROVIDER_NAMES = {
  ollama: 'Ollama', groq: 'Groq', cloudflare: 'Cloudflare Workers AI', bai: 'B.AI', gemini: 'Gemini', openrouter: 'OpenRouter',
  cerebras: 'Cerebras', openai: 'OpenAI', vercel: 'Vercel AI Gateway',
};

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

function normaliseOllamaUrl(value) {
  const raw = String(value || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Ollama server URL is invalid. Use a URL such as http://127.0.0.1:11434.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('Ollama server URL must start with http:// or https://.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Ollama server URL must not include a query string or fragment.');
  }
  return parsed.href.replace(/\/+$/, '');
}

function ollamaOrigin(value) {
  try { return new URL(normaliseOllamaUrl(value)).origin; } catch { return new URL(DEFAULT_OLLAMA_URL).origin; }
}

function setupOllamaOriginRewrite() {
  if (!browser.webRequest?.onBeforeSendHeaders) return;
  const configured = {value: DEFAULT_OLLAMA_URL};
  const extensionBase = `${new URL(browser.runtime.getURL('/')).origin}/`;
  const requestFilter = {
    urls: [
      'http://127.0.0.1/*', 'https://127.0.0.1/*',
      'http://localhost/*', 'https://localhost/*',
      'http://[::1]/*', 'https://[::1]/*',
    ],
  };

  const updateConfiguredUrl = value => {
    try { configured.value = normaliseOllamaUrl(value); } catch { configured.value = DEFAULT_OLLAMA_URL; }
  };
  browser.storage.local.get({ollamaUrl: DEFAULT_OLLAMA_URL})
    .then(values => updateConfiguredUrl(values.ollamaUrl))
    .catch(() => {});
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ollamaUrl) updateConfiguredUrl(changes.ollamaUrl.newValue);
  });

  try {
    browser.webRequest.onBeforeSendHeaders.addListener(
      details => {
        let targetOrigin;
        try { targetOrigin = new URL(details.url).origin; } catch { return {}; }
        if (targetOrigin !== ollamaOrigin(configured.value)) return {};

        // Follow Page Assist's Firefox implementation: rewrite only requests
        // initiated by this extension, never a web page using localhost.
        const extensionRequest = details.originUrl?.startsWith(extensionBase)
          || details.documentUrl?.startsWith(extensionBase)
          || (details.tabId === -1 && !details.originUrl);
        if (!extensionRequest) return {};

        const headers = details.requestHeaders || [];
        let changed = false;
        for (const header of headers) {
          if (header.name.toLowerCase() === 'origin') {
            header.value = targetOrigin;
            changed = true;
          }
        }
        if (changed) {
          console.info(`Plyph Ollama CORS fix: ${details.method} ${details.url} Origin → ${targetOrigin}`);
        }
        return {requestHeaders: headers};
      },
      requestFilter,
      ['blocking', 'requestHeaders']
    );
    console.info('Plyph Ollama CORS fix installed (Firefox webRequest).');
  } catch (error) {
    console.warn('Plyph could not install the Ollama origin rewrite:', error);
  }
}
setupOllamaOriginRewrite();

let menuBuild = Promise.resolve();

browser.runtime.onInstalled.addListener(() => {
  initializeExtension().catch(error => {
    console.error('Could not initialize Plyph:', error);
  });
});

async function initializeExtension() {
  await removeLegacyPageControls();
  const current = await browser.storage.local.get(null);
  if (!Object.keys(current).length) {
    await browser.storage.local.set({...DEFAULTS, defaultActionsSeeded: true});
  } else if (!current.defaultActionsSeeded) {
    const actions = Array.isArray(current.customActions) ? current.customActions : [];
    const actionIds = new Set(actions.map(action => action.id));
    await browser.storage.local.set({
      customActions: [
        ...actions,
        ...DEFAULT_ACTIONS.filter(action => !actionIds.has(action.id)),
      ],
      defaultActionsSeeded: true,
    });
  }
  const migration = {};
  if (current.models?.ollama === 'qwen3:4b') {
    migration.models = {...current.models, ollama: DEFAULTS.models.ollama};
  }
  if (current.apiKeys?.ollama) {
    migration.apiKeys = {...current.apiKeys};
    delete migration.apiKeys.ollama;
  }
  if (Object.keys(migration).length) await browser.storage.local.set(migration);
  scheduleMenuRebuild();
}

async function removeLegacyPageControls() {
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(tabs
    .filter(tab => tab.id)
    .map(tab => browser.scripting.executeScript({
      target: {tabId: tab.id},
      func: () => {
        document.getElementById('plyph-trigger')?.remove();
        document.getElementById('plyph-host')?.remove();
        document.getElementById('plyph-toast')?.remove();
      },
    })));
}

browser.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local') return;
  scheduleMenuRebuild();
  broadcastPageConfig().catch(error => console.error('Could not update page controls:', error));
});

async function broadcastPageConfig() {
  const settings = await getSettings();
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(tabs
    .filter(tab => tab.id)
    .map(tab => browser.tabs.sendMessage(tab.id, {
      type: 'SET_PAGE_CONFIG',
      customActions: settings.customActions,
      selectionTrigger: settings.selectionTrigger,
      feedbackPlacement: settings.feedbackPlacement,
    })));
}

function scheduleMenuRebuild() {
  menuBuild = menuBuild.then(rebuildMenus).catch(error => console.error('Could not rebuild Plyph menus:', error));
  return menuBuild;
}

async function rebuildMenus() {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({id: 'plyph-root', title: 'Plyph', contexts: ['selection', 'editable']});
  browser.contextMenus.create({id: 'correct', parentId: 'plyph-root', title: 'Correct selected text', contexts: ['selection', 'editable']});
  browser.contextMenus.create({id: 'rewrite', parentId: 'plyph-root', title: 'Rewrite selected text', contexts: ['selection', 'editable']});
  browser.contextMenus.create({id: 'prompt', parentId: 'plyph-root', title: 'Run selected prompt', contexts: ['selection', 'editable']});
  const settings = await getSettings();
  for (const action of enabledActions(settings)) {
    browser.contextMenus.create({id: `custom:${action.id}`, parentId: 'plyph-root', title: action.name, contexts: ['selection', 'editable']});
  }
}

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'plyph-root') return;
  const action = info.menuItemId.startsWith('custom:')
    ? {mode: 'custom', actionId: info.menuItemId.slice(7)}
    : {mode: info.menuItemId};
  runOnTab(tab.id, action, info.selectionText || '').catch(error => showError(tab.id, error));
});

browser.commands.onCommand.addListener(command => {
  runCommand(command).catch(error => console.error('Could not run Plyph command:', error));
});

async function runCommand(command) {
  const [tab] = await browser.tabs.query({active: true, currentWindow: true});
  if (!tab?.id) return;
  try {
    await runOnTab(tab.id, {mode: command === 'run-prompt' ? 'prompt' : command});
  } catch (error) {
    await showError(tab.id, error);
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'RUN_ACTION') {
    return handleActionRequest(message.tabId, message.action);
  }
  if (message.type === 'RUN_ACTION_FROM_PAGE') {
    const tabId = sender.tab?.id;
    return handleActionRequest(tabId, message.action, message.text || '');
  }
  return false;
});

async function handleActionRequest(tabId, action, fallbackText = '') {
  try {
    await runOnTab(tabId, action, fallbackText);
    return {ok: true};
  } catch (error) {
    await showError(tabId, error);
    return {ok: false, error: error.message || String(error)};
  }
}

async function ensureContent(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, {type: 'PING'});
  } catch {
    await browser.scripting.executeScript({target: {tabId}, files: ['page-controller.js']});
  }
}

async function runOnTab(tabId, actionRequest, fallbackText = '') {
  if (!tabId) throw new Error('No active tab.');
  await ensureContent(tabId);
  const capture = await browser.tabs.sendMessage(tabId, {type: 'CAPTURE_SELECTION'});
  const text = capture?.text || fallbackText;
  if (!text?.trim()) throw new Error('Select text first.');
  await browser.tabs.sendMessage(tabId, {type: 'WORKING'});
  const settings = await getSettings();
  const action = resolveAction(settings, actionRequest);
  const output = await transform(text, action, settings);
  const label = action.mode === 'rewrite' ? 'Rewritten' : action.inputMode === 'prompt' ? 'Generated' : 'Corrected';
  const actionName = action.name?.trim() || label;
  const provider = action.provider || settings.provider;
  const model = action.model || settings.models[provider];
  try {
    await recordHistory({
      ts: Date.now(),
      action: action.mode,
      actionName,
      inputMode: action.inputMode,
      input: text,
      output,
      provider,
      model,
    });
  } catch (error) {
    // A full or unavailable history store must not discard an otherwise successful result.
    console.error('Could not save Plyph history:', error);
  }
  await browser.tabs.sendMessage(tabId, {
    type: settings.previewResults ? 'SHOW_RESULT' : 'REPLACE_RESULT',
    output,
    label,
  });
}

const MAX_HISTORY_CHARS = 20000;
let historyWriteQueue = Promise.resolve();

function recordHistory(entry) {
  // Serialize read-modify-write operations so two quick actions cannot overwrite each other.
  const write = historyWriteQueue.then(() => writeHistory(entry));
  historyWriteQueue = write.catch(() => {});
  return write;
}

async function writeHistory(entry) {
  const stored = await browser.storage.local.get({history: [], historyLimit: 50, historyEnabled: DEFAULTS.historyEnabled});
  // Saving page text and AI output is opt-in. Existing users who explicitly enabled it keep that choice.
  if (stored.historyEnabled !== true) return;
  const limit = Math.min(500, positiveInt(stored.historyLimit) || 50);
  const list = Array.isArray(stored.history) ? stored.history : [];
  const trimmed = {
    ...entry,
    id: `h_${entry.ts}_${Math.random().toString(36).slice(2, 8)}`,
    input: String(entry.input || '').slice(0, MAX_HISTORY_CHARS),
    output: String(entry.output || '').slice(0, MAX_HISTORY_CHARS),
  };
  const updated = [trimmed, ...list].slice(0, limit);
  // Keep history comfortably below Firefox's default storage.local quota even at the 500-entry limit.
  while (updated.length > 1 && JSON.stringify(updated).length > 3500000) updated.pop();

  // Retry with fewer entries if existing unrelated extension data leaves less quota than expected.
  for (let count = updated.length; count > 0; count -= 1) {
    try {
      await browser.storage.local.set({history: updated.slice(0, count)});
      return;
    } catch (error) {
      if (count === 1) throw error;
    }
  }
}

async function showError(tabId, error) {
  if (!tabId) return;
  try {
    await ensureContent(tabId);
    await browser.tabs.sendMessage(tabId, {type: 'SHOW_ERROR', message: error.message || String(error)});
  } catch { /* Firefox blocks extension scripts on internal pages. */ }
}

function resolveAction(settings, request) {
  if (request.mode === 'custom') {
    const item = enabledActions(settings).find(action => action.id === request.actionId);
    if (!item) throw new Error('That custom action no longer exists.');
    return {...item, mode: 'custom', inputMode: item.inputMode === 'prompt' ? 'prompt' : 'transform'};
  }
  if (request.mode === 'prompt') return {...settings.promptOptions, mode: 'prompt', inputMode: 'prompt', prompt: settings.prompts.prompt};
  const mode = request.mode === 'rewrite' ? 'rewrite' : 'correct';
  return {mode, inputMode: 'transform', prompt: settings.prompts[mode], provider: '', model: '', inputLimit: 0, outputLimit: 0};
}

function estimateTokens(text) { return Math.ceil(text.length / 4); }
function maxTokens(text, value = 0) { return positiveInt(value) || Math.min(2000, Math.max(220, estimateTokens(text) + 180)); }
function positiveInt(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0; }
function payload(text) { return `Transform only the text inside the tags.\nReturn only the transformed text.\n<text>\n${text}\n</text>`; }
function isCloudflareQwenReasoningModel(provider, model) {
  return provider === 'cloudflare' && /^@cf\/qwen\/qwen3(?:[.-]|$)/.test(model || '');
}

function expandPrompt(prompt, text, variables) {
  const values = {...variables, selection: text};
  return (prompt || '').replace(/\$\{(selection|language|tone|style)\}/g, (_match, name) => values[name] || '');
}

function cleanOutput(text, inputMode) {
  let output = text.trim();
  if (inputMode === 'prompt') return output;
  const tagged = output.match(/^<text>\s*([\s\S]*?)\s*<\/text>$/i);
  if (tagged) output = tagged[1].trim();
  const fenced = output.match(/^```(?:text)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenced ? fenced[1].trim() : output;
}

async function requestJson(url, headers, body, provider, model) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...headers},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw new Error(`Could not connect to ${PROVIDER_NAMES[provider]}. Check your connection.`);
  }
  let data = {};
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const directError = data?.error?.message || data?.error;
    const errors = Array.isArray(data?.errors)
      ? data.errors.map(item => item?.message || item).filter(item => typeof item === 'string').join(' ')
      : '';
    const detail = typeof directError === 'string' ? directError : errors;
    if (provider === 'ollama' && (response.status === 401 || response.status === 403)) {
      try {
        const headersList = [...response.headers.entries()].map(([key, value]) => `${key}: ${value}`).join(' | ');
        console.error('Plyph Ollama request failed:', {url, status: response.status, headers: headersList, body: data});
      } catch (error) {
        console.error('Plyph could not log the Ollama failure details:', error);
      }
    }
    if (response.status === 401 || response.status === 403) {
      if (provider === 'ollama') {
        const server = response.headers.get('server') || response.headers.get('via') || '';
        const isOllamaCors = !server && !detail && !response.headers.get('content-type');
        if (isOllamaCors) {
          // Ollama rejects the extension's moz-extension:// origin with a 403
          // unless the Origin header matches its OLLAMA_ORIGINS allow-list.
          // The extension rewrites Origin on the way out, so reaching this
          // error means the rewrite did not apply (stale extension, or a
          // custom Ollama URL outside 127.0.0.1/localhost).
          throw new Error(`Ollama rejected the request with a ${response.status} because of its cross-origin (CORS) check. The extension rewrites the Origin header automatically for 127.0.0.1 and localhost — reload the extension so this takes effect. If your Ollama runs on another host, add its origin to Ollama's OLLAMA_ORIGINS environment variable (e.g. OLLAMA_ORIGINS=* ) and restart Ollama.`);
        }
        throw new Error(`Ollama request was rejected with a ${response.status} (to ${url}).${server ? ` The response is from “${server}”, not from Ollama itself.` : ''}${detail ? ` ${detail}` : ''} A proxy, firewall, or another service is answering for that address — verify nothing else listens on port 11434 and that 127.0.0.1 and localhost are in your proxy's “No proxy for” list.`);
      }
      throw new Error(provider === 'cloudflare'
        ? 'Cloudflare rejected the API token or Account ID. Check them in Settings.'
        : `${PROVIDER_NAMES[provider]} rejected the API key. Check it in Settings.`);
    }
    if (response.status === 404) throw new Error(provider === 'cloudflare'
      ? `Cloudflare could not find the account or model “${model}”.`
      : `${PROVIDER_NAMES[provider]} could not find model “${model}”.`);
    if (response.status === 429) throw new Error(`${PROVIDER_NAMES[provider]} rate limit reached. Wait and try again.`);
    throw new Error(detail || `${PROVIDER_NAMES[provider]} rejected the request (${response.status}).`);
  }
  return data;
}

async function transform(text, action, settings) {
  const inputLimit = positiveInt(action.inputLimit);
  const estimate = estimateTokens(text);
  if (inputLimit && estimate > inputLimit) throw new Error(`Selected text is about ${estimate} tokens, above this action's ${inputLimit}-token input limit.`);
  const provider = action.provider || settings.provider;
  const model = action.model || settings.models[provider];
  const prompt = expandPrompt(action.prompt, text, settings.variables);
  const userText = action.inputMode === 'prompt' ? text : payload(text);
  const messages = [...(prompt.trim() ? [{role: 'system', content: prompt}] : []), {role: 'user', content: userText}];
  const requestedOutputLimit = positiveInt(action.outputLimit);
  let limit = maxTokens(text, requestedOutputLimit || (action.inputMode === 'prompt' ? 2000 : 0));
  const cloudflareReasoningModel = isCloudflareQwenReasoningModel(provider, model);
  const cloudflareReasoningEnabled = cloudflareReasoningModel && settings.cloudflareReasoningEnabled === true;
  // Reasoning tokens count against the output ceiling. Preserve explicit limits while
  // giving enabled reasoning enough automatic headroom to reach the visible response.
  if (cloudflareReasoningEnabled && !requestedOutputLimit) limit = Math.max(limit, 600);
  let data;
  if (provider === 'ollama') {
    const ollamaUrl = normaliseOllamaUrl(settings.ollamaUrl);
    data = await requestJson(`${ollamaUrl}/api/chat`, {}, {model, messages, stream: false, options: {num_predict: limit}}, provider, model);
    if (data.done_reason === 'length') throw new Error('Response reached the output limit. Increase the limit or select less text.');
    if (!data.message?.content) throw new Error('Ollama returned an empty response.');
    return cleanOutput(data.message.content, action.inputMode);
  }
  const key = settings.apiKeys[provider];
  if (!key) throw new Error(provider === 'cloudflare'
    ? 'Add a Cloudflare Workers AI API token in Settings.'
    : `Add a ${PROVIDER_NAMES[provider]} API key in Settings.`);
  if (provider === 'gemini') {
    const body = {contents: [{role: 'user', parts: [{text: userText}]}], generationConfig: {maxOutputTokens: limit}};
    if (prompt.trim()) body.systemInstruction = {parts: [{text: prompt}]};
    data = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {}, body, provider, model);
    if (data.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw new Error('Response reached the output limit. Increase the limit or select less text.');
    const output = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
    if (!output) throw new Error('Gemini returned an empty response.');
    return cleanOutput(output, action.inputMode);
  }
  let cloudflareAccountId = '';
  if (provider === 'cloudflare') {
    cloudflareAccountId = String(settings.cloudflareAccountId || '').trim();
    if (!cloudflareAccountId) throw new Error('Add your Cloudflare Account ID in Settings.');
  }
  const urls = {
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    cloudflare: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cloudflareAccountId)}/ai/v1/chat/completions`,
    bai: 'https://api.b.ai/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    cerebras: 'https://api.cerebras.ai/v1/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions',
    vercel: 'https://ai-gateway.vercel.sh/v1/chat/completions',
  };
  const body = {model, messages, [provider === 'cerebras' ? 'max_completion_tokens' : 'max_tokens']: limit};
  if (cloudflareReasoningModel) body.chat_template_kwargs = {enable_thinking: cloudflareReasoningEnabled};
  if (provider === 'groq' && model.startsWith('openai/gpt-oss-')) Object.assign(body, {reasoning_effort: 'low', include_reasoning: false});
  data = await requestJson(urls[provider], {
    Authorization: `Bearer ${key}`,
    ...(provider === 'cloudflare' ? {'cf-aig-gateway-id': 'default'} : {}),
    ...(provider === 'openrouter' ? {'X-Title': 'Plyph'} : {}),
  }, body, provider, model);
  if (data.choices?.[0]?.finish_reason === 'length') throw new Error('Response reached the output limit. Increase the limit or select less text.');
  const message = data.choices?.[0]?.message;
  // Cloudflare currently places Qwen's non-thinking final text in the reasoning
  // compatibility field. Use it only when reasoning was explicitly disabled.
  const output = message?.content || (!cloudflareReasoningEnabled && cloudflareReasoningModel
    ? message?.reasoning_content || message?.reasoning
    : '');
  if (!output) throw new Error(`${PROVIDER_NAMES[provider]} returned an empty response.`);
  return cleanOutput(output, action.inputMode);
}
