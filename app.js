'use strict';

/* ─────────────────────────────────────────────
   1. CONSTANTS & DICTIONARIES
───────────────────────────────────────────── */

// 측정 항목 → 단위
const MEASURE_FIELDS = {
  횡경: 'mm', 종경: 'mm',
  엽장: 'mm', 엽폭: 'mm',
  과중: 'g', 과피중: 'g',
  과피두께: 'mm', 과피두께x4: 'mm',
  당도: 'Brix', 비파괴: 'Brix',
  적정: '', 산함량: '%', 당산도: '',
  착색: '%'
};

// 컨텍스트 명령
const CTX_FIELDS = ['나무', '과실', '농가', '라벨', '처리'];

// 특수 명령
const CMDS = ['수정', '정정', '취소', '비고'];

// 별칭 사전 (95개+)
const ALIASES = {
  횡경: ['회경','횡겨','횡견','형경','형견','행경','황경','홍경','항경','혜경','헹경'],
  종경: ['종겨','종견','정경','중경','층경','충경'],
  엽장: ['엽짱','엽자','입장','열장','엽쟁'],
  엽폭: ['엽포','입폭','열폭','엽복','엽폭'],
  과중: ['과주','과쥬','과충','가중','과증'],
  당도: ['당독','당두','단도','댕도'],
  착색: ['착새','착섹','착색','착색도'],
  비파괴: ['비파','비파괴','비파퀴'],
  산함량: ['산함','산함양','산양'],
  당산도: ['당산','당산비'],
  적정: ['적점','적정산'],
  과피중: ['과피주','과피무게'],
  과피두께: ['과피두끼','과피두께','과피'],
  나무: ['나무','나무번호','tree'],
  과실: ['과실','과실번호','과','fruit'],
  농가: ['농가','농가명','farm'],
  라벨: ['라벨','레벨','label'],
  처리: ['처리','처리구','treatment'],
  수정: ['수정','정정','修正'],
  취소: ['취소','Cancel','캔슬']
};

// 한글 숫자 → 아라비아
const KOREAN_NUM = {
  '영':0,'일':1,'이':2,'삼':3,'사':4,'오':5,
  '육':6,'칠':7,'팔':8,'구':9,'십':10,
  '십일':11,'십이':12,'십삼':13,'십사':14,'십오':15,
  '십육':16,'십칠':17,'십팔':18,'십구':19,'이십':20,
  '삼십':30,'사십':40,'오십':50,'육십':60,'칠십':70,'팔십':80,'구십':90
};

// 범위
const RANGES = {
  횡경: [10, 100], 종경: [10, 100],
  과중: [5, 300], 당도: [3, 25],
  적정: [0.1, 10], 산함량: [0.1, 10],
  착색: [0, 100], 비파괴: [3, 25],
  과피중: [5, 200], 과피두께: [0.5, 20]
};

/* ─────────────────────────────────────────────
   2. STATE
───────────────────────────────────────────── */
const state = {
  // session context
  ctx: {
    farmName: '',
    label: '',
    treatment: '',
    treeNo: 1,
    fruitNo: 1,
    surveyType: '비대조사',
    observer: ''
  },
  // current fruit data
  currentData: {},
  // undo stack
  undoStack: [],
  // recognition
  isRecording: false,
  recognition: null,
  // logs (saved to localStorage)
  logs: JSON.parse(localStorage.getItem('voiceLogs') || '[]'),
  // settings
  settings: JSON.parse(localStorage.getItem('appSettings') || '{}')
};

/* ─────────────────────────────────────────────
   3. SPEECH RECOGNITION
───────────────────────────────────────────── */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

function initRecognition() {
  if (!SpeechRecognition) return null;
  const r = new SpeechRecognition();
  r.lang = 'ko-KR';
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 5;
  return r;
}

