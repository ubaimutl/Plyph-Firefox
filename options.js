import {
  PROVIDERS,
  TOOLBAR_BUILTINS,
  TOOLBAR_LIMIT,
  disableApiKeyVault,
  enableApiKeyVault,
  getSettings,
  lockApiKeyVault,
  normalizeToolbarActions,
  resetApiKeyVault,
  saveSettings,
  unlockApiKeyVault,
} from './shared.js';

let settings = await getSettings();
let saveTimer;
const $ = selector => document.querySelector(selector);
const modelCache = new Map();
let chatgptModelControls = null;

for (const select of [$('#provider'), $('#run-provider'), $('#action-provider')]) {
  if (select !== $('#provider')) select.add(new Option('Use active provider', ''));
  for (const provider of PROVIDERS) select.add(new Option(provider.name, provider.id));
}

$('#provider').value = settings.provider;
$('#preview').checked = settings.previewResults;
$('#preview-changes').checked = settings.previewShowChanges === true;
$('#selection-trigger').checked = settings.selectionTrigger;
$('#history-enabled').checked = settings.historyEnabled;
$('#history-limit').value = settings.historyLimit || '';
$('#feedback-placement').value = settings.feedbackPlacement;
$('#language').value = settings.variables.language;
$('#tone').value = settings.variables.tone;
$('#style').value = settings.variables.style;
$('#prompt-correct').value = settings.prompts.correct;
$('#prompt-rewrite').value = settings.prompts.rewrite;
$('#prompt-run').value = settings.prompts.prompt;
$('#run-provider').value = settings.promptOptions.provider;
$('#run-model').value = settings.promptOptions.model;
$('#run-input').value = settings.promptOptions.inputLimit || '';
$('#run-output').value = settings.promptOptions.outputLimit || '';
$('#run-output-format').value = settings.promptOptions.outputFormat || 'auto';
renderVaultState();
renderProviderFields();
renderActions();
renderToolbarActions();
$('#toolbar-add-btn').addEventListener('click', () => {
  const id = $('#toolbar-add').value;
  if (!id || settings.toolbarActions.includes(id) || settings.toolbarActions.length >= TOOLBAR_LIMIT) return;
  settings.toolbarActions = normalizeToolbarActions([...settings.toolbarActions, id], settings.customActions);
  queueSave();
  renderToolbarActions();
});

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab,.page').forEach(item => item.classList.remove('active'));
  tab.classList.add('active');
  $(`#${tab.dataset.page}`).classList.add('active');
}));

$('#provider').addEventListener('change', () => { settings.provider = $('#provider').value; renderProviderFields(); queueSave(); });
$('#preview').addEventListener('change', () => {
  settings.previewResults = $('#preview').checked;
  $('#preview-changes').disabled = !settings.previewResults;
  queueSave();
});
$('#preview-changes').disabled = !settings.previewResults;
$('#preview-changes').addEventListener('change', () => { settings.previewShowChanges = $('#preview-changes').checked; queueSave(); });
$('#selection-trigger').addEventListener('change', () => { settings.selectionTrigger = $('#selection-trigger').checked; queueSave(); });
$('#vault-enabled').addEventListener('change', handleVaultToggle);
$('#vault-enable').addEventListener('click', enableVault);
$('#vault-cancel').addEventListener('click', () => {
  $('#vault-enabled').checked = false;
  clearVaultPasswords();
  renderVaultState();
});
$('#vault-unlock').addEventListener('click', unlockVault);
$('#vault-unlock-password').addEventListener('keydown', event => {
  if (event.key === 'Enter') unlockVault();
});
$('#vault-lock').addEventListener('click', lockVault);
$('#vault-disable').addEventListener('click', disableVault);
$('#vault-reset').addEventListener('click', resetVault);
$('#history-enabled').addEventListener('change', () => { settings.historyEnabled = $('#history-enabled').checked; queueSave(); });
$('#history-limit').addEventListener('input', () => {
  const raw = Number($('#history-limit').value);
  settings.historyLimit = raw > 0 ? Math.min(500, Math.floor(raw)) : 0;
  queueSave();
});
$('#feedback-placement').addEventListener('change', () => { settings.feedbackPlacement = $('#feedback-placement').value; queueSave(); });
for (const [selector, key] of [['#language', 'language'], ['#tone', 'tone'], ['#style', 'style']]) {
  $(selector).addEventListener('input', () => { settings.variables[key] = $(selector).value; queueSave(); });
}
for (const [selector, key] of [['#prompt-correct', 'correct'], ['#prompt-rewrite', 'rewrite'], ['#prompt-run', 'prompt']]) {
  $(selector).addEventListener('input', () => { settings.prompts[key] = $(selector).value; queueSave(); });
}
for (const [selector, key] of [['#run-provider', 'provider'], ['#run-model', 'model'], ['#run-input', 'inputLimit'], ['#run-output', 'outputLimit'], ['#run-output-format', 'outputFormat']]) {
  $(selector).addEventListener('input', () => { settings.promptOptions[key] = key.endsWith('Limit') ? Number($(selector).value) || 0 : $(selector).value; queueSave(); });
  $(selector).addEventListener('change', () => { settings.promptOptions[key] = key.endsWith('Limit') ? Number($(selector).value) || 0 : $(selector).value; queueSave(); });
}

