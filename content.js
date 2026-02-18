// ─── Content Script: Record & Replay ─────────────────────────────────────────
(function () {
  if (window.__macroInjected) return;
  window.__macroInjected = true;

  let recording = false;
  let navigating = false;
  // Track last known value per selector to deduplicate input events
  const inputValues = new Map();

  // On page load, check if we should be recording (survives page navigation)
  chrome.storage.session.get('isRecording', (data) => {
    if (data.isRecording) {
      recording = true;
      showToast('🔴 Recording...');
    }
  });

  // ── Listen for commands from background ──────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'START_RECORDING':
        recording = true;
        showToast('🔴 Recording...');
        sendResponse({ ok: true });
        break;

      case 'STOP_RECORDING':
        recording = false;
        showToast('⏹ Recording stopped');
        inputValues.clear();
        sendResponse({ ok: true });
        break;

      case 'REPLAY_ACTION':
        replayAction(msg.action, msg.postDelay || 400).then(() => {
          if (!navigating) {
            chrome.runtime.sendMessage({ type: 'ACTION_DONE' }, () => chrome.runtime.lastError);
          }
        });
        sendResponse({ ok: true });
        break;

      case 'REPLAY_COMPLETE':
        showToast('✅ Macro complete!');
        sendResponse({ ok: true });
        break;
    }
    return true;
  });

  // ── Recording: capture clicks ─────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    if (!recording) return;
    if (!e.target || typeof e.target.closest !== 'function') return;

    const target = e.target.closest(
      'button, a, input[type=submit], input[type=button], ' +
      'input[type=checkbox], input[type=radio], [role=button], select, label'
    );
    if (!target) return;

    // Flush any pending input value before recording the click
    flushActiveInput();

    recordAction({
      type: 'click',
      selector: getSelector(target),
      selectorAlts: getSelectorAlts(target),
      text: (target.textContent || target.value || target.getAttribute('aria-label') || '').trim().substring(0, 100),
      tag: target.tagName.toLowerCase(),
      inputType: target.type || null,
      checked: target.type === 'checkbox' || target.type === 'radio' ? target.checked : undefined,
    });
  }, true);

  // ── Recording: capture text input (fires on every keystroke) ─────────────
  document.addEventListener('input', (e) => {
    if (!recording) return;
    const target = e.target;
    if (!['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
    const inputType = (target.type || '').toLowerCase();
    if (['checkbox', 'radio', 'submit', 'button', 'file'].includes(inputType)) return;

    // Store the latest value; we'll flush it on blur or before a click
    const sel = getSelector(target);
    inputValues.set(sel, { target, value: target.value });
  }, true);

  // ── Recording: flush input values on blur ─────────────────────────────────
  document.addEventListener('blur', (e) => {
    if (!recording) return;
    const target = e.target;
    if (!['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
    const sel = getSelector(target);
    const pending = inputValues.get(sel);
    if (pending) {
      sendFillAction(target, sel);
      inputValues.delete(sel);
    }
  }, true);

  // ── Recording: capture select dropdowns ──────────────────────────────────
  document.addEventListener('change', (e) => {
    if (!recording) return;
    const target = e.target;
    if (target.tagName !== 'SELECT') return;

    recordAction({
      type: 'select',
      selector: getSelector(target),
      selectorAlts: getSelectorAlts(target),
      value: target.value,
      label: target.options[target.selectedIndex]?.text || target.value,
      tag: 'select',
    });
  }, true);

  // ── Detect navigation ─────────────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    if (!recording) return;
    // Flush any pending input
    for (const [sel, { target }] of inputValues.entries()) {
      sendFillAction(target, sel);
    }
    inputValues.clear();
    navigating = true;
    recordAction({ type: 'navigate', url: location.href });
  });

  // ── Helpers: send fill action ─────────────────────────────────────────────
  function sendFillAction(target, sel) {
    recordAction({
      type: 'fill',
      selector: sel,
      selectorAlts: getSelectorAlts(target),
      value: target.value,
      tag: target.tagName.toLowerCase(),
      inputType: target.type || null,
      placeholder: target.placeholder || null,
    });
  }

  function flushActiveInput() {
    // Flush whichever input currently has focus
    const active = document.activeElement;
    if (!active) return;
    if (!['INPUT', 'TEXTAREA'].includes(active.tagName)) return;
    const sel = getSelector(active);
    if (inputValues.has(sel)) {
      sendFillAction(active, sel);
      inputValues.delete(sel);
    }
  }

  function recordAction(action) {
    chrome.runtime.sendMessage(
      { type: 'RECORD_ACTION', action: { ...action, url: location.href, timestamp: Date.now() } },
      () => chrome.runtime.lastError // suppress errors
    );
  }

  // ── Replay: execute actions ───────────────────────────────────────────────
  async function replayAction(action, postDelay) {
    navigating = false;

    if (action.type === 'navigate') return; // just a breadcrumb

    showStepToast(action);

    const el = await waitForElement(action);
    if (!el) {
      console.warn('[Macro] Could not find element:', action.selector);
      showToast(`⚠️ Could not find element — skipping step`);
      await sleep(postDelay || 400);
      return;
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(120);

    if (action.type === 'fill') {
      el.focus();
      await sleep(80);
      // Use native setter so React/Vue controlled inputs pick up the change
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype,
        'value'
      )?.set;
      if (nativeSetter) nativeSetter.call(el, action.value);
      else el.value = action.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

    } else if (action.type === 'select') {
      el.focus();
      el.value = action.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));

    } else if (action.type === 'click') {
      const willNavigate = (
        (el.tagName === 'A' && el.href && !el.href.startsWith('javascript:')) ||
        el.type === 'submit' ||
        (el.closest('form') && el.type === 'submit')
      );
      if (willNavigate) {
        navigating = true;
        chrome.runtime.sendMessage({ type: 'ACTION_NAVIGATED' }, () => chrome.runtime.lastError);
      }

      if (action.inputType === 'checkbox' && action.checked !== undefined) {
        if (el.checked !== action.checked) el.click();
      } else {
        el.click();
      }
    }

    // Wait the recorded inter-action gap before signalling done.
    // This is what makes the replay pause appropriately for popups/loaders.
    if (!navigating) await sleep(postDelay || 400);
  }

  // ── Element finding ───────────────────────────────────────────────────────
  // MutationObserver-based: reacts the instant a popup/element appears in the DOM
  // rather than polling every 200ms. Falls back to a timeout.
  function waitForElement(action, timeout = 15000) {
    // Check immediately — element might already be there
    const immediate = findElement(action);
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let done = false;

      const finish = (el) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      };

      const observer = new MutationObserver(() => {
        const el = findElement(action);
        if (el) finish(el);
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        // Also watch for attribute changes — handles show/hide via class or style
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'disabled', 'aria-hidden'],
      });

      // Hard timeout — give up after 15s and skip the step
      const timer = setTimeout(() => finish(null), timeout);
    });
  }

  function findElement(action) {
    const selectors = [action.selector, ...(action.selectorAlts || [])].filter(Boolean);

    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) return el;
      } catch (_) {}
    }

    // Text-content fallback for buttons and links
    if (action.text) {
      const tags = action.tag ? [action.tag, '[role=button]'] : ['button', 'a', '[role=button]'];
      for (const tag of tags) {
        for (const el of document.querySelectorAll(tag)) {
          const elText = (el.textContent || el.value || '').trim();
          if (elText === action.text && isVisible(el)) return el;
        }
      }
    }

    // Placeholder fallback for inputs
    if (action.placeholder) {
      const el = document.querySelector(`[placeholder="${CSS.escape(action.placeholder)}"]`);
      if (el && isVisible(el)) return el;
    }

    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  // ── Selector Generation ───────────────────────────────────────────────────
  function getSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.getAttribute('data-testid')) return `[data-testid="${CSS.escape(el.getAttribute('data-testid'))}"]`;
    if (el.getAttribute('aria-label')) return `[aria-label="${CSS.escape(el.getAttribute('aria-label'))}"]`;
    if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
    return buildCSSPath(el);
  }

  function getSelectorAlts(el) {
    const alts = [];
    if (el.getAttribute('placeholder')) {
      alts.push(`[placeholder="${CSS.escape(el.getAttribute('placeholder'))}"]`);
    }
    if (el.getAttribute('type') && el.name) {
      alts.push(`input[type="${el.getAttribute('type')}"][name="${CSS.escape(el.name)}"]`);
    }
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/)
        .filter(c => c && !/^(active|hover|focus|selected|is-|has-)/.test(c));
      if (cls.length && cls.length <= 4) {
        alts.push(`${el.tagName.toLowerCase()}.${cls.map(c => CSS.escape(c)).join('.')}`);
      }
    }
    alts.push(buildCSSPath(el));
    return [...new Set(alts)].slice(0, 4);
  }

  function buildCSSPath(el) {
    const parts = [];
    let node = el;
    while (node && node.tagName && node.tagName !== 'HTML') {
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
      if (parts.length >= 6) break;
    }
    return parts.join(' > ');
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function showStepToast(action) {
    const labels = {
      click: `🖱 Click: ${action.text || action.selector?.substring(0, 40) || '?'}`,
      fill:  `⌨️ Type into: ${action.placeholder || action.selector?.substring(0, 40) || '?'}`,
      select:`📋 Select: ${action.label || action.value || '?'}`,
    };
    showToast(labels[action.type] || `▶ ${action.type}`);
  }

  function showToast(text) {
    const id = '__macro_toast__';
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      Object.assign(el.style, {
        position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647',
        background: '#1a1a2e', color: '#fff', borderRadius: '8px',
        padding: '10px 16px', font: '14px/1.4 system-ui,sans-serif',
        boxShadow: '0 4px 20px rgba(0,0,0,.4)',
        transition: 'opacity 0.3s', pointerEvents: 'none',
      });
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 2500);
  }

})();
