// ─── Popup Controller ─────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const btnRecord     = $('btnRecord');
const btnStop       = $('btnStop');
const btnSave       = $('btnSave');
const btnPlayCurrent = $('btnPlayCurrent');
const macroNameInput = $('macroName');
const actionCount   = $('actionCount');
const statusDot     = $('statusDot');
const saveSection   = $('saveSection');
const macroList     = $('macroList');

let currentMacro = [];

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  const state = await bg('GET_STATE');
  updateUI(state);
  loadMacroList();
})();

// ─── Button Handlers ──────────────────────────────────────────────────────────
btnRecord.addEventListener('click', async () => {
  await bg('START_RECORDING');
  currentMacro = [];
  updateUI({ isRecording: true, isReplaying: false, actionCount: 0 });
  // Poll action count while recording
  startCountPoller();
});

btnStop.addEventListener('click', async () => {
  stopCountPoller();
  const res = await bg('STOP_RECORDING');
  currentMacro = res.macro || [];
  updateUI({ isRecording: false, isReplaying: false, actionCount: currentMacro.length });
});

btnSave.addEventListener('click', async () => {
  const name = macroNameInput.value.trim();
  if (!name) { macroNameInput.focus(); return; }
  await bg('SAVE_MACRO', { name, macro: currentMacro });
  macroNameInput.value = '';
  loadMacroList();
});

btnPlayCurrent.addEventListener('click', async () => {
  if (!currentMacro.length) return;
  await bg('START_REPLAY', { macro: currentMacro });
  updateUI({ isRecording: false, isReplaying: true });
  window.close(); // close popup so page is accessible
});

// ─── Macro List ───────────────────────────────────────────────────────────────
async function loadMacroList() {
  const res = await bg('GET_MACROS');
  const macros = res.macros || {};
  const names = Object.keys(macros);

  if (!names.length) {
    macroList.innerHTML = '<div class="empty-state">No saved macros yet.</div>';
    return;
  }

  macroList.innerHTML = '';
  names.forEach(name => {
    const m = macros[name];
    const count = m.actions?.length ?? 0;

    const item = document.createElement('div');
    item.className = 'macro-item';
    item.innerHTML = `
      <span class="macro-name" title="${escHtml(name)}">${escHtml(name)}</span>
      <span class="macro-meta">${count} steps</span>
      <button class="btn-play-small" data-name="${escHtml(name)}">▶ Play</button>
      <button class="btn-delete" data-name="${escHtml(name)}" title="Delete">✕</button>
    `;

    item.querySelector('.btn-play-small').addEventListener('click', async () => {
      const res2 = await bg('GET_MACROS');
      const macro = res2.macros?.[name]?.actions;
      if (!macro) return;
      await bg('START_REPLAY', { macro });
      window.close();
    });

    item.querySelector('.btn-delete').addEventListener('click', async () => {
      await bg('DELETE_MACRO', { name });
      loadMacroList();
    });

    macroList.appendChild(item);
  });
}

// ─── UI Sync ──────────────────────────────────────────────────────────────────
function updateUI({ isRecording, isReplaying, actionCount: count }) {
  btnRecord.disabled = isRecording || isReplaying;
  btnStop.disabled = !isRecording;

  statusDot.className = 'status-dot';
  if (isRecording) statusDot.classList.add('recording');
  if (isReplaying) statusDot.classList.add('replaying');

  const c = count ?? currentMacro.length;
  $('actionCount').textContent = `${c} action${c !== 1 ? 's' : ''}`;

  saveSection.style.display = (!isRecording && currentMacro.length > 0) ? '' : 'none';
}

// ─── Count Poller (while recording) ──────────────────────────────────────────
let _poller = null;
function startCountPoller() {
  _poller = setInterval(async () => {
    const state = await bg('GET_STATE');
    if (!state.isRecording) { stopCountPoller(); return; }
    $('actionCount').textContent = `${state.actionCount} action${state.actionCount !== 1 ? 's' : ''}`;
  }, 500);
}
function stopCountPoller() {
  clearInterval(_poller);
  _poller = null;
}

// ─── Messaging helper ─────────────────────────────────────────────────────────
function bg(type, extra = {}) {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type, ...extra }, res => resolve(res || {}))
  );
}

function escHtml(str) {
  return str.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