$('#shortcuts').addEventListener('click', async () => {
  try {
    await browser.commands.openShortcutSettings();
  } catch {
    await browser.tabs.create({url: 'about:addons'});
  }
});
$('#add-action').addEventListener('click', () => openAction());
$('#action-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const action = {
    id: $('#action-id').value || crypto.randomUUID(), name: $('#action-name').value.trim(), prompt: $('#action-prompt').value,
    inputMode: $('#action-mode').value, outputFormat: $('#action-output-format').value || 'auto', provider: $('#action-provider').value, model: $('#action-model').value.trim(),
    inputLimit: Number($('#action-input').value) || 0, outputLimit: Number($('#action-output').value) || 0, enabled: $('#action-enabled').checked,
  };
  if (!action.name || (!action.prompt.trim() && action.inputMode !== 'prompt')) return;
  const index = settings.customActions.findIndex(item => item.id === action.id);
  if (index >= 0) settings.customActions[index] = action; else settings.customActions.push(action);
  await saveNow();
  renderActions();
  $('#action-dialog').close();
});

function renderProviderFields() {
  const provider = $('#provider').value;
  const root = $('#provider-fields');
  root.replaceChildren();
  const fields = document.createElement('div'); fields.className = 'fields provider-config';
  if (provider === 'chatgpt') {
    fields.append(modelField(provider));
    root.append(fields);
    renderChatGPTAccounts(root);
    const extras = document.createElement('div');
    extras.className = 'fields provider-config';
    extras.append(thinkingEffortRow());
    root.append(extras);
    const usage = providerNotice('⚠', 'Using ChatGPT plan',
      'Uses your shared ChatGPT allowance. Custom action output limits must be set to Auto.', true);
    const link = document.createElement('a');
    link.className = 'secondary manage-usage';
    link.href = 'https://chatgpt.com/settings/usage';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Manage usage';
    usage.append(link);
    root.append(usage);
    return;
  }
  if (provider === 'ollama') {
    fields.append(field('Server URL', settings.ollamaUrl, false, value => { settings.ollamaUrl = value; queueSave(); }));
  } else if (provider === 'custom_openai') {
    fields.append(field('Base URL', settings.customOpenAiUrl || '', false, async value => {
      settings.customOpenAiUrl = value.trim();
      queueSave();
      await ensureOriginPermission(value);
    }, false, 'e.g. http://127.0.0.1:8000/v1 or https://api.example.com/v1'));
    fields.append(field(
      'API key (optional)',
      settings.apiKeys[provider] || '',
      true,
      value => { settings.apiKeys[provider] = value; queueSave(); },
      settings.vaultLocked,
    ));
  } else {
    if (provider === 'cloudflare') {
      fields.append(field('Account ID', settings.cloudflareAccountId || '', false, value => { settings.cloudflareAccountId = value.trim(); queueSave(); }));
    }
    fields.append(field(
      provider === 'cloudflare' ? 'API token' : 'API key',
      settings.apiKeys[provider] || '',
      true,
      value => { settings.apiKeys[provider] = value; queueSave(); },
      settings.vaultLocked,
    ));
  }
  fields.append(modelField(provider));
  root.append(fields);
  if (provider === 'cloudflare') {
    root.append(
      reasoningOption(),
      providerNotice('ⓘ', 'Free usage', 'Free tier includes 10,000 Neurons per day.'),
    );
  }
  root.append(providerNotice(
    '⚠',
    provider === 'ollama' ? 'Model resource usage' : 'Model usage and cost',
    provider === 'ollama'
      ? 'Larger models may require more memory, processing power, and response time on your device.'
      : 'Larger models may use provider allowances faster or incur charges, depending on your account.',
    true,
  ));
}

function clearChatGPTModels() {
  modelCache.delete('chatgpt');
  if (!chatgptModelControls) return;
  chatgptModelControls.input.value = '';
  applyModelOptions(chatgptModelControls.select, []);
  chatgptModelControls.status.textContent = '';
}