/* ─────────────────────────────────────────────
   4. FUZZY MATCHING
───────────────────────────────────────────── */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) => Array.from({length: n+1}, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function matchField(token) {
  const t = token.trim().toLowerCase();
  // exact match
  for (const field of [...Object.keys(MEASURE_FIELDS), ...CTX_FIELDS, ...CMDS]) {
    if (field === t) return { field, score: 1.0, method: 'exact' };
  }
  // alias match
  for (const [field, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      if (alias === t) return { field, score: 0.95, method: 'alias' };
    }
  }
  // edit distance
  let best = null, bestDist = 99;
  const allFields = [...Object.keys(MEASURE_FIELDS), ...CTX_FIELDS, ...CMDS];
  for (const field of allFields) {
    const d = editDistance(t, field);
    if (d < bestDist && d <= 2) { bestDist = d; best = field; }
  }
  if (best) return { field: best, score: Math.max(0.5, 1 - bestDist * 0.2), method: 'fuzzy' };
  return null;
}

/* ─────────────────────────────────────────────
   5. NUMBER PARSING
───────────────────────────────────────────── */
function parseNumber(str) {
  if (!str) return null;
  // 아라비아
  const n = parseFloat(str.replace(/[^\d.]/g, ''));
  if (!isNaN(n)) return n;
  // 한글 숫자
  const lower = str.toLowerCase();
  if (KOREAN_NUM[lower] !== undefined) return KOREAN_NUM[lower];
  // 복합 (이십이점오 → 22.5)
  const m = str.match(/^([가-힣]+)점([가-힣]+)$/);
  if (m) {
    const intPart = KOREAN_NUM[m[1]];
    const decPart = KOREAN_NUM[m[2]];
    if (intPart !== undefined && decPart !== undefined)
      return parseFloat(`${intPart}.${decPart}`);
  }
  return null;
}

/* ─────────────────────────────────────────────
   6. STREAM PARSER (연속 발화)
───────────────────────────────────────────── */
function parseStream(text) {
  // 붙여쓴 경우 분리: "횡경22.5" → "횡경 22.5"
  const normalized = text
    .replace(/([가-힣])(\d)/g, '$1 $2')
    .replace(/(\d)([가-힣])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = normalized.split(' ');
  const parsed = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];
    const match = matchField(tok);

    if (!match) {
      // 숫자만 나온 경우 이전 필드에 붙이기
      const num = parseNumber(tok);
      if (num !== null && parsed.length > 0 && parsed[parsed.length-1].value === null) {
        parsed[parsed.length-1].value = num;
        parsed[parsed.length-1].rawValue = tok;
      } else {
        parsed.push({ type: 'unknown', raw: tok, field: null, value: null });
      }
      i++;
      continue;
    }

    const field = match.field;
    let value = null;
    let rawValue = '';

    // 다음 토큰이 숫자면 값으로
    if (i + 1 < tokens.length) {
      const nextNum = parseNumber(tokens[i+1]);
      if (nextNum !== null) {
        value = nextNum;
        rawValue = tokens[i+1];
        i += 2;
      } else {
        // 비고 같은 경우 텍스트 값
        if (field === '비고') {
          value = tokens.slice(i+1, i+4).join(' ');
          rawValue = value;
          i = Math.min(i+4, tokens.length);
        } else {
          i++;
        }
      }
    } else {
      i++;
    }

    // 타입 결정
    let type = 'unknown';
    if (MEASURE_FIELDS[field]) type = 'measure';
    else if (CTX_FIELDS.includes(field)) type = 'ctx';
    else if (CMDS.includes(field)) type = 'cmd';

    parsed.push({
      type,
      field,
      value,
      rawValue,
      raw: tok,
      matchScore: match.score,
      matchMethod: match.method
    });
  }

  return { normalized, tokens: parsed };
}

