// app.js – 감귤 조사 PWA 메인 앱 (스키마 기반 음성 입력)
import { getFields, saveFields, resetFields, addField, updateField, removeField, generateAliases } from './field-config.js';
import { parseVoice, canOverwrite, runTests } from './parser.js';

'use strict';

// ─── VAD 모드별 silence 임계 (ms) ─────────────────────────
const VAD_TIMEOUT = { fast: 750, balanced: 1200, accurate: 1700 };

// ─── 상태 ──────────────────────────────────────────────────
const state = {
  isRecording: false,
  recognition: null,
  vadMode: 'balanced',     // fast | balanced | accurate
  ttsRate: 0.92,
  currentData: {},         // { fieldId: { value, warn, time } }
  lastSaved: null,         // { fieldId, value, time }
  pendingField: null,      // { field } – 값 대기 중
  memoMode: false,
  llmStatus: 'unavailable', // unavailable | loading | ready | failed
  logs: [],
  silenceTimer: null,
};

// ─── TTS ────────────────────────────────────────────────────
function speak(text) {
  if (!window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  u.rate = state.ttsRate;
  u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}

// ─── 로그 ───────────────────────────────────────────────────
function addLog(entry) {
  const item = {
    id: Date.now() + Math.random(),
    ts: new Date().toISOString(),
    ...entry
  };
  state.logs.unshift(item);
  if (state.logs.length > 300) state.logs.length = 300;
  try { localStorage.setItem('citrusLogs_v3', JSON.stringify(state.logs.slice(0, 200))); } catch {}
  return item;
}

function loadLogs() {
  try {
    const raw = localStorage.getItem('citrusLogs_v3');
    if (raw) state.logs = JSON.parse(raw);
  } catch {}
}

// ─── 음성 인식 ──────────────────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function startRecording() {
  if (!SR) { showToast('이 브라우저는 음성인식을 지원하지 않습니다'); return; }
  if (state.isRecording) return;

  state.recognition = new SR();
  const r = state.recognition;
  r.lang = 'ko-KR';
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 3;

  r.onstart = () => {
    state.isRecording = true;
    updateMicBtn();
    addLog({ event: 'rec_start' });
  };

  r.onresult = (e) => {
    clearSilenceTimer();
    let interim = '', finalText = '';

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const tx = res[0].transcript;
      if (res.isFinal) {
        finalText += tx;
      } else {
        interim += tx;
      }
    }

    if (interim) {
      showInterim(interim);
    }

    if (finalText) {
      showInterim('');
      processFinalText(finalText.trim(), e.results[e.resultIndex]?.[0]?.confidence ?? 1);
    } else if (interim) {
      // 침묵 타이머: VAD 모드에 따라 자동 확정
      startSilenceTimer(interim);
    }
  };

  r.onerror = (e) => {
    addLog({ event: 'rec_error', error: e.error });
    if (e.error === 'not-allowed') {
      showToast('마이크 권한이 필요합니다');
      stopRecording();
    } else if (e.error === 'no-speech') {
      // 무시 – 계속 녹음
    } else if (e.error === 'network') {
      showToast('네트워크 오류 – 재시도 중...');
      scheduleRestart();
    } else if (e.error !== 'aborted') {
      stopRecording();
    }
  };

  r.onend = () => {
    if (state.isRecording) scheduleRestart();
  };

  try { r.start(); } catch(e) {
    addLog({ event: 'rec_start_fail', err: e.message });
    showToast('시작 실패: ' + e.message);
  }
}

function scheduleRestart() {
  setTimeout(() => {
    if (state.isRecording && state.recognition) {
      try { state.recognition.start(); } catch {}
    }
  }, 300);
}

function stopRecording() {
  state.isRecording = false;
  clearSilenceTimer();
  updateMicBtn();
  if (state.recognition) {
    try { state.recognition.stop(); } catch {}
    state.recognition = null;
  }
  addLog({ event: 'rec_stop' });
  speak('종료');
}

function toggleRecording() {
  if (state.isRecording) {
    stopRecording();
  } else {
    startRecording();
    speak('시작');
  }
}