function renderChatGPTAccounts(root) {
  const wrap = document.createElement('div');
  wrap.className = 'chatgpt-accounts';
  const label = document.createElement('label');
  label.textContent = 'Account';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'ChatGPT account');
  label.append(select);
  const status = document.createElement('small');
  status.className = 'chatgpt-status';
  status.setAttribute('aria-live', 'polite');
  const actions = document.createElement('div');
  actions.className = 'chatgpt-actions';
  const connect = document.createElement('button');
  connect.type = 'button';
  connect.className = 'primary';
  connect.textContent = 'Continue with ChatGPT';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'secondary';
  add.textContent = 'Add account';
  const signOut = document.createElement('button');
  signOut.type = 'button';
  signOut.className = 'secondary danger';
  signOut.textContent = 'Sign out';
  actions.append(connect, add, signOut);
  wrap.append(label, status, actions);
  root.append(wrap);

  let accounts = [];
  let busy = false;

  const say = text => { status.textContent = text; };
  const currentAccount = () => accounts.find(item => item.id === select.value);

  const updateButtons = () => {
    const account = currentAccount();
    select.disabled = busy || !accounts.length;
    connect.hidden = Boolean(account?.connected && account?.authorized);
    connect.disabled = busy;
    add.hidden = !accounts.length;
    add.disabled = busy;
    signOut.hidden = !account?.connected;
    signOut.disabled = busy;
    status.textContent = busy ? 'Connecting… finish signing in in the window that opens.' : !account
      ? (accounts.length ? '' : 'No saved accounts yet.')
      : account.connected
        ? (account.authorized ? 'Connected' : 'Plan access was not granted')
        : 'Not connected';
  };

  const refreshChatGPTModels = () => {
    if (!chatgptModelControls) return;

    clearTimeout(saveTimer);
    saveNow().then(() => refreshModelList(
      'chatgpt',
      chatgptModelControls.input,
      chatgptModelControls.select,
      chatgptModelControls.status,
      chatgptModelControls.refresh,
    ));
  };

  const reload = async () => {
    const response = await browser.runtime.sendMessage({type: 'CHATGPT_ACCOUNTS'});
    if (!response?.ok) throw new Error(response?.error || 'Could not load ChatGPT accounts.');
    accounts = response.accounts;
    select.replaceChildren(...(accounts.length
      ? accounts.map(account => new Option(account.label, account.id))
      : [new Option('No saved accounts', '')]));
    select.value = accounts.some(account => account.id === settings.chatgptAccountId)
      ? settings.chatgptAccountId
      : accounts[0]?.id ?? '';
    if ((select.value || '') !== (settings.chatgptAccountId || '')) {
      settings.chatgptAccountId = select.value;
      settings.models.chatgpt = '';
      clearChatGPTModels();
      queueSave();
      if (currentAccount()?.connected) refreshChatGPTModels();
    }
    updateButtons();
  };

  const run = async action => {
    if (busy) return;
    busy = true;
    updateButtons();
    let message = '';
    try {
      message = await action() || '';
    } catch (error) {
      console.error('Plyph ChatGPT action failed:', error);
      message = error?.message || String(error);
    }
    busy = false;
    updateButtons();
    try {
      await reload();
    } catch (error) {
      console.error('Plyph ChatGPT reload failed:', error);
      message = error?.message || String(error);
    }

    if (message) say(message);
  };

  const login = id => run(async () => {

    const keepalive = browser.runtime.connect({name: 'plyph-chatgpt-signin'});
    let result;
    try {
      result = await browser.runtime.sendMessage({type: 'CHATGPT_SIGN_IN', clientId: id || null});
    } finally {
      keepalive.disconnect();
    }
    if (!result?.ok) throw new Error(result?.error || 'ChatGPT sign-in failed.');
    settings.chatgptAccountId = result.id;
    settings.models.chatgpt = '';
    clearChatGPTModels();
    queueSave();
    if (result.authorized) {
      refreshChatGPTModels();
      showChatGPTWelcome();
      return 'Connected to your ChatGPT plan.';
    }
    return 'Plan access was not granted. Reconnect and allow plan usage.';
  });

  connect.addEventListener('click', () => login(select.value || null));
  add.addEventListener('click', () => login(null));
  signOut.addEventListener('click', () => run(async () => {
    const id = select.value;
    const result = await browser.runtime.sendMessage({type: 'CHATGPT_SIGN_OUT', clientId: id});
    if (!result?.ok) throw new Error(result?.error || 'Could not sign out.');
    if (settings.chatgptAccountId === id) {
      settings.chatgptAccountId = '';
      settings.models.chatgpt = '';
      clearChatGPTModels();
      queueSave();
    }
    return result.revoked
      ? 'Signed out.'
      : 'Signed out locally. Remove this connection in Manage usage to confirm remote revocation.';
  }));

  select.addEventListener('change', () => {
    if (busy) return;
    settings.chatgptAccountId = select.value;
    settings.models.chatgpt = '';
    clearChatGPTModels();
    queueSave();
    updateButtons();
    if (currentAccount()?.connected) refreshChatGPTModels();
  });

  updateButtons();
  reload().catch(error => say(error.message || String(error)));
}