/* ─────────────────────────────────────────────
   7. APPLY PARSED TOKENS
───────────────────────────────────────────── */
function applyTokens(tokens) {
  const actions = [];
  let modifyMode = false;

  for (const tok of tokens) {
    if (tok.type === 'unknown') continue;

    if (tok.field === '취소') {
      if (state.undoStack.length > 0) {
        const prev = state.undoStack.pop();
        state.currentData[prev.field] = prev.value;
        actions.push({ action: 'undo', field: prev.field, value: prev.value });
        speak('취소');
      }
      continue;
    }

    if (tok.field === '수정' || tok.field === '정정') {
      modifyMode = true;
      actions.push({ action: 'modify_mode' });
      speak('수정');
      continue;
    }

    if (tok.type === 'ctx' && tok.value !== null) {
      const map = { 나무: 'treeNo', 과실: 'fruitNo', 농가: 'farmName', 라벨: 'label', 처리: 'treatment' };
      const key = map[tok.field];
      if (key) {
        state.ctx[key] = tok.value;
        actions.push({ action: 'ctx_change', field: tok.field, value: tok.value });
        speak(`${tok.field} ${tok.value}`);
      }
      continue;
    }

    if (tok.type === 'measure' && tok.value !== null) {
      // range check
      const range = RANGES[tok.field];
      const outOfRange = range && (tok.value < range[0] || tok.value > range[1]);

      // undo stack
      state.undoStack.push({ field: tok.field, value: state.currentData[tok.field] ?? null });
      if (state.undoStack.length > 20) state.undoStack.shift();

      state.currentData[tok.field] = tok.value;
      actions.push({ action: 'measure', field: tok.field, value: tok.value, outOfRange });

      speak(outOfRange ? `${tok.field} ${tok.value} 확인` : `${tok.field} ${tok.value}`);
    }
  }

  return actions;
}

/* ─────────────────────────────────────────────
   8. TTS
───────────────────────────────────────────── */
function speak(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  u.rate = 1.1;
  u.pitch = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

/* ─────────────────────────────────────────────
   9. LOGGING
───────────────────────────────────────────── */
function addLog(entry) {
  const log = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    deviceInfo: {
      ua: navigator.userAgent,
      platform: navigator.platform,
      online: navigator.onLine,
      lang: navigator.language
    },
    ...entry
  };
  state.logs.unshift(log);
  if (state.logs.length > 500) state.logs.pop();
  localStorage.setItem('voiceLogs', JSON.stringify(state.logs));
  renderLogs();
  return log;
}

/* ─────────────────────────────────────────────
   10. UI RENDERING
───────────────────────────────────────────── */
function renderContext() {
  const el = document.getElementById('contextBar');
  if (!el) return;
  const c = state.ctx;
  el.innerHTML = `
    <div class="ctx-item"><span>조사유형</span> <strong>${c.surveyType}</strong></div>
    <div class="ctx-item"><span>농가</span> <strong>${c.farmName || '-'}</strong></div>
    <div class="ctx-item"><span>라벨</span> <strong>${c.label || '-'}</strong></div>
    <div class="ctx-item"><span>처리</span> <strong>${c.treatment || '-'}</strong></div>
    <div class="ctx-item"><span>나무</span> <strong>${c.treeNo}</strong></div>
    <div class="ctx-item"><span>과실</span> <strong>${c.fruitNo}</strong></div>
  `;
}

function renderFields() {
  const el = document.getElementById('fieldsGrid');
  if (!el) return;
  const fields = state.ctx.surveyType === '비대조사'
    ? ['횡경', '종경']
    : ['횡경', '종경', '과중', '과피중', '과피두께', '당도', '적정', '산함량', '착색', '비파괴'];

  el.innerHTML = fields.map(f => {
    const val = state.currentData[f];
    const range = RANGES[f];
    let cls = '';
    if (val !== undefined && range) {
      if (val < range[0] || val > range[1]) cls = 'field-error';
    }
    return `<div class="field-card ${cls}">
      <div class="field-name">${f}</div>
      <div class="field-val">${val !== undefined ? val : '--'}</div>
      <div class="field-unit">${MEASURE_FIELDS[f] || ''}</div>
    </div>`;
  }).join('');
}

