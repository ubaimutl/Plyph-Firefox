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
      ask: '<path d="M17 9a6.5 6.5 0 0 1-6.5 6.5H7L3 18V6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3Z"/><path d="M6.5 7h7M6.5 10.5H11"/>',
      correct: '<path d="m2.5 12 3.5-9 3.5 9M4 8.5h4M11 13l2.5 2.5 4-5"/>',
      rewrite: '<path d="m12.5 3.5 4 4M3 17l4.5-1 10-10a1.5 1.5 0 0 0 0-2l-1.5-1.5a1.5 1.5 0 0 0-2 0l-10 10Z"/><path d="M11 17h6"/>',
      prompt: '<path d="m6 3 10 7-10 7Z"/>',
      more: '<circle cx="4" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="16" cy="10" r="1"/>',
      custom: '<path d="M3 5h5m4 0h5M3 10h9m4 0h1M3 15h2m4 0h8M8 3v4m4 1v4M5 13v4"/>',
    };
    return `<svg viewBox="0 0 20 20" aria-hidden="true">${paths[mode] || paths.custom}</svg>`;
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