function startSilenceTimer(interimText) {
  clearSilenceTimer();
  const ms = VAD_TIMEOUT[state.vadMode] || 1200;
  state.silenceTimer = setTimeout(() => {
    if (interimText.trim()) {
      processFinalText(interimText.trim(), 0.7);
      showInterim('');
    }
  }, ms);
}

function clearSilenceTimer() {
  if (state.silenceTimer) { clearTimeout(state.silenceTimer); state.silenceTimer = null; }
}

// ─── 음성 처리 ──────────────────────────────────────────────
function processFinalText(text, confidence) {
  const fields = getFields();

  // === 취소 명령 ===
  if (/^(취소|캔슬|cancel)$/i.test(text)) {
    // undo last
    const lastKey = Object.keys(state.currentData).pop();
    if (lastKey) {
      const old = state.currentData[lastKey];
      delete state.currentData[lastKey];
      speak('취소');
      addLog({ event: 'undo', fieldId: lastKey });
      renderFields();
    }
    showFinal(text);
    return;
  }

  // === 비고 모드 진입 후 텍스트 수집 ===
  if (state.memoMode) {
    const memoField = fields.find(f => f.freeText);
    if (memoField) {
      state.currentData[memoField.id] = { value: text, warn: false, time: Date.now() };
      state.lastSaved = { fieldId: memoField.id, value: text, time: Date.now() };
      state.memoMode = false;
      speak('비고 저장');
      addLog({ event: 'save', field: memoField.name, value: text, method: 'memo_mode', confidence });
      renderAll();
    }
    showFinal(text);
    setPendingBar(null);
    return;
  }

  // === overwrite 시도: 숫자만 나온 경우 ===
  const owResult = canOverwrite(text, state.lastSaved, fields);
  if (owResult && /^[\d.,가-힣점]+$/.test(text.replace(/\s/g, ''))) {
    const { field, value, warn } = owResult;
    state.currentData[field.id] = { value, warn, time: Date.now() };
    state.lastSaved = { fieldId: field.id, value, time: Date.now() };
    const ttsText = field.name + ' ' + value + (warn ? ' 주의' : '');
    speak(ttsText);
    addLog({ event: 'overwrite', field: field.name, value, confidence });
    renderAll();
    showFinal(text);
    renderParseResult([{ field, value, status: 'ok', warn, method: 'overwrite', raw: text }]);
    return;
  }

  // === 규칙 기반 파서 ===
  const parsed = parseVoice(text, fields);
  showFinal(text);
  renderParseResult(parsed);

  if (parsed.length === 0) {
    addLog({ event: 'no_match', text, confidence });
    return;
  }

  let savedAny = false;
  for (const item of parsed) {
    const { field, value, status, warn, method } = item;

    if (!field) continue;

    // 비고 모드 진입
    if (field.freeText && (value === null || value === '')) {
      state.memoMode = true;
      setPendingBar(`"${field.name}" 모드: 다음 발화를 메모로 저장`);
      speak('비고');
      addLog({ event: 'memo_mode_enter' });
      continue;
    }

    if (status === 'ok' && value !== null) {
      state.currentData[field.id] = { value, warn, time: Date.now() };
      state.lastSaved = { fieldId: field.id, value, time: Date.now() };
      state.pendingField = null;
      const ttsText = field.name.replace('조사', '') + ' ' + value + (warn ? ' 주의' : '');
      speak(ttsText);
      addLog({ event: 'save', field: field.name, value, method, confidence, warn });
      savedAny = true;
    } else if (status === 'pending') {
      state.pendingField = { field };
      setPendingBar(`"${field.name}" 값을 말해주세요`);
      addLog({ event: 'pending', field: field.name, confidence });
    } else if (status === 'noise') {
      addLog({ event: 'noise', field: field.name, raw: item.raw, confidence });
      showToast('⚠️ 비정상 숫자 무시됨');
    } else if (status === 'invalid') {
      addLog({ event: 'invalid', field: field.name, raw: item.raw, confidence });
    }
  }

  if (savedAny) {
    setPendingBar(null);
    renderAll();
  }
}