function renderParseResult(parsed) {
  const el = document.getElementById('parseResult');
  if (!el || !parsed) return;
  el.innerHTML = `<h3>파싱 결과</h3><div class="token-list">${
    parsed.tokens.map(t => {
      const label = t.value !== null
        ? `${t.field || t.raw} ${t.value}`
        : (t.field || t.raw);
      return `<span class="token ${t.type}" title="신뢰도: ${((t.matchScore||0)*100).toFixed(0)}% | ${t.matchMethod||'?'}">${label}</span>`;
    }).join('')
  }</div>`;
}

function renderLogs() {
  const el = document.getElementById('logEntries');
  if (!el) return;
  el.textContent = state.logs.slice(0, 50).map(l =>
    `[${l.timestamp.substring(11,19)}] ${l.event}\n${JSON.stringify(l, null, 2)}\n`
  ).join('\n────────────────\n');

  const cnt = document.getElementById('logCount');
  if (cnt) cnt.textContent = `총 ${state.logs.length}건`;
}

function renderLogTable() {
  const el = document.getElementById('logTable');
  if (!el) return;
  const recent = state.logs.filter(l => l.event === 'voice_result').slice(0, 30);
  if (recent.length === 0) {
    el.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:20px">아직 음성 로그 없음</td></tr>';
    return;
  }
  el.innerHTML = recent.map(l => {
    const conf = Math.round((l.confidence || 0) * 100);
    const confColor = conf > 80 ? 'var(--success)' : conf > 50 ? 'var(--warn)' : 'var(--error)';
    return `<tr>
      <td>${l.timestamp.substring(11,19)}</td>
      <td style="max-width:180px;word-break:break-all">${l.rawText || ''}</td>
      <td>${conf}%<div class="conf-bar"><div class="conf-fill" style="width:${conf}%;background:${confColor}"></div></div></td>
      <td>${l.tokenCount || 0}</td>
      <td>${l.actions?.map(a => a.action).join(', ') || '-'}</td>
    </tr>`;
  }).join('');
}

function updateOnlineStatus() {
  const badge = document.getElementById('statusBadge');
  if (!badge) return;
  if (navigator.onLine) {
    badge.textContent = '온라인';
    badge.className = 'status-badge online';
  } else {
    badge.textContent = '오프라인';
    badge.className = 'status-badge offline';
  }
}

function showToast(msg, dur = 2000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.add('hidden'), dur);
}

