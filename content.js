// ─── Content Script: Record & Replay ─────────────────────────────────────────
(function () {
  if (window.__macroInjected) return;
  window.__macroInjected = true;

  let recording = false;
  let navigating = false;

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
        sendResponse({ ok: true });
        break;

      case 'REPLAY_ACTION':
        replayAction(msg.action).then(() => {
          if (!navigating) {
            chrome.runtime.sendMessage({ type: 'ACTION_DONE' });
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

  // ── Recording: capture events ─────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    if (!recording) return;
    const target = e.target.closest('button, a, input[type=submit], input[type=button], input[type=checkbox], input[type=radio], [role=button], [onclick], select, label');
    if (!target) return;

    const action = {
      type: 'click',
      selector: getSelector(target),
      selectorAlts: getSelectorAlts(target),
      text: target.textContent?.trim().substring(0, 80) || '',
      tag: target.tagName.toLowerCase(),
      url: location.href,
      timestamp: Date.now(),
    };

    chrome.runtime.sendMessage({ type: 'RECORD_ACTION', action });
  }, true);

  document.addEventListener('change', (e) => {
    if (!recording) return;
    const target = e.target;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

    const inputType = target.type?.toLowerCase();
    if (['checkbox', 'radio', 'submit', 'button'].includes(inputType)) return; // handled by click

    const action = {
      type: target.tagName === 'SELECT' ? 'select' : 'fill',
      selector: getSelector(target),
      selectorAlts: getSelectorAlts(target),
      value: target.value,
      tag: target.tagName.toLowerCase(),
      url: location.href,
      timestamp: Date.now(),
    };

    chrome.runtime.sendMessage({ type: 'RECORD_ACTION', action });
  }, true);

  // Detect navigation
  window.addEventListener('beforeunload', () => {
    if (recording) {
      navigating = true;
      chrome.runtime.sendMessage({
        type: 'RECORD_ACTION',
        action: { type: 'navigate', url: location.href, timestamp: Date.now() }
      });
    }
  });

  // ── Replay: execute actions ───────────────────────────────────────────────
  async function replayAction(action) {
    navigating = false;

    if (action.type === 'navigate') {
      // No-op, just a breadcrumb
      return;
    }

    const el = await waitForElement(action);
    if (!el) {
      console.warn('[Macro] Could not find element for action:', action);
      showToast(`⚠️ Element not found: ${action.selector?.substring(0, 40)}`);
      return;
    }

    // Scroll into view
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(150);

    if (action.type === 'fill') {
      el.focus();
      el.value = '';
      el.value = action.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (action.type === 'select') {
      el.focus();
      el.value = action.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (action.type === 'click') {
      // Check if click will navigate
      const willNavigate = (
        (el.tagName === 'A' && el.href && !el.href.startsWith('javascript:')) ||
        el.type === 'submit' ||
        el.closest('form') && el.type === 'submit'
      );

      if (willNavigate) {
        navigating = true;
        chrome.runtime.sendMessage({ type: 'ACTION_NAVIGATED' });
      }

      el.click();
    }

    await sleep(100);
  }

  // ── Element finding ───────────────────────────────────────────────────────
  async function waitForElement(action, timeout = 7000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = findElement(action);
      if (el) return el;
      await sleep(150);
    }
    return null;
  }

  function findElement(action) {
    // Try all stored selectors in priority order
    const selectors = [action.selector, ...(action.selectorAlts || [])].filter(Boolean);

    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) return el;
      } catch (e) { /* invalid selector */ }
    }

    // Fallback: text match for buttons/links
    if (action.text && ['button', 'a', 'input'].includes(action.tag)) {
      const candidates = document.querySelectorAll(
        `${action.tag}, [role=button]`
      );
      for (const el of candidates) {
        if (el.textContent?.trim() === action.text && isVisible(el)) return el;
      }
    }

    return null;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      (rect.width > 0 || rect.height > 0)
    );
  }

  // ── Selector Generation ───────────────────────────────────────────────────
  function getSelector(el) {
    // Best unique selector
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
    if (el.getAttribute('aria-label')) return `[aria-label="${CSS.escape(el.getAttribute('aria-label'))}"]`;
    if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
    return buildCSSPath(el);
  }

  function getSelectorAlts(el) {
    const alts = [];
    // Collect multiple fallback selectors
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).filter(c => c && !c.match(/^(active|hover|focus|selected|is-)/));
      if (cls.length) alts.push(`${el.tagName.toLowerCase()}.${cls.map(c => CSS.escape(c)).join('.')}`);
    }
    if (el.getAttribute('placeholder')) {
      alts.push(`[placeholder="${CSS.escape(el.getAttribute('placeholder'))}"]`);
    }
    if (el.getAttribute('type') && el.name) {
      alts.push(`input[type="${el.getAttribute('type')}"][name="${CSS.escape(el.name)}"]`);
    }
    alts.push(buildCSSPath(el));
    return [...new Set(alts)].slice(0, 4);
  }

  function buildCSSPath(el) {
    const parts = [];
    let node = el;
    while (node && node.tagName && node.tagName !== 'HTML') {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      if (parts.length >= 6) break; // cap depth
    }
    return parts.join(' > ');
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function showToast(text) {
    const id = '__macro_toast__';
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = `
        position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        background: #1a1a2e; color: #fff; border-radius: 8px;
        padding: 10px 16px; font: 14px/1.4 system-ui, sans-serif;
        box-shadow: 0 4px 20px rgba(0,0,0,.4);
        transition: opacity 0.3s; pointer-events: none;
      `;
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(el._timeout);
    el._timeout = setTimeout(() => el.style.opacity = '0', 2500);
  }

})();