// ─── UI 헬퍼 ────────────────────────────────────────────────
function showInterim(text) {
  const el = document.getElementById('transcriptInterim');
  if (el) el.textContent = text;
}

function showFinal(text) {
  const el = document.getElementById('transcriptFinal');
  if (el) el.textContent = text;
}

function setPendingBar(msg) {
  const el = document.getElementById('pendingBar');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.classList.add('visible');
  } else {
    el.classList.remove('visible');
    state.pendingField = null;
  }
}

function updateMicBtn() {
  const btn = document.getElementById('micBtn');
  if (!btn) return;
  if (state.isRecording) {
    btn.classList.add('recording');
    btn.innerHTML = '⏹<div class="mic-label">중지</div>';
  } else {
    btn.classList.remove('recording');
    btn.innerHTML = '🎤<div class="mic-label">시작</div>';
  }
}

function showToast(msg, dur = 2200) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.add('hidden'), dur);
}

// ─── 렌더링 ──────────────────────────────────────────────────
function renderAll() {
  renderFields();
  renderLogTable();
}

function renderFields() {
  const el = document.getElementById('fieldsGrid');
  if (!el) return;
  const fields = getFields();
  el.innerHTML = fields.map(f => {
    const entry = state.currentData[f.id];
    const val = entry?.value;
    const warn = entry?.warn;
    let cls = '';
    if (val !== undefined && val !== null) cls = warn ? 'warn-val' : 'has-value';
    const display = (val !== undefined && val !== null) ? val : '--';
    return `<div class="field-card ${cls}">
      <div class="field-name">${f.name}</div>
      <div class="field-val">${display}</div>
      <div class="field-unit">${f.unit || (f.freeText ? '메모' : '')}</div>
    </div>`;
  }).join('');
}

function renderParseResult(parsed) {
  const el = document.getElementById('parseResult');
  if (!el) return;
  if (!parsed || parsed.length === 0) {
    el.innerHTML = '<div class="parse-result"><h3>파싱 결과</h3><div class="token-list" style="color:var(--text2);font-size:12px">매칭 없음</div></div>';
    return;
  }
  const chips = parsed.map(p => {
    let cls = p.status;
    if (p.status === 'ok' && p.warn) cls = 'warn';
    const label = p.field
      ? (p.value !== null ? `${p.field.name} = ${p.value}` : `${p.field.name} ?`)
      : (p.raw || '?');
    const method = p.method ? ` [${p.method}]` : '';
    return `<span class="token ${cls}" title="${method}">${label}${p.warn ? ' ⚠️' : ''}</span>`;
  }).join('');
  el.innerHTML = `<div class="parse-result"><h3>파싱 결과</h3><div class="token-list">${chips}</div></div>`;
}

// ─── 로그 탭 ────────────────────────────────────────────────
function renderLogTable() {
  const el = document.getElementById('logTable');
  if (!el) return;
  const rows = state.logs.filter(l => ['save', 'overwrite', 'pending', 'noise', 'invalid', 'no_match'].includes(l.event)).slice(0, 40);
  if (!rows.length) {
    el.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text2);padding:16px">아직 로그 없음</td></tr>';
    return;
  }
  el.innerHTML = rows.map(l => {
    const conf = Math.round((l.confidence || 0) * 100);
    const confColor = conf > 80 ? 'var(--success)' : conf > 50 ? 'var(--warn)' : 'var(--error)';
    const badge = l.event === 'save' || l.event === 'overwrite'
      ? `<span style="color:var(--success)">저장</span>`
      : l.event === 'pending' ? `<span style="color:var(--warn)">대기</span>`
      : l.event === 'noise'   ? `<span style="color:var(--error)">노이즈</span>`
      : `<span style="color:var(--text2)">${l.event}</span>`;
    return `<tr>
      <td>${l.ts.substring(11,19)}</td>
      <td>${l.field || '-'}</td>
      <td>${l.value ?? l.text ?? l.raw ?? '-'}</td>
      <td>${badge}</td>
    </tr>`;
  }).join('');

  const raw = document.getElementById('logRaw');
  if (raw) raw.textContent = state.logs.slice(0, 30).map(l => JSON.stringify(l)).join('\n');

  const cnt = document.getElementById('logCount');
  if (cnt) cnt.textContent = `${state.logs.length}건`;
}

