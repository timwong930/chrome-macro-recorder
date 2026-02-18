// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  isRecording: false,
  isReplaying: false,
  currentMacro: [],
  replayMacro: [],
  replayIndex: 0,
  replayTabId: null,
  replayPaused: false, // paused waiting for page load
};

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'GET_STATE':
      sendResponse({
        isRecording: state.isRecording,
        isReplaying: state.isReplaying,
        actionCount: state.currentMacro.length,
      });
      break;

    // ── Recording ──
    case 'START_RECORDING':
      state.isRecording = true;
      state.currentMacro = [];
      broadcastToActiveTab({ type: 'START_RECORDING' });
      sendResponse({ ok: true });
      break;

    case 'STOP_RECORDING':
      state.isRecording = false;
      broadcastToActiveTab({ type: 'STOP_RECORDING' });
      sendResponse({ macro: state.currentMacro, count: state.currentMacro.length });
      break;

    case 'RECORD_ACTION':
      if (state.isRecording) {
        state.currentMacro.push(msg.action);
        console.log('[Macro] Recorded:', msg.action.type, msg.action.selector);
      }
      sendResponse({ ok: true, total: state.currentMacro.length });
      break;

    // ── Storage ──
    case 'SAVE_MACRO':
      saveMacro(msg.name, msg.macro || state.currentMacro, () => sendResponse({ ok: true }));
      return true; // async

    case 'DELETE_MACRO':
      deleteMacro(msg.name, () => sendResponse({ ok: true }));
      return true;

    case 'GET_MACROS':
      chrome.storage.local.get('macros', (data) => sendResponse({ macros: data.macros || {} }));
      return true;

    // ── Replay ──
    case 'START_REPLAY':
      startReplay(msg.macro);
      sendResponse({ ok: true });
      break;

    case 'STOP_REPLAY':
      state.isReplaying = false;
      state.replayPaused = false;
      broadcastToActiveTab({ type: 'REPLAY_COMPLETE' });
      sendResponse({ ok: true });
      break;

    case 'ACTION_DONE':
      // Content script finished one action; move to next
      replayNext();
      sendResponse({ ok: true });
      break;

    case 'ACTION_NAVIGATED':
      // Content script detected navigation - pause and wait for tab update
      state.replayPaused = true;
      sendResponse({ ok: true });
      break;
  }
  return true;
});

// ─── Tab load listener (resume replay after page navigation) ─────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    state.isReplaying &&
    state.replayPaused &&
    tabId === state.replayTabId &&
    changeInfo.status === 'complete'
  ) {
    state.replayPaused = false;
    // Small delay to let page scripts initialize
    setTimeout(() => {
      // Re-inject start recording if recording
      if (state.isRecording) {
        chrome.tabs.sendMessage(tabId, { type: 'START_RECORDING' });
      }
      sendReplayAction(tabId);
    }, 600);
  }
});

// ─── Replay helpers ───────────────────────────────────────────────────────────
function startReplay(macro) {
  state.isReplaying = true;
  state.replayIndex = 0;
  state.replayMacro = macro;
  state.replayPaused = false;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    state.replayTabId = tabs[0].id;
    sendReplayAction(state.replayTabId);
  });
}

function replayNext() {
  if (!state.isReplaying || state.replayPaused) return;
  if (state.replayTabId) sendReplayAction(state.replayTabId);
}

function sendReplayAction(tabId) {
  if (state.replayIndex >= state.replayMacro.length) {
    state.isReplaying = false;
    chrome.tabs.sendMessage(tabId, { type: 'REPLAY_COMPLETE' });
    return;
  }

  const action = state.replayMacro[state.replayIndex];
  state.replayIndex++;

  chrome.tabs.sendMessage(tabId, { type: 'REPLAY_ACTION', action }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('[Macro] Replay send error:', chrome.runtime.lastError.message);
    }
  });
}

// ─── Storage helpers ──────────────────────────────────────────────────────────
function saveMacro(name, macro, cb) {
  chrome.storage.local.get('macros', (data) => {
    const macros = data.macros || {};
    macros[name] = { actions: macro, savedAt: Date.now() };
    chrome.storage.local.set({ macros }, cb);
  });
}

function deleteMacro(name, cb) {
  chrome.storage.local.get('macros', (data) => {
    const macros = data.macros || {};
    delete macros[name];
    chrome.storage.local.set({ macros }, cb);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function broadcastToActiveTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, msg, () => chrome.runtime.lastError);
  });
}