/* ─────────────────────────────────────────────
   11. RECOGNITION CONTROL
───────────────────────────────────────────── */
function startRecording() {
  if (!SpeechRecognition) {
    showToast('이 브라우저는 음성인식을 지원하지 않습니다');
    addLog({ event: 'error', error: 'SpeechRecognition not supported', ua: navigator.userAgent });
    return;
  }

  recognition = initRecognition();
  const startTime = Date.now();

  addLog({
    event: 'recording_start',
    ctx: { ...state.ctx },
    browserSupport: {
      speechRecognition: !!SpeechRecognition,
      speechSynthesis: !!window.speechSynthesis,
      serviceWorker: 'serviceWorker' in navigator,
      online: navigator.onLine
    }
  });

  recognition.onstart = () => {
    state.isRecording = true;
    updateMicBtn();
    addLog({ event: 'recognition_started', elapsedMs: Date.now() - startTime });
  };

  recognition.onaudiostart = () => {
    addLog({ event: 'audio_started' });
  };

  recognition.onspeechstart = () => {
    addLog({ event: 'speech_started' });
  };

  recognition.onspeechend = () => {
    addLog({ event: 'speech_ended' });
  };

  let interimBuffer = '';
  recognition.onresult = (e) => {
    const resultStart = Date.now();
    let interim = '';
    let final = '';

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const transcript = res[0].transcript;
      const confidence = res[0].confidence;

      if (res.isFinal) {
        final += transcript;

        // 모든 대안 기록
        const alternatives = [];
        for (let j = 0; j < res.length; j++) {
          alternatives.push({
            transcript: res[j].transcript,
            confidence: res[j].confidence
          });
        }

        // parse
        const parsed = parseStream(transcript);
        const actions = applyTokens(parsed.tokens);

        // log
        addLog({
          event: 'voice_result',
          rawText: transcript,
          confidence,
          alternatives,
          normalized: parsed.normalized,
          tokenCount: parsed.tokens.length,
          tokens: parsed.tokens,
          actions,
          processingMs: Date.now() - resultStart,
          ctx: { ...state.ctx },
          isOnline: navigator.onLine
        });

        // update UI
        renderParseResult(parsed);
        renderContext();
        renderFields();
        renderLogTable();

        document.getElementById('transcriptFinal').textContent = transcript;
        document.getElementById('transcriptInterim').textContent = '';
      } else {
        interim += transcript;
      }
    }

    if (interim) {
      document.getElementById('transcriptInterim').textContent = interim;
    }
  };

  recognition.onerror = (e) => {
    addLog({
      event: 'recognition_error',
      error: e.error,
      message: e.message,
      isOnline: navigator.onLine
    });

    const errorMap = {
      'not-allowed': '마이크 권한이 거부되었습니다',
      'no-speech': '음성이 감지되지 않았습니다',
      'network': '네트워크 오류 (오프라인에서는 음성인식이 제한될 수 있음)',
      'service-not-allowed': '음성인식 서비스가 허용되지 않음',
      'aborted': '인식이 중단되었습니다'
    };

    showToast(errorMap[e.error] || `오류: ${e.error}`, 3000);

    if (e.error === 'network' || e.error === 'no-speech') {
      // 네트워크 오류면 자동 재시작 시도
      setTimeout(() => {
        if (state.isRecording) {
          try { recognition.start(); } catch(err) {}
        }
      }, 1000);
    } else if (e.error !== 'aborted') {
      stopRecording();
    }
  };

  recognition.onend = () => {
    addLog({ event: 'recognition_ended', isRecording: state.isRecording });
    if (state.isRecording) {
      // 연속 인식 유지
      setTimeout(() => {
        try { recognition.start(); } catch(err) {}
      }, 300);
    }
  };

  try {
    recognition.start();
  } catch(e) {
    addLog({ event: 'start_error', error: e.message });
    showToast(`시작 실패: ${e.message}`);
  }
}

function stopRecording() {
  state.isRecording = false;
  updateMicBtn();
  if (recognition) {
    try { recognition.stop(); } catch(e) {}
    recognition = null;
  }
  addLog({ event: 'recording_stop', ctx: { ...state.ctx } });
  speak('음성입력 종료');
}