// ─── 항목설정 탭 ────────────────────────────────────────────
function renderFieldSettings() {
  const el = document.getElementById('fieldList');
  if (!el) return;
  const fields = getFields();
  el.innerHTML = fields.map(f => {
    const typeLabel = f.freeText ? '자유문장' : f.type === 'integer' ? '정수' : f.type === 'float' ? '소수' : '문자열';
    const allowedStr = f.allowed ? `허용: ${f.allowed.join(', ')}` : f.range ? `범위: ${f.range[0]}~${f.range[1]}` : '';
    return `<div class="field-item" id="fi_${f.id}">
      <div class="field-item-header">
        <span class="field-item-name">${f.name}</span>
        <span class="field-item-type">${typeLabel}${f.unit ? ' / ' + f.unit : ''}</span>
      </div>
      <div class="field-item-aliases">alias: ${f.aliases.join(', ')}</div>
      ${allowedStr ? `<div class="field-item-aliases">${allowedStr}</div>` : ''}
      <div class="field-item-actions">
        <button class="btn btn-secondary btn-sm" onclick="editField('${f.id}')">수정</button>
        <button class="btn btn-danger btn-sm" onclick="deleteFieldUI('${f.id}','${f.name}')">삭제</button>
      </div>
    </div>`;
  }).join('');
}

window.editField = function(id) {
  const field = getFields().find(f => f.id === id);
  if (!field) return;
  openFieldModal(field);
};

window.deleteFieldUI = function(id, name) {
  if (!confirm(`"${name}" 항목을 삭제할까요?`)) return;
  removeField(id);
  renderFieldSettings();
  renderFields();
  showToast(`"${name}" 삭제됨`);
};

// ─── 항목 편집 모달 ──────────────────────────────────────────
let _editingFieldId = null;

function openFieldModal(field) {
  _editingFieldId = field ? field.id : null;
  const modal = document.getElementById('fieldModal');
  const title = document.getElementById('modalTitle');
  if (!modal) return;

  title.textContent = field ? '항목 수정' : '새 항목 추가';

  document.getElementById('fmName').value    = field?.name || '';
  document.getElementById('fmAliases').value = field?.aliases.join(', ') || '';
  document.getElementById('fmType').value    = field?.type || 'integer';
  document.getElementById('fmUnit').value    = field?.unit || '';
  document.getElementById('fmAllowed').value = field?.allowed ? field.allowed.join(',') : '';
  document.getElementById('fmRangeMin').value = field?.range ? field.range[0] : '';
  document.getElementById('fmRangeMax').value = field?.range ? field.range[1] : '';
  document.getElementById('fmFreeText').checked = field?.freeText || false;
  document.getElementById('fmDesc').value   = field?.description || '';

  modal.style.display = 'flex';
}

function closeFieldModal() {
  const modal = document.getElementById('fieldModal');
  if (modal) modal.style.display = 'none';
  _editingFieldId = null;
}