function thinkingEffortRow() {
  const wrap = document.createElement('div');
  wrap.className = 'model-field';
  const label = document.createElement('label');
  label.htmlFor = 'thinking-effort';
  label.textContent = 'Thinking effort';
  const select = document.createElement('select');
  select.id = 'thinking-effort';
  for (const [value, text] of [
    ['auto', 'Auto — model default'],
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
  ]) select.add(new Option(text, value));
  select.value = ['auto', 'low', 'medium', 'high'].includes(settings.chatgptThinkingEffort)
    ? settings.chatgptThinkingEffort : 'auto';
  select.addEventListener('change', () => { settings.chatgptThinkingEffort = select.value; queueSave(); });
  const hint = document.createElement('small');
  hint.className = 'model-status';
  hint.textContent = 'Applies to all actions using this provider. Higher effort may take longer. Support varies by model.';
  wrap.append(label, select, hint);
  return wrap;
}

function showChatGPTWelcome() {
  if (settings.chatgptWelcomeShown) return;
  const dialog = $('#chatgpt-welcome');
  dialog.showModal();
  $('#chatgpt-welcome-ok').addEventListener('click', () => {
    dialog.close();
    settings.chatgptWelcomeShown = true;
    queueSave();
  }, {once: true});
}

function renderVaultState() {
  const enabled = Boolean(settings.apiKeyVault);
  $('#vault-enabled').checked = enabled;
  $('#vault-setup').hidden = enabled || !$('#vault-enabled').checked;
  $('#vault-locked').hidden = !enabled || !settings.vaultLocked;
  $('#vault-unlocked').hidden = !enabled || settings.vaultLocked;
  if (!enabled && !$('#vault-enabled').checked) $('#vault-setup').hidden = true;
}

function handleVaultToggle() {
  setVaultMessage('');
  if ($('#vault-enabled').checked && !settings.apiKeyVault) {
    $('#vault-setup').hidden = false;
    $('#vault-password').focus();
    return;
  }
  if (!$('#vault-enabled').checked && settings.apiKeyVault) {
    $('#vault-enabled').checked = true;
    disableVault();
  }
}

async function enableVault() {
  const password = $('#vault-password').value;
  if (password.length < 8) {
    setVaultMessage('Use a vault password with at least 8 characters.', true);
    return;
  }
  if (password !== $('#vault-password-confirm').value) {
    setVaultMessage('The vault passwords do not match.', true);
    return;
  }
  $('#vault-enable').disabled = true;
  try {
    clearTimeout(saveTimer);
    settings.apiKeyVault = await enableApiKeyVault(settings.apiKeys, password);
    settings.vaultLocked = false;
    await saveSettings(settings);
    clearVaultPasswords();
    renderVaultState();
    renderProviderFields();
    setVaultMessage('API-key encryption is enabled. Keep this password safe; Plyph cannot recover it.');
  } catch (error) {
    settings = await getSettings();
    renderVaultState();
    renderProviderFields();
    setVaultMessage(error.message || 'Could not enable API-key encryption.', true);
  } finally {
    $('#vault-enable').disabled = false;
  }
}

async function unlockVault() {
  const password = $('#vault-unlock-password').value;
  if (!password) {
    setVaultMessage('Enter the vault password.', true);
    return;
  }
  $('#vault-unlock').disabled = true;
  try {
    settings.apiKeys = await unlockApiKeyVault(settings.apiKeyVault, password);
    settings.vaultLocked = false;
    $('#vault-unlock-password').value = '';
    renderVaultState();
    renderProviderFields();
    setVaultMessage('Vault unlocked for this Firefox session.');
  } catch (error) {
    setVaultMessage(error.message || 'Could not unlock the API-key vault.', true);
  } finally {
    $('#vault-unlock').disabled = false;
  }
}

async function lockVault() {
  clearTimeout(saveTimer);
  try {
    await saveSettings(settings);
  } catch (error) {
    setVaultMessage(error.message || 'Could not save API keys before locking.', true);
    return;
  }
  await lockApiKeyVault();
  settings.apiKeys = {};
  settings.vaultLocked = true;
  renderVaultState();
  renderProviderFields();
  setVaultMessage('Vault locked.');
}

async function disableVault() {
  if (settings.vaultLocked) {
    $('#vault-enabled').checked = true;
    setVaultMessage('Unlock the vault before turning off encryption.', true);
    $('#vault-unlock-password').focus();
    return;
  }
  if (!confirm('Turn off encryption? Your API keys will be saved unencrypted in Firefox extension storage.')) {
    $('#vault-enabled').checked = true;
    return;
  }
  await disableApiKeyVault(settings.apiKeys);
  settings.apiKeyVault = null;
  settings.vaultLocked = false;
  await saveSettings(settings);
  renderVaultState();
  renderProviderFields();
  setVaultMessage('Encryption is off. API keys now use the standard no-password storage.');
}

async function resetVault() {
  if (!confirm('Reset the encrypted vault? This permanently deletes every saved API key. Other Plyph settings will remain.')) return;
  await resetApiKeyVault();
  settings.apiKeys = {};
  settings.apiKeyVault = null;
  settings.vaultLocked = false;
  renderVaultState();
  renderProviderFields();
  setVaultMessage('Encrypted API keys were deleted. Encryption is off.');
}