function toggleRecording() {
  if (state.isRecording) {
    stopRecording();
  } else {
    startRecording();
    speak('음성입력 시작');
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

/* ─────────────────────────────────────────────
   12. SETTINGS
───────────────────────────────────────────── */
function loadSettings() {
  const s = state.settings;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
  setVal('settingObserver', s.observer || '');
  setVal('settingFarm', s.farmName || '');
  setVal('settingLabel', s.label || '');
  setVal('settingTreatment', s.treatment || '');
  setVal('settingType', s.surveyType || '비대조사');

  // apply to ctx
  if (s.observer) state.ctx.observer = s.observer;
  if (s.farmName) state.ctx.farmName = s.farmName;
  if (s.label) state.ctx.label = s.label;
  if (s.treatment) state.ctx.treatment = s.treatment;
  if (s.surveyType) state.ctx.surveyType = s.surveyType;
}

function saveSettings() {
  state.settings = {
    observer: document.getElementById('settingObserver')?.value || '',
    farmName: document.getElementById('settingFarm')?.value || '',
    label: document.getElementById('settingLabel')?.value || '',
    treatment: document.getElementById('settingTreatment')?.value || '',
    surveyType: document.getElementById('settingType')?.value || '비대조사'
  };
  Object.assign(state.ctx, {
    observer: state.settings.observer,
    farmName: state.settings.farmName,
    label: state.settings.label,
    treatment: state.settings.treatment,
    surveyType: state.settings.surveyType
  });
  localStorage.setItem('appSettings', JSON.stringify(state.settings));
  renderContext();
  renderFields();
  showToast('설정 저장됨');
}

/* ─────────────────────────────────────────────
   13. TABS
───────────────────────────────────────────── */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
  if (name === 'log') { renderLogs(); renderLogTable(); }
}

/* ─────────────────────────────────────────────
   14. LOG EXPORT
───────────────────────────────────────────── */
function exportLogs() {
  const data = JSON.stringify(state.logs, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `citrus_voice_log_${new Date().toISOString().substring(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  addLog({ event: 'log_exported', count: state.logs.length });
}

function clearLogs() {
  if (!confirm('모든 로그를 삭제할까요?')) return;
  state.logs = [];
  localStorage.removeItem('voiceLogs');
  renderLogs();
  renderLogTable();
  showToast('로그 삭제됨');
}

/* ─────────────────────────────────────────────
   15. INIT
───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => addLog({ event: 'sw_registered', scope: reg.scope }))
      .catch(err => addLog({ event: 'sw_error', error: err.message }));
  }

  // Online/offline
  window.addEventListener('online', () => {
    updateOnlineStatus();
    addLog({ event: 'network_online' });
    showToast('온라인 연결됨');
  });
  window.addEventListener('offline', () => {
    updateOnlineStatus();
    addLog({ event: 'network_offline' });
    showToast('오프라인 모드', 3000);
  });
  updateOnlineStatus();

  // Load settings
  loadSettings();
  renderContext();
  renderFields();
  renderLogTable();

  // Mic button
  document.getElementById('micBtn')?.addEventListener('click', toggleRecording);

  // Tabs
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => switchTab(t.dataset.tab))
  );

  // Settings
  document.getElementById('btnSaveSettings')?.addEventListener('click', saveSettings);

  // Log actions
  document.getElementById('btnExportLog')?.addEventListener('click', exportLogs);
  document.getElementById('btnClearLog')?.addEventListener('click', clearLogs);

  // Manual test input
  document.getElementById('btnTestInput')?.addEventListener('click', () => {
    const txt = document.getElementById('testInput')?.value || '';
    if (!txt.trim()) return;
    const parsed = parseStream(txt);
    const actions = applyTokens(parsed.tokens);
    addLog({
      event: 'voice_result',
      rawText: txt,
      confidence: 1.0,
      alternatives: [{ transcript: txt, confidence: 1.0 }],
      normalized: parsed.normalized,
      tokenCount: parsed.tokens.length,
      tokens: parsed.tokens,
      actions,
      processingMs: 0,
      ctx: { ...state.ctx },
      isOnline: navigator.onLine,
      inputMethod: 'manual_test'
    });
    renderParseResult(parsed);
    renderContext();
    renderFields();
    renderLogTable();
    document.getElementById('transcriptFinal').textContent = txt;
  });

  // device info log
  addLog({
    event: 'app_init',
    browserInfo: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      onLine: navigator.onLine,
      cookieEnabled: navigator.cookieEnabled,
      maxTouchPoints: navigator.maxTouchPoints,
      speechRecognitionSupported: !!SpeechRecognition,
      speechSynthesisSupported: !!window.speechSynthesis,
      serviceWorkerSupported: 'serviceWorker' in navigator
    }
  });

  // reset for new session
  state.currentData = {};
  document.getElementById('transcriptFinal').textContent = '';
  document.getElementById('transcriptInterim').textContent = '';
});
