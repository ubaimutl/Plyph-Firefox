import {enabledActions, getSettings} from './shared.js';

const actionsRoot = document.querySelector('#actions');
const status = document.querySelector('#status');
document.querySelector('#settings').addEventListener('click', () => browser.runtime.openOptionsPage());
document.querySelector('#history').addEventListener('click', () => browser.tabs.create({url: browser.runtime.getURL('history.html')}));

const settings = await getSettings();
const builtInActions = [
  {name: 'Ask…', mode: 'ask'},
  {name: 'Correct selected text', mode: 'correct'},
  {name: 'Rewrite selected text', mode: 'rewrite'},
  {name: 'Run selected prompt', mode: 'prompt'},
];
const customActions = enabledActions(settings).map(action => ({name: action.name, mode: 'custom', actionId: action.id}));

for (const action of [...builtInActions, ...customActions]) {
  if (action === customActions[0]) {
    const separator = document.createElement('div');
    separator.className = 'menu-separator';
    actionsRoot.append(separator);
  }
  const button = document.createElement('button');
  button.className = 'action-row menu-row';
  button.innerHTML = `<span class="action-glyph" aria-hidden="true">${actionIcon(action.mode)}</span><span class="action-label"></span>`;
  button.querySelector('.action-label').textContent = action.name;
  button.addEventListener('click', () => run(action, button));
  actionsRoot.append(button);
}

function actionIcon(mode) {
  const paths = {
    ask: '<path d="M5 3.5h14A1.5 1.5 0 0 1 20.5 5v11a1.5 1.5 0 0 1-1.5 1.5h-7L7 21v-3.5H5A1.5 1.5 0 0 1 3.5 16V5A1.5 1.5 0 0 1 5 3.5Z"/><path d="M9.8 8a2.2 2.2 0 1 1 3.6 1.7c-.9.6-1.4 1-1.4 2"/><circle cx="12" cy="14.5" r=".7" fill="currentColor" stroke="none"/>',
    correct: '<path d="m8.5 10.5 11 11 2-2-11-11Z"/><path d="m11 13 2-2M5 2v4M3 4h4M16 2v4M14 4h4M3 12v4M1 14h4"/>',
    rewrite: '<path d="M10 5H5a1 1 0 0 0-1 1v14h14v-6M11 13l1-4L19 2l3 3-7 7ZM17 4l3 3"/>',
    prompt: '<path d="M6 3.5a.7.7 0 0 1 1.1-.6l14 8.5a.7.7 0 0 1 0 1.2l-14 8.5a.7.7 0 0 1-1.1-.6Z" fill="currentColor" stroke="none"/>',
    more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    custom: '<path d="m10 4 2.3 6.7L19 13l-6.7 2.3L10 22l-2.3-6.7L1 13l6.7-2.3ZM19 1l1.1 3.9L24 6l-3.9 1.1L19 11l-1.1-3.9L14 6l3.9-1.1Z"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[mode] || paths.custom}</svg>`;
}

async function run(action, button) {
  status.hidden = true;
  document.querySelectorAll('.action-row').forEach(item => item.disabled = true);
  button.classList.add('busy');
  const [tab] = await browser.tabs.query({active: true, currentWindow: true});
  try {
    const response = await browser.runtime.sendMessage({type: 'RUN_ACTION', tabId: tab?.id, action});
    if (!response?.ok) throw new Error(response?.error || 'Could not run this action.');
    window.close();
  } catch (error) {
    status.textContent = error.message || 'Could not run this action.';
    status.hidden = false;
    document.querySelectorAll('.action-row').forEach(item => item.disabled = false);
    button.classList.remove('busy');
  }
}
