(() => {
  const previousController = globalThis.__plyphController;
  if (previousController?.dispose) {
    try { previousController.dispose(); } catch { /* The previous extension context may already be gone. */ }
  }

  const lifecycle = new AbortController();

  let snapshot = null;
  let toastTimer = null;
  let toastAnchorListeners = null;
  let pointerPosition = null;
  let triggerEnabled = true;
  let triggerTimer = null;
  let cachedActions = [];
  let feedbackPlacement = 'bottom';
  let extensionAlive = true;

  globalThis.__plyphController = {dispose: disposeController};
  delete globalThis.__plyphLoaded;

  function isContextInvalidation(error) {
    const message = error?.message || String(error || '');
    return message.includes('Extension context invalidated')
      || message.includes('context is invalidated')
      || message.includes('Message manager disconnected');
  }

  function disposeController() {
    if (!extensionAlive && lifecycle.signal.aborted) return;
    extensionAlive = false;
    triggerEnabled = false;
    clearTimeout(triggerTimer);
    clearTimeout(toastTimer);
    lifecycle.abort();
    try { browser.runtime.onMessage.removeListener(handleRuntimeMessage); } catch { /* Context already invalidated. */ }
    removeTrigger();
    closeDialog();
    removeToast();
  }

  globalThis.addEventListener('unhandledrejection', event => {
    if (!isContextInvalidation(event.reason)) return;
    event.preventDefault();
    disposeController();
  }, {signal: lifecycle.signal});

   try {
    browser.storage.local.get({selectionTrigger: true, customActions: [], feedbackPlacement: 'bottom'})
      .then(values => {
        if (!extensionAlive) return;
        triggerEnabled = values.selectionTrigger !== false;
        feedbackPlacement = values.feedbackPlacement || 'bottom';
        cachedActions = enabledCustomActions(values.customActions);
        if (triggerEnabled) scheduleTriggerUpdate();
      })
      .catch(error => {
        if (isContextInvalidation(error)) disposeController();
      });
  } catch (error) {
    if (isContextInvalidation(error)) disposeController();
  }
  document.addEventListener('selectionchange', scheduleTriggerUpdate, {signal: lifecycle.signal});
  document.addEventListener('mouseup', scheduleTriggerUpdate, {signal: lifecycle.signal});
  document.addEventListener('keyup', scheduleTriggerUpdate, {signal: lifecycle.signal});
  document.addEventListener('pointermove', event => {
    pointerPosition = {x: event.clientX, y: event.clientY};
  }, {passive: true, signal: lifecycle.signal});
  document.addEventListener('pointerdown', event => {
    pointerPosition = {x: event.clientX, y: event.clientY};
  }, {passive: true, signal: lifecycle.signal});
  document.addEventListener('mousedown', event => {
    const trigger = document.getElementById('plyph-trigger');
    if (trigger && !event.composedPath().includes(trigger)) removeTrigger();
  }, {capture: true, signal: lifecycle.signal});
  window.addEventListener('scroll', () => removeTrigger(), {capture: true, signal: lifecycle.signal});
  window.addEventListener('resize', () => removeTrigger(), {signal: lifecycle.signal});
  window.addEventListener('pagehide', () => removeTrigger(), {signal: lifecycle.signal});

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message.type === 'PING') { sendResponse({ok: true}); return; }
    if (message.type === 'CAPTURE_SELECTION') {
      const current = captureSelection();
      if (current?.text) snapshot = current;
      sendResponse({text: snapshot?.text || ''});
      return;
    }
    if (message.type === 'WORKING') { removeTrigger(); showToast('Working…', 'working'); }
    if (message.type === 'SHOW_ERROR') showToast(message.message, 'error', 4000);
    if (message.type === 'SHOW_RESULT') showResult(message.output);
    if (message.type === 'REPLACE_RESULT') replaceSelection(message.output, message.label);
    if (message.type === 'SET_PAGE_CONFIG') {
      cachedActions = enabledCustomActions(message.customActions);
      triggerEnabled = message.selectionTrigger !== false;
      feedbackPlacement = message.feedbackPlacement || 'bottom';
      if (triggerEnabled) scheduleTriggerUpdate(); else removeTrigger();
    }
  }

  try {
    browser.runtime.onMessage.addListener(handleRuntimeMessage);
  } catch (error) {
    if (isContextInvalidation(error)) disposeController();
  }

  function captureSelection() {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && /^(text|search|url|tel|email|password)$/i.test(active.type))) {
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? start;
      return {kind: 'control', element: active, start, end, text: active.value.slice(start, end)};
    }
    const selection = window.getSelection();
    if (selection?.rangeCount && !selection.isCollapsed) {
      return {kind: 'range', range: selection.getRangeAt(0).cloneRange(), text: selection.toString()};
    }
    return null;
  }

  function scheduleTriggerUpdate() {
    if (!extensionAlive) return;
    clearTimeout(triggerTimer);
    triggerTimer = setTimeout(updateTrigger, 90);
  }

  function updateTrigger() {
    if (!extensionAlive || !triggerEnabled || document.getElementById('plyph-host')) return removeTrigger();
    const current = captureSelection();
    if (!current?.text?.trim()) return removeTrigger();
    snapshot = current;
    const rect = selectionRect(current);
    if (!rect || (!rect.width && !rect.height)) return removeTrigger();
    showTrigger(rect);
  }

  function selectionRect(selection) {
    if (selection.kind === 'range') {
      const rect = selection.range.getBoundingClientRect();
      return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height};
    }
    return controlCaretRect(selection.element, selection.end);
  }

  function controlCaretRect(element, position) {
    const style = getComputedStyle(element);
    const mirror = document.createElement('div');
    const properties = [
      'boxSizing', 'width', 'height', 'borderTopWidth', 'borderRightWidth',
      'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight',
      'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight',
      'fontStretch', 'fontSize', 'fontFamily', 'lineHeight', 'letterSpacing',
      'textTransform', 'textAlign', 'textIndent', 'wordSpacing', 'tabSize',
    ];
    Object.assign(mirror.style, {
      position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px',
      overflow: 'hidden', whiteSpace: element instanceof HTMLInputElement ? 'pre' : 'pre-wrap',
      overflowWrap: 'break-word',
    });
    for (const property of properties) mirror.style[property] = style[property];
    mirror.textContent = element.value.slice(0, position);
    const marker = document.createElement('span');
    marker.textContent = element.value.slice(position) || '.';
    mirror.append(marker);
    document.body.append(mirror);
    const elementRect = element.getBoundingClientRect();
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
    const rect = {
      left: elementRect.left + marker.offsetLeft - element.scrollLeft,
      right: elementRect.left + marker.offsetLeft - element.scrollLeft,
      top: elementRect.top + marker.offsetTop - element.scrollTop,
      bottom: elementRect.top + marker.offsetTop - element.scrollTop + lineHeight,
      width: 1,
      height: lineHeight,
    };
    mirror.remove();
    return rect;
  }

  function showTrigger(rect) {
    let host = document.getElementById('plyph-trigger');
    if (!host) {
      host = document.createElement('div');
      host.id = 'plyph-trigger';
      const root = host.attachShadow({mode: 'open'});
      root.innerHTML = `
        <style>
          :host{all:initial;--surface:#fff;--hover:#f0f1f4;--text:#24262b;--muted:#6d7179;--border:#d9dce2;--accent:#4058cf}
          @media(prefers-color-scheme:dark){:host{--surface:#292a2e;--hover:#3a3b40;--text:#f1f1f3;--muted:#aaacb2;--border:#45474d;--accent:#9cabff}}
          .dot{display:flex;align-items:center;justify-content:center;width:23px;height:23px;padding:0;border:1px solid var(--border);border-radius:50%;background:var(--surface);color:var(--accent);box-shadow:0 3px 12px rgba(0,0,0,.24);font:700 13px/1 system-ui,sans-serif;cursor:pointer}
          .dot:hover,.dot[aria-expanded=true]{background:var(--hover)}
          .menu{position:absolute;top:28px;right:0;width:220px;padding:5px;border:1px solid var(--border);border-radius:10px;background:var(--surface);box-shadow:0 10px 30px rgba(0,0,0,.3);display:flex;flex-direction:column}.menu.above{top:auto;bottom:28px}
          .menu[hidden]{display:none}.item{width:100%;min-height:29px;padding:5px 9px;border:0;border-radius:6px;background:transparent;color:var(--text);font:13.5px/1.35 system-ui,sans-serif;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;display:flex;align-items:center;gap:8px}.item:hover,.item:focus{background:var(--hover);outline:0}
          .glyph{display:flex;flex:0 0 16px;width:16px;height:16px;color:var(--muted)}.glyph svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.glyph .filled{fill:currentColor;stroke:none}.label{min-width:0;overflow:hidden;text-overflow:ellipsis}
          .separator{height:1px;margin:4px 8px;background:var(--border)}
        </style>
        <button class="dot" title="Plyph actions" aria-label="Open Plyph actions" aria-expanded="false">✦</button>
        <div class="menu" role="menu" hidden></div>`;
      document.documentElement.append(host);
      const dot = root.querySelector('.dot');
      dot.addEventListener('mousedown', event => event.preventDefault());
      dot.addEventListener('click', () => toggleTriggerMenu(root));
      root.addEventListener('keydown', event => { if (event.key === 'Escape') removeTrigger(); });
    }
    const x = Math.min(window.innerWidth - 29, Math.max(6, rect.right + 5));
    const y = Math.min(window.innerHeight - 29, Math.max(6, rect.bottom + 5));
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('z-index', '2147483646', 'important');
    host.style.setProperty('left', `${x}px`, 'important');
    host.style.setProperty('top', `${y}px`, 'important');
    host.shadowRoot.querySelector('.menu').classList.toggle('above', y > window.innerHeight - 250);
  }

  function enabledCustomActions(actions) {
    return Array.isArray(actions)
      ? actions.filter(action => action?.enabled !== false && action?.name?.trim())
      : [];
  }

  function hasExtensionContext() {
    try {
      return Boolean(browser.runtime?.id);
    } catch {
      return false;
    }
  }

  function toggleTriggerMenu(root) {
    if (!extensionAlive || !hasExtensionContext()) return removeTrigger();
    const menu = root.querySelector('.menu');
    const dot = root.querySelector('.dot');
    if (!menu.hidden) { menu.hidden = true; dot.setAttribute('aria-expanded', 'false'); return; }
    const actions = [
      {name: 'Correct selected text', mode: 'correct'},
      {name: 'Rewrite selected text', mode: 'rewrite'},
      {name: 'Run selected prompt', mode: 'prompt'},
      ...cachedActions.map(action => ({name: action.name, mode: 'custom', actionId: action.id})),
    ];
    menu.replaceChildren();
    actions.forEach((action, index) => {
      if (index === 3) { const separator = document.createElement('div'); separator.className = 'separator'; menu.append(separator); }
      const button = document.createElement('button');
      button.className = 'item'; button.type = 'button'; button.setAttribute('role', 'menuitem');
      const glyph = document.createElement('span');
      glyph.className = 'glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.append(triggerActionIcon(action.mode));
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = action.name;
      button.append(glyph, label);
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => {
        if (!extensionAlive || !hasExtensionContext()) return removeTrigger();
        menu.hidden = true;
        dot.setAttribute('aria-expanded', 'false');
        try {
          browser.runtime.sendMessage({
            type: 'RUN_ACTION_FROM_PAGE',
            action,
            text: snapshot?.text || '',
          }).then(response => {
            if (!extensionAlive) return;
            if (!response?.ok)
              showToast(response?.error || 'Could not run this action.', 'error', 4000);
          }).catch(error => {
            if (isContextInvalidation(error)) disposeController();
            removeTrigger();
          });
        } catch {
          removeTrigger();
        }
      });
      menu.append(button);
    });
    menu.hidden = false;
    dot.setAttribute('aria-expanded', 'true');
  }

  function triggerActionIcon(mode) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    const addPath = (d, className = '') => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      if (className) path.setAttribute('class', className);
      svg.append(path);
    };
    if (mode === 'correct') addPath('m4 10 3.2 3.2L16 4.8');
    else if (mode === 'rewrite') {
      addPath('M15.5 7A6 6 0 1 0 16 12');
      addPath('M12 3h4v4');
    } else if (mode === 'prompt') addPath('m7 4 8 6-8 6Z', 'filled');
    else addPath('m10 2 1.5 5.1L16.5 9l-5 1.9L10 16l-1.5-5.1L3.5 9l5-1.9Z');
    return svg;
  }

  function removeTrigger() {
    clearTimeout(triggerTimer);
    document.getElementById('plyph-trigger')?.remove();
  }

  function replaceSelection(text, label = 'Replaced') {
    if (!snapshot) { showToast('The original selection is no longer available.', 'error', 3500); return; }
    const completedSelection = snapshot;
    if (snapshot.kind === 'control' && snapshot.element?.isConnected) {
      const element = snapshot.element;
      element.focus();
      element.setSelectionRange(snapshot.start, snapshot.end);
      element.setRangeText(text, snapshot.start, snapshot.end, 'end');
      element.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
      element.dispatchEvent(new Event('change', {bubbles: true}));
    } else if (snapshot.kind === 'range') {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(snapshot.range);
      if (!document.execCommand('insertText', false, text)) {
        snapshot.range.deleteContents();
        const node = document.createTextNode(text);
        snapshot.range.insertNode(node);
        snapshot.range.setStartAfter(node);
        snapshot.range.collapse(true);
      }
    } else {
      showToast('The original field is no longer available.', 'error', 3500);
      return;
    }
    snapshot = null;
    closeDialog();
    showToast(`${label}. Use the page’s undo command to revert.`, 'normal', 1800, completedSelection);
  }

  function showResult(output) {
    removeToast();
    clearTimeout(toastTimer);
    closeDialog();
    const host = document.createElement('div');
    host.id = 'plyph-host';
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = `
      <style>
        :host{all:initial;--pp-surface:#fff;--pp-text:#172033;--pp-muted:#667085;--pp-field:#fbfcfe;--pp-border:#d7dce5;--pp-button:#fff;--pp-primary:#3f5bd8}
        @media(prefers-color-scheme:dark){:host{--pp-surface:#242529;--pp-text:#f1f1f3;--pp-muted:#a7a9b0;--pp-field:#191a1d;--pp-border:#414349;--pp-button:#303136;--pp-primary:#8da0ff}}
        .backdrop{position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;padding:28px;font:16px/1.5 system-ui,sans-serif;color:var(--pp-text)}
        .dialog{width:min(860px,calc(100vw - 56px));max-height:min(760px,calc(100vh - 56px));background:var(--pp-surface);border:1px solid var(--pp-border);border-radius:18px;box-shadow:0 26px 80px rgba(0,0,0,.32);display:flex;flex-direction:column;overflow:hidden}
        header,.meta,.buttons{display:flex;align-items:center}header{padding:24px 26px 10px}h2{font-size:23px;margin:0;flex:1}.close{border:0;background:transparent;font-size:29px;line-height:1;cursor:pointer;color:var(--pp-muted);padding:5px 8px}
        .meta{padding:0 26px 15px;color:var(--pp-muted);gap:10px;font-size:14px}.meta span{flex:1}.wrap{display:flex;gap:8px;align-items:center}
        textarea{margin:0 26px;min-height:290px;max-height:54vh;resize:vertical;border:1px solid var(--pp-border);border-radius:11px;padding:17px;font:16px/1.6 system-ui,sans-serif;color:var(--pp-text);background:var(--pp-field);box-sizing:border-box}
        textarea:focus{outline:3px solid color-mix(in srgb,var(--pp-primary) 28%,transparent);border-color:var(--pp-primary)}.buttons{justify-content:flex-end;gap:11px;padding:19px 26px 23px}button{font:600 15px system-ui,sans-serif;border-radius:9px;border:1px solid var(--pp-border);padding:11px 18px;background:var(--pp-button);color:var(--pp-text);cursor:pointer}button.primary{background:var(--pp-primary);border-color:var(--pp-primary);color:#fff}@media(prefers-color-scheme:dark){button.primary{color:#14151a}}button:hover{filter:brightness(.97)}
      </style>
      <div class="backdrop" role="presentation"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="pp-title">
        <header><h2 id="pp-title">Plyph result</h2><button class="close" aria-label="Close">×</button></header>
        <div class="meta"><span></span><label class="wrap"><input type="checkbox" checked> Wrap lines</label></div>
        <textarea aria-label="Generated result"></textarea>
        <div class="buttons"><button class="cancel">Cancel</button><button class="copy">Copy</button><button class="primary replace">Replace</button></div>
      </section></div>`;
    document.documentElement.append(host);
    const textarea = root.querySelector('textarea');
    textarea.value = output;
    updateCount(root, output);
    textarea.addEventListener('input', () => updateCount(root, textarea.value));
    root.querySelector('.wrap input').addEventListener('change', event => { textarea.wrap = event.target.checked ? 'soft' : 'off'; });
    root.querySelector('.close').addEventListener('click', closeDialog);
    root.querySelector('.cancel').addEventListener('click', closeDialog);
    root.querySelector('.copy').addEventListener('click', () => {
      copyResult(textarea)
        .then(() => showToast('Copied'))
        .catch(error => showToast(error.message || 'Could not copy the result.', 'error', 3500));
    });
    root.querySelector('.replace').addEventListener('click', () => replaceSelection(textarea.value));
    root.querySelector('.backdrop').addEventListener('click', event => { if (event.target.classList.contains('backdrop')) closeDialog(); });
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeDialog();
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') replaceSelection(textarea.value);
    });
    textarea.focus();
  }

  async function copyResult(textarea) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(textarea.value);
        return;
      } catch { /* HTTP pages need the user-activated fallback below. */ }
    }
    textarea.focus();
    textarea.select();
    if (!document.execCommand('copy')) throw new Error('Could not copy the result.');
  }

  function updateCount(root, value) {
    const words = value.trim() ? value.trim().split(/\s+/u).length : 0;
    root.querySelector('.meta span').textContent = `${words} ${words === 1 ? 'word' : 'words'} · ${value.length} characters`;
  }

  function closeDialog() { document.getElementById('plyph-host')?.remove(); }

  function showToast(message, type = 'normal', duration = 1800, anchor = snapshot) {
    removeToast();
    const host = document.createElement('div');
    host.id = 'plyph-toast';
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = `<style>:host{all:initial}.toast{position:fixed;z-index:2147483647;left:50%;bottom:32px;transform:translateX(-50%);max-width:min(560px,calc(100vw - 40px));padding:13px 18px;border-radius:11px;background:#172033;color:#fff;box-shadow:0 12px 30px rgba(0,0,0,.25);font:600 15px/1.45 system-ui,sans-serif;text-align:center}.toast.error{background:#b42318}.working{padding-left:38px}.working:before{content:'';position:absolute;margin-left:-22px;margin-top:2px;width:13px;height:13px;border:2px solid #ffffff66;border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><div class="toast"></div>`;
    const toast = root.querySelector('.toast');
    if (type === 'error') toast.classList.add('error');
    if (type === 'working') toast.classList.add('working');
    toast.textContent = message;
    document.documentElement.append(host);

    const placement = feedbackPlacement;
    const followsSelection = placement === 'pointer' && anchor;
    const followsMouse = placement === 'mouse' && pointerPosition;
    if (followsSelection || followsMouse) {
      const onMove = event => {
        if (event) pointerPosition = {x: event.clientX, y: event.clientY};
        positionToast(host, anchor, placement);
      };
      positionToast(host, anchor, placement);
      requestAnimationFrame(() => positionToast(host, anchor, placement));
      if (followsSelection) {
        window.addEventListener('scroll', onMove, {capture: true, passive: true});
        window.addEventListener('resize', onMove);
      }
      if (followsMouse) window.addEventListener('pointermove', onMove, {passive: true});
      toastAnchorListeners = () => {
        window.removeEventListener('scroll', onMove, {capture: true});
        window.removeEventListener('resize', onMove);
        window.removeEventListener('pointermove', onMove);
      };
    }
    if (type !== 'working') toastTimer = setTimeout(removeToast, duration);
  }

  function positionToast(host, selection, placement) {
    const toast = host.shadowRoot?.querySelector('.toast');
    if (!toast) return;
    const toastRect = toast.getBoundingClientRect();
    if (placement === 'mouse' && pointerPosition) {
      const gap = 14;
      let x = pointerPosition.x + gap;
      let y = pointerPosition.y + gap;
      if (x + toastRect.width > window.innerWidth - 6) x = pointerPosition.x - toastRect.width - gap;
      if (y + toastRect.height > window.innerHeight - 6) y = pointerPosition.y - toastRect.height - gap;
      setToastPosition(toast, x, y);
      return;
    }
    const rect = selection && selectionRect(selection);
    if (!rect) return;
    const x = rect.left + (rect.width - toastRect.width) / 2;
    const above = rect.top - toastRect.height - 10;
    const y = above >= 6 ? above : rect.bottom + 10;
    setToastPosition(toast, x, y);
  }

  function setToastPosition(toast, x, y) {
    const maxX = Math.max(6, window.innerWidth - toast.getBoundingClientRect().width - 6);
    const maxY = Math.max(6, window.innerHeight - toast.getBoundingClientRect().height - 6);
    toast.style.left = `${Math.max(6, Math.min(maxX, x))}px`;
    toast.style.top = `${Math.max(6, Math.min(maxY, y))}px`;
    toast.style.bottom = 'auto';
    toast.style.transform = 'none';
  }

  function removeToast() {
    clearTimeout(toastTimer);
    toastTimer = null;
    if (toastAnchorListeners) { toastAnchorListeners(); toastAnchorListeners = null; }
    document.getElementById('plyph-toast')?.remove();
  }
})();