function saveFieldModal() {
  const name     = document.getElementById('fmName').value.trim();
  const aliasStr = document.getElementById('fmAliases').value.trim();
  const type     = document.getElementById('fmType').value;
  const unit     = document.getElementById('fmUnit').value.trim();
  const allowedStr = document.getElementById('fmAllowed').value.trim();
  const rMin     = document.getElementById('fmRangeMin').value.trim();
  const rMax     = document.getElementById('fmRangeMax').value.trim();
  const freeText = document.getElementById('fmFreeText').checked;
  const desc     = document.getElementById('fmDesc').value.trim();

  if (!name) { showToast('항목명을 입력해주세요'); return; }

  const aliases = aliasStr ? aliasStr.split(',').map(a => a.trim()).filter(a => a) : [name];
  const allowed = allowedStr ? allowedStr.split(',').map(v => { const n = parseFloat(v.trim()); return isNaN(n) ? null : (type === 'integer' ? Math.round(n) : n); }).filter(v => v !== null) : null;
  const range = rMin !== '' && rMax !== '' ? [parseFloat(rMin), parseFloat(rMax)] : null;

  const data = { name, aliases, type, unit, allowed, range, freeText, description: desc };

  if (_editingFieldId) {
    updateField(_editingFieldId, data);
    showToast(`"${name}" 수정됨`);
  } else {
    addField(data);
    showToast(`"${name}" 추가됨`);
  }

  closeFieldModal();
  renderFieldSettings();
  renderFields();
}

// ─── 모델 탭 ─────────────────────────────────────────────────
function renderModelTab() {
  updateLLMStatusUI();
}

function updateLLMStatusUI() {
  const dot  = document.getElementById('llmDot');
  const text = document.getElementById('llmText');
  if (!dot || !text) return;

  dot.className = 'llm-dot';
  switch (state.llmStatus) {
    case 'ready':       dot.classList.add('ready');   text.textContent = '준비 완료'; break;
    case 'loading':     dot.classList.add('loading'); text.textContent = '준비 중...'; break;
    case 'failed':      dot.classList.add('failed');  text.textContent = '준비 실패'; break;
    default:            text.textContent = '사용 불가'; break;
  }

  const strip = document.getElementById('llmStrip');
  if (strip) {
    const sdot = strip.querySelector('.llm-dot');
    const stxt = strip.querySelector('#llmStripText');
    if (sdot) { sdot.className = 'llm-dot'; if (state.llmStatus === 'ready') sdot.classList.add('ready'); }
    if (stxt) stxt.textContent = state.llmStatus === 'ready' ? 'LLM 준비완료' : 'LLM 없음(규칙 기반)';
  }
}

// ─── 테스트 실행 ──────────────────────────────────────────────
function runParserTests() {
  const fields = getFields();
  const results = runTests(fields);
  const pass = results.filter(r => r.pass).length;
  const el = document.getElementById('testResults');
  if (!el) return;
  el.innerHTML = `<div style="font-size:12px;margin-bottom:6px;color:var(--text2)">통과 ${pass}/${results.length}</div>` +
    results.map(r => `<div style="font-size:11px;padding:3px 0;border-bottom:1px solid var(--border);">
      <span style="color:${r.pass ? 'var(--success)' : 'var(--error)'}">${r.pass ? '✓' : '✗'}</span>
      <span style="color:var(--text)">&nbsp;${r.input}</span>
      <span style="color:var(--text2)">&nbsp;→ ${r.actual}</span>
    </div>`).join('');
  showToast(`테스트 ${pass}/${results.length} 통과`);
}

// ─── VAD 모드 ────────────────────────────────────────────────
function setVadMode(mode) {
  state.vadMode = mode;
  document.querySelectorAll('.vad-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.vad === mode);
  });
  localStorage.setItem('citrusVadMode', mode);
}

// ─── TTS 속도 ────────────────────────────────────────────────
function setTtsRate(rate) {
  state.ttsRate = parseFloat(rate);
  localStorage.setItem('citrusTtsRate', rate);
}

// ─── 온라인 상태 ─────────────────────────────────────────────
function updateOnlineStatus() {
  const badge = document.getElementById('statusBadge');
  if (!badge) return;
  badge.textContent = navigator.onLine ? '온라인' : '오프라인';
  badge.className = 'status-badge ' + (navigator.onLine ? 'online' : 'offline');
}

// ─── 탭 전환 ────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
  if (name === 'log') { renderLogTable(); }
  if (name === 'fields') { renderFieldSettings(); }
  if (name === 'model') { renderModelTab(); }
}