function clearVaultPasswords() {
  $('#vault-password').value = '';
  $('#vault-password-confirm').value = '';
  $('#vault-unlock-password').value = '';
}

function setVaultMessage(message, error = false) {
  const element = $('#vault-message');
  element.textContent = message;
  element.classList.toggle('error', error);
}

function reasoningOption() {
  const label = document.createElement('label');
  label.className = 'check-row provider-reasoning';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = settings.cloudflareReasoningEnabled === true;
  input.addEventListener('change', () => {
    settings.cloudflareReasoningEnabled = input.checked;
    queueSave();
  });
  const copy = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = 'Enable Qwen reasoning';
  const description = document.createElement('small');
  description.textContent = 'Optional for supported Qwen 3 models. Leave off for faster, lower-usage text transformations.';
  copy.append(title, description);
  label.append(input, copy);
  return label;
}

function providerNotice(symbol, titleText, descriptionText, warning = false) {
  const row = document.createElement('div');
  row.className = `provider-notice${warning ? ' warning' : ''}`;
  const icon = document.createElement('span');
  icon.className = 'provider-notice-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = warning
    ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.8 17.8 16.5H2.2Z"/><path d="M10 7.5v4"/><circle cx="10" cy="13.8" r=".9" fill="currentColor" stroke="none"/></svg>'
    : '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path d="M10 9.2v4.2"/><circle cx="10" cy="6.8" r=".9" fill="currentColor" stroke="none"/></svg>';
  const copy = document.createElement('span');
  copy.className = 'provider-notice-copy';
  const title = document.createElement('strong');
  title.textContent = titleText;
  const description = document.createElement('small');
  description.textContent = descriptionText;
  copy.append(title, description);
  row.append(icon, copy);
  return row;
}

function modelField(provider) {
  const wrap = document.createElement('div');
  wrap.className = 'model-field';
  const label = document.createElement('label');
  label.htmlFor = 'model-select';
  label.textContent = 'Model';
  const row = document.createElement('div');
  row.className = 'model-row';
  const select = document.createElement('select');
  select.id = 'model-select';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'secondary model-refresh';
  refresh.textContent = 'Refresh models';
  const input = document.createElement('input');
  input.id = 'model-input';
  input.value = settings.models[provider] || '';
  input.placeholder = 'Or type a model name…';
  input.setAttribute('aria-label', 'Model name');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const models = modelCache.get(provider) || [];
  applyModelOptions(select, models, input.value);
  const status = document.createElement('small');
  status.className = 'model-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = modelCache.has(provider)
    ? `${models.length} models loaded`
    : provider === 'ollama'
      ? 'Click Refresh models to load installed models.'
      : provider === 'chatgpt'
        ? 'Connect your account, then click Refresh models.'
        : provider === 'cloudflare'
          ? 'Add your API token and Account ID, then click Refresh models.'
          : 'Add your API key, then click Refresh models.';
  select.addEventListener('change', () => {
    if (!select.value) return;
    input.value = select.value;
    settings.models[provider] = select.value;
    queueSave();
  });
  input.addEventListener('input', () => {
    settings.models[provider] = input.value.trim();
    select.value = (modelCache.get(provider) || []).some(model => model.id === input.value) ? input.value : '';
    queueSave();
  });
  refresh.addEventListener('click', () => refreshModelList(provider, input, select, status, refresh));
  row.append(select, refresh);
  wrap.append(label, row, input, status);
  chatgptModelControls = provider === 'chatgpt' ? {select, input, status, refresh} : null;
  return wrap;
}

function applyModelOptions(select, models, currentValue = '') {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = models.length ? 'Choose a model…' : 'Refresh to load models…';
  select.replaceChildren(placeholder, ...models.map(model => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id;
    return option;
  }));
  select.value = models.some(model => model.id === currentValue) ? currentValue : '';
}

