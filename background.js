// ─── State (in-memory cache; session storage is the source of truth) ─────────
let state = {
  isRecording: false,
  isReplaying: false,
  currentMacro: [],
  replayMacro: [],
  replayIndex: 0,
  replayTabId: null,
  replayPaused: false,
};

// Restore from session storage on service worker startup
// (Chrome MV3 kills the service worker when idle; this revives it)
chrome.storage.session.get(['isRecording', 'currentMacro'], (data) => {
  if (data.isRecording) state.isRecording = data.isRecording;
  if (data.currentMacro) state.currentMacro = data.currentMacro;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function persistRecordingState() {
  chrome.storage.session.set({
    isRecording: state.isRecording,
    currentMacro: state.currentMacro,
  });
}

function broadcastToActiveTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, msg, () => chrome.runtime.lastError);
    }
  });
}

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

    // ── Recording ─────────────────────────────────────────────────────────────
    case 'START_RECORDING':
      state.isRecording = true;
      state.currentMacro = [];
      persistRecordingState();
      broadcastToActiveTab({ type: 'START_RECORDING' });
      sendResponse({ ok: true });
      break;

    case 'STOP_RECORDING':
      state.isRecording = false;
      broadcastToActiveTab({ type: 'STOP_RECORDING' });
      persistRecordingState();
      sendResponse({ macro: state.currentMacro, count: state.currentMacro.length });
      break;

    case 'RECORD_ACTION': {
      // Re-check session storage in case service worker restarted mid-recording
      const addAction = () => {
        if (state.isRecording) {
          // Deduplicate consecutive fill actions on the same selector
          const last = state.currentMacro[state.currentMacro.length - 1];
          if (
            msg.action.type === 'fill' &&
            last?.type === 'fill' &&
            last?.selector === msg.action.selector
          ) {
            state.currentMacro[state.currentMacro.length - 1] = msg.action;
          } else {
            state.currentMacro.push(msg.action);
          }
          persistRecordingState();
          console.log(`[Macro] Recorded #${state.currentMacro.length}:`, msg.action.type, msg.action.selector || msg.action.value);
        }
        sendResponse({ ok: true, total: state.currentMacro.length });
      };

      if (!state.isRecording) {
        // Service worker may have restarted - check session storage
        chrome.storage.session.get(['isRecording', 'currentMacro'], (data) => {
          state.isRecording = data.isRecording || false;
          state.currentMacro = data.currentMacro || [];
          addAction();
        });
        return true; // async
      }
      addAction();
      break;
    }

    // ── Storage ───────────────────────────────────────────────────────────────
    case 'SAVE_MACRO':
      saveMacro(msg.name, msg.macro || state.currentMacro, () => sendResponse({ ok: true }));
      return true;

    case 'DELETE_MACRO':
      deleteMacro(msg.name, () => sendResponse({ ok: true }));
      return true;

    case 'GET_MACROS':
      chrome.storage.local.get('macros', (data) => sendResponse({ macros: data.macros || {} }));
      return true;

    // ── Replay ────────────────────────────────────────────────────────────────
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
      replayNext();
      sendResponse({ ok: true });
      break;

    case 'ACTION_NAVIGATED':
      state.replayPaused = true;
      sendResponse({ ok: true });
      break;
  }
  return true;
});

// ─── Tab load: resume replay or recording after navigation ───────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;

  // Resume replay after page load
  if (state.isReplaying && state.replayPaused && tabId === state.replayTabId) {
    state.replayPaused = false;
    setTimeout(() => sendReplayAction(tabId), 700);
  }

  // Resume recording on new page (content script checks session storage itself,
  // but send the message too as a fast-path)
  if (state.isRecording) {
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: 'START_RECORDING' }, () => chrome.runtime.lastError);
    }, 300);
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
  const action = state.replayMacro[state.replayIndex++];
  chrome.tabs.sendMessage(tabId, { type: 'REPLAY_ACTION', action }, () => chrome.runtime.lastError);
}

// ─── Storage helpers ──────────────────────────────────────────────────────────
function saveMacro(name, macro, cb) {
  chrome.storage.local.get('macros', (data) => {
    const macros = data.macros || {};
    macros[name] = { actions: macro, savedAt: Date.now(), count: macro.length };
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