// ─── 로그 내보내기 ───────────────────────────────────────────
function exportLogs() {
  const data = JSON.stringify({ fields: getFields(), logs: state.logs, data: state.currentData }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `citrus_survey_${new Date().toISOString().substring(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  addLog({ event: 'export' });
}

// ─── 현재 데이터 초기화 ─────────────────────────────────────
function clearCurrentData() {
  if (!confirm('현재 입력값을 모두 초기화할까요?')) return;
  state.currentData = {};
  state.lastSaved = null;
  state.pendingField = null;
  state.memoMode = false;
  setPendingBar(null);
  renderAll();
  showToast('입력값 초기화됨');
}

// ─── 수동 테스트 입력 ────────────────────────────────────────
function manualTest() {
  const txt = (document.getElementById('testInput')?.value || '').trim();
  if (!txt) return;
  processFinalText(txt, 1.0);
  addLog({ event: 'manual_test', text: txt });
}

// ─── 초기화 ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Service Worker 등록
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }

  // 온라인/오프라인
  window.addEventListener('online',  () => { updateOnlineStatus(); showToast('온라인 연결됨'); });
  window.addEventListener('offline', () => { updateOnlineStatus(); showToast('오프라인 모드', 3000); });
  updateOnlineStatus();

  // 로그 로드
  loadLogs();

  // 설정 로드
  state.vadMode  = localStorage.getItem('citrusVadMode')  || 'balanced';
  state.ttsRate  = parseFloat(localStorage.getItem('citrusTtsRate') || '0.92');

  // 탭
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => switchTab(t.dataset.tab))
  );

  // Mic
  document.getElementById('micBtn')?.addEventListener('click', toggleRecording);

  // VAD 버튼
  document.querySelectorAll('.vad-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.vad === state.vadMode);
    b.addEventListener('click', () => setVadMode(b.dataset.vad));
  });

  // TTS 속도
  const ttsSelect = document.getElementById('ttsRate');
  if (ttsSelect) {
    ttsSelect.value = String(state.ttsRate);
    ttsSelect.addEventListener('change', () => setTtsRate(ttsSelect.value));
  }

  // 수동 테스트
  document.getElementById('btnManualTest')?.addEventListener('click', manualTest);
  document.getElementById('testInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') manualTest();
  });

  // 로그 동작
  document.getElementById('btnExportLog')?.addEventListener('click', exportLogs);
  document.getElementById('btnClearLog')?.addEventListener('click', () => {
    if (!confirm('모든 로그를 삭제할까요?')) return;
    state.logs = [];
    try { localStorage.removeItem('citrusLogs_v3'); } catch {}
    renderLogTable();
    showToast('로그 삭제됨');
  });

  // 현재 데이터 초기화
  document.getElementById('btnClearData')?.addEventListener('click', clearCurrentData);

  // 항목설정 탭
  document.getElementById('btnAddField')?.addEventListener('click', () => openFieldModal(null));
  document.getElementById('btnResetFields')?.addEventListener('click', () => {
    if (!confirm('항목을 기본값으로 초기화할까요?')) return;
    resetFields();
    renderFieldSettings();
    renderFields();
    showToast('항목 기본값으로 초기화됨');
  });

  // 모달
  document.getElementById('btnModalSave')?.addEventListener('click', saveFieldModal);
  document.getElementById('btnModalCancel')?.addEventListener('click', closeFieldModal);
  document.getElementById('fieldModal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('fieldModal')) closeFieldModal();
  });

  // 파서 테스트
  document.getElementById('btnRunTests')?.addEventListener('click', runParserTests);

  // 기기 정보
  const setDev = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  setDev('devUA',       navigator.userAgent.substring(0, 70));
  setDev('devPlatform', navigator.platform);
  setDev('devLang',     navigator.language);
  setDev('devSTT',      SR ? '지원' : '미지원');
  setDev('devTTS',      window.speechSynthesis ? '지원' : '미지원');
  setDev('devTouch',    navigator.maxTouchPoints + '포인트');

  // 초기 렌더링
  renderFields();
  renderLogTable();
  updateLLMStatusUI();

  addLog({ event: 'app_init', ua: navigator.userAgent });
});