async function refreshModelList(provider, input, select, status, button) {
  const originalText = button.textContent;
  button.disabled = true;
  status.className = 'model-status';
  status.textContent = 'Loading models…';
  try {
    const models = await fetchProviderModels(provider);
    modelCache.set(provider, models);
    applyModelOptions(select, models, input.value);
    status.textContent = models.length
      ? `${models.length} models loaded. Choose one above or type a model name below.`
      : 'No models were returned. You can still type a model name.';
    if (!input.value.trim() && models[0]) {
      input.value = models[0].id;
      select.value = models[0].id;
      settings.models[provider] = models[0].id;
      queueSave();
    }
  } catch (error) {
    status.className = 'model-status error';
    status.textContent = error.message || 'Could not load models. You can type one manually.';
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function fetchProviderModels(provider) {
  const providerName = PROVIDERS.find(item => item.id === provider)?.name || provider;
  let data;
  if (provider === 'ollama') {
    const baseUrl = String(settings.ollamaUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) throw new Error('Enter the Ollama server URL first.');
    data = await fetchModelJson(`${baseUrl}/api/tags`, {}, providerName);
    return uniqueModels((data.models || []).map(model => ({id: model.model || model.name, name: model.name})));
  }

  if (provider === 'custom_openai') {
    const rawUrl = String(settings.customOpenAiUrl || '').trim();
    if (!rawUrl) throw new Error('Enter the Custom OpenAI Base URL first.');
    await ensureOriginPermission(rawUrl);
    const baseUrl = rawUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const key = settings.apiKeys[provider];
    const headers = key ? {Authorization: `Bearer ${key}`} : {};
    try {
      data = await fetchModelJson(`${baseUrl}/models`, headers, providerName, provider);
    } catch (error) {
      throw new Error(`${error.message || 'Could not load models from /models.'} You can type your model name directly.`);
    }
    const rawList = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    const models = rawList
      .filter(model => model && (model.id || model.name))
      .map(model => ({id: model.id || model.name, name: model.name || model.id}));
    return uniqueModels(models);
  }

  if (provider === 'chatgpt') {
    if (!settings.chatgptAccountId)
      throw new Error('Connect your ChatGPT account first.');
    const response = await browser.runtime.sendMessage({type: 'CHATGPT_MODELS'});
    if (!response?.ok) throw new Error(response?.error || 'Could not load ChatGPT models.');
    return uniqueModels(response.models || []);
  }

  if (settings.vaultLocked) throw new Error('Unlock your encrypted API keys first.');
  const key = settings.apiKeys[provider];
  if (!key) throw new Error(provider === 'cloudflare'
    ? 'Add your Cloudflare Workers AI API token first.'
    : `Add your ${providerName} API key first.`);
  if (provider === 'cloudflare') {
    const accountId = String(settings.cloudflareAccountId || '').trim();
    if (!accountId) throw new Error('Add your Cloudflare Account ID first.');
    data = await fetchModelJson(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=${encodeURIComponent('Text Generation')}&hide_experimental=true&per_page=100`,
      {Authorization: `Bearer ${key}`}, providerName, provider);
    return uniqueModels((Array.isArray(data.result) ? data.result : []).map(model => ({
      id: model.name || model.id,
      name: model.name || model.id,
    })));
  }
  const endpoints = {
    groq: 'https://api.groq.com/openai/v1/models',
    bai: 'https://api.b.ai/v1/models',
    deepseek: 'https://api.deepseek.com/models',
    gemini: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`,
    openrouter: 'https://openrouter.ai/api/v1/models?output_modalities=text',
    cerebras: 'https://api.cerebras.ai/v1/models',
    openai: 'https://api.openai.com/v1/models',
    vercel: 'https://ai-gateway.vercel.sh/v1/models',
  };
  const headers = provider === 'gemini' ? {} : {Authorization: `Bearer ${key}`};
  data = await fetchModelJson(endpoints[provider], headers, providerName, provider);
  if (provider === 'gemini') {
    return uniqueModels((data.models || [])
      .filter(model => model.supportedGenerationMethods?.includes('generateContent'))
      .map(model => ({id: model.name?.replace(/^models\//, ''), name: model.displayName || model.name})));
  }
  let models = (data.data || [])
    .filter(model => provider !== 'bai' || !model.supported_endpoint_types || model.supported_endpoint_types.includes('openai'))
    .filter(model => model.type ? model.type === 'language' : true)
    .map(model => ({id: model.id, name: model.name || model.id}));
  if (provider === 'openai') {
    models = models.filter(model => /^(gpt-|o\d)/.test(model.id) && !/(audio|image|realtime|search|transcribe|tts)/.test(model.id));
  } else if (provider === 'groq') {
    models = models.filter(model => !/(guard|whisper|tts)/i.test(model.id));
  }
  return uniqueModels(models);
}

async function ensureOriginPermission(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return;
    const originPattern = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/*`;
    const has = await browser.permissions.contains({origins: [originPattern]});
    if (!has) {
      await browser.permissions.request({origins: [originPattern]});
    }
  } catch {

  }
}

async function fetchModelJson(url, headers, providerName, provider = '') {
  let response;
  try {
    response = await fetch(url, {headers, signal: AbortSignal.timeout(20000)});
  } catch {
    throw new Error(`Could not connect to ${providerName}. Check the URL or your connection.`);
  }
  let data = {};
  try { data = await response.json(); } catch {  }
  if (response.ok) return data;
  const providerError = data?.error?.message || data?.error;
  const detail = typeof providerError === 'string' ? providerError : '';
  if (response.status === 401 || response.status === 403) throw new Error(provider === 'cloudflare'
    ? 'Cloudflare rejected the API token or Account ID. Check them and try again.'
    : `${providerName} rejected the API key. Check it and try again.`);
  if (response.status === 404) throw new Error(`${providerName} model list is unavailable.`);
  if (response.status === 429) throw new Error(`${providerName} rate limit reached. Try again later.`);
  throw new Error(detail || `${providerName} rejected the request (${response.status}).`);
}

function uniqueModels(models) {
  const seen = new Set();
  return models
    .filter(model => model?.id && !seen.has(model.id) && seen.add(model.id))
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

function field(labelText, value, secret, onInput, disabled = false, placeholder = '') {
  const label = document.createElement('label'); label.textContent = labelText;
  const input = document.createElement('input'); input.value = value; input.type = secret ? 'password' : 'text'; input.autocomplete = 'off';
  input.disabled = disabled;
  if (disabled) input.placeholder = 'Unlock encrypted API keys below';
  else if (placeholder) input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value)); label.append(input); return label;
}

function toolbarIcon(id) {
  const paths = {
    ask: '<path d="M5 3.5h14A1.5 1.5 0 0 1 20.5 5v11a1.5 1.5 0 0 1-1.5 1.5h-7L7 21v-3.5H5A1.5 1.5 0 0 1 3.5 16V5A1.5 1.5 0 0 1 5 3.5Z"/><path d="M9.8 8a2.2 2.2 0 1 1 3.6 1.7c-.9.6-1.4 1-1.4 2"/><circle cx="12" cy="14.5" r=".7" fill="currentColor" stroke="none"/>',
    correct: '<path d="m8.5 10.5 11 11 2-2-11-11Z"/><path d="m11 13 2-2M5 2v4M3 4h4M16 2v4M14 4h4M3 12v4M1 14h4"/>',
    rewrite: '<path d="M10 5H5a1 1 0 0 0-1 1v14h14v-6M11 13l1-4L19 2l3 3-7 7ZM17 4l3 3"/>',
    prompt: '<path d="M6 3.5a.7.7 0 0 1 1.1-.6l14 8.5a.7.7 0 0 1 0 1.2l-14 8.5a.7.7 0 0 1-1.1-.6Z" fill="currentColor" stroke="none"/>',
    more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  };
  const inner = paths[id] || '<path d="m10 4 2.3 6.7L19 13l-6.7 2.3L10 22l-2.3-6.7L1 13l6.7-2.3ZM19 1l1.1 3.9L24 6l-3.9 1.1L19 11l-1.1-3.9L14 6l3.9-1.1Z"/>';
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

function toolbarCandidates() {
  const customs = (settings.customActions || [])
    .filter(action => action.enabled !== false && action.name?.trim());
  return [
    ...TOOLBAR_BUILTINS.map(item => ({id: item.id, name: item.name})),
    ...customs.map(action => ({id: action.id, name: action.name})),
  ];
}

function renderToolbarActions() {
  settings.toolbarActions = normalizeToolbarActions(settings.toolbarActions, settings.customActions);
  const root = $('#toolbar-list');
  root.replaceChildren();
  const candidates = toolbarCandidates();
  const byId = new Map(candidates.map(item => [item.id, item.name]));
  const visible = settings.toolbarActions.filter(id => byId.has(id));
  const preview = $('#toolbar-preview');
  preview.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'tp-dot';
  dot.title = 'Plyph button';
  dot.innerHTML = '<svg viewBox="0 0 1024 1024" aria-hidden="true"><g transform="translate(512 512) scale(1.32) translate(-512 -478)"><path d="M512 156C496 257 458 365 401 455C349 537 286 607 220 660C302 636 368 637 419 675C465 709 493 755 512 800C531 755 559 709 605 675C656 637 722 636 804 660C738 607 675 537 623 455C566 365 528 257 512 156Z" fill="#f7f7f7" stroke="#111316" stroke-width="64" stroke-linejoin="round" paint-order="stroke fill"/><path d="M512 405C461 405 424 439 424 487C424 539 444 594 468 650C490 702 505 751 512 800C509 757 507 714 511 678C516 635 532 612 559 586C589 557 600 527 600 488C600 440 563 405 512 405Z" fill="#111316"/><circle cx="512" cy="493" r="38" fill="#f7f7f7"/></g></svg>';
  preview.append(dot);
  visible.forEach((id, index) => {
    const name = byId.get(id);
    const row = document.createElement('div');
    row.className = 'custom-row';
    const text = document.createElement('div');
    text.className = 'custom-copy';
    const label = document.createElement('strong');
    label.textContent = name;
    const detail = document.createElement('small');
    detail.textContent = `Toolbar button ${index + 1} of ${TOOLBAR_LIMIT}`;
    text.append(label, detail);
    const controls = document.createElement('div');
    controls.className = 'row-buttons';
    const moveToolbar = direction => {
      const next = index + direction;
      if (next < 0 || next >= settings.toolbarActions.length) return;
      [settings.toolbarActions[index], settings.toolbarActions[next]] =
        [settings.toolbarActions[next], settings.toolbarActions[index]];
      queueSave();
      renderToolbarActions();
    };
    controls.append(
      rowButton('↑', () => moveToolbar(-1), false, `Move ${name} up`),
      rowButton('↓', () => moveToolbar(1), false, `Move ${name} down`),
      rowButton('Remove', () => {
        settings.toolbarActions = settings.toolbarActions.filter(item => item !== id);
        if (!settings.toolbarActions.length)
          settings.toolbarActions = normalizeToolbarActions([], settings.customActions);
        queueSave();
        renderToolbarActions();
      }, true),
    );
    row.append(text, controls);
    root.append(row);
    const pill = document.createElement('span');
    pill.className = 'tp-item';
    pill.title = name;
    const glyph = document.createElement('span');
    glyph.className = 'tp-glyph';
    glyph.innerHTML = toolbarIcon(TOOLBAR_BUILTINS.some(item => item.id === id) ? id : 'custom');
    const caption = document.createElement('span');
    caption.textContent = id === 'prompt' ? 'Run Prompt' : name;
    pill.append(glyph, caption);
    preview.append(pill);
  });
  const more = document.createElement('span');
  more.className = 'tp-item tp-more';
  more.title = 'More actions';
  more.innerHTML = toolbarIcon('more');
  more.setAttribute('aria-label', 'More actions');
  preview.append(more);
  const full = settings.toolbarActions.length >= TOOLBAR_LIMIT;
  $('#toolbar-add-row').hidden = full;
  $('#toolbar-limit').hidden = !full;
  if (!full) {
    const select = $('#toolbar-add');
    select.replaceChildren();
    for (const item of candidates.filter(item => !settings.toolbarActions.includes(item.id)))
      select.add(new Option(item.name, item.id));
  }
}

function renderActions() {
  const root = $('#action-list'); root.replaceChildren();
  if (!settings.customActions.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No custom actions yet.'; root.append(empty); return; }
  settings.customActions.forEach((action, index) => {
    const row = document.createElement('div'); row.className = 'custom-row';
    const text = document.createElement('div'); text.className = 'custom-copy';
    const name = document.createElement('strong'); name.textContent = action.name;
    const detail = document.createElement('small'); detail.textContent = `${action.inputMode === 'prompt' ? 'Prompt' : 'Transform'} · ${action.provider ? PROVIDERS.find(p => p.id === action.provider)?.name : 'Active provider'}${action.enabled === false ? ' · Disabled' : ''}`;
    text.append(name, detail);
    const controls = document.createElement('div'); controls.className = 'row-buttons';
    controls.append(rowButton('Edit', () => openAction(action)), rowButton('↑', () => move(index, -1), false, `Move ${action.name} up`), rowButton('↓', () => move(index, 1), false, `Move ${action.name} down`), rowButton('Delete', () => removeAction(action.id), true));
    row.append(text, controls); root.append(row);
  });
  renderToolbarActions();
}

function rowButton(text, click, danger = false, label = '') { const button = document.createElement('button'); button.className = danger ? 'text-button danger' : 'text-button'; button.textContent = text; if (label) button.setAttribute('aria-label', label); button.addEventListener('click', click); return button; }
function move(index, direction) { const next = index + direction; if (next < 0 || next >= settings.customActions.length) return; [settings.customActions[index], settings.customActions[next]] = [settings.customActions[next], settings.customActions[index]]; saveNow(); renderActions(); }
function removeAction(id) {
  const action = settings.customActions.find(item => item.id === id);
  if (action && !confirm(`Delete the "${action.name}" action? This cannot be undone.`)) return;
  settings.customActions = settings.customActions.filter(item => item.id !== id);
  saveNow();
  renderActions();
}

function openAction(action = {}) {
  $('#action-dialog-title').textContent = action.id ? 'Edit custom action' : 'New custom action';
  $('#action-id').value = action.id || ''; $('#action-name').value = action.name || ''; $('#action-prompt').value = action.prompt || '';
  $('#action-mode').value = action.inputMode || 'transform'; $('#action-output-format').value = action.outputFormat || 'auto';
  $('#action-provider').value = action.provider || ''; $('#action-model').value = action.model || '';
  $('#action-input').value = action.inputLimit || ''; $('#action-output').value = action.outputLimit || ''; $('#action-enabled').checked = action.enabled !== false;
  $('#action-dialog').showModal(); $('#action-name').focus();
}

function queueSave() { clearTimeout(saveTimer); $('#save-status').textContent = 'Saving…'; saveTimer = setTimeout(saveNow, 350); }
async function saveNow() {
  clearTimeout(saveTimer);
  try {
    await saveSettings(settings);
    $('#save-status').textContent = 'Saved';
    setTimeout(() => { $('#save-status').textContent = ''; }, 1200);
  } catch (error) {
    $('#save-status').textContent = 'Could not save';
    console.error('Could not save Plyph settings:', error);
  }
}
