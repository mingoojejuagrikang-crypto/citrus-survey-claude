'use strict';
// parser.js – 스키마 기반 규칙 파서 (소음 내성, 붙여말하기 지원)

// ─── 한글 숫자 사전 ───────────────────────────────────────────
const KR_DIGIT = {
  '영': 0, '일': 1, '이': 2, '삼': 3, '사': 4,
  '오': 5, '육': 6, '칠': 7, '팔': 8, '구': 9
};

// STT 오인식 교정 (정수 필드 전용)
const INT_MISREAD = {
  '위': 2,   // "이" 오인식
  '로': 5,   // "오" 오인식
  '호': 5,   // "오" 오인식
  '에': 1,   // "일" 오인식
};

// ─── 한글 숫자 → 정수 파싱 ───────────────────────────────────
function parseKoreanInt(str) {
  if (!str || str.length === 0) return null;
  if (KR_DIGIT[str] !== undefined) return KR_DIGIT[str];

  let val = 0;
  let s = str;

  // 천 (천, 이천, ...)
  const cheonIdx = s.indexOf('천');
  if (cheonIdx >= 0) {
    const hStr = s.substring(0, cheonIdx);
    const h = hStr === '' ? 1 : KR_DIGIT[hStr];
    if (h === undefined) return null;
    val += h * 1000;
    s = s.substring(cheonIdx + 1);
  }

  // 백 (백, 이백, ...)
  const baekIdx = s.indexOf('백');
  if (baekIdx >= 0) {
    const hStr = s.substring(0, baekIdx);
    const h = hStr === '' ? 1 : KR_DIGIT[hStr];
    if (h === undefined) return null;
    val += h * 100;
    s = s.substring(baekIdx + 1);
  }

  // 십 (십, 이십, ...)
  const sipIdx = s.indexOf('십');
  if (sipIdx >= 0) {
    const tStr = s.substring(0, sipIdx);
    const t = tStr === '' ? 1 : KR_DIGIT[tStr];
    if (t === undefined) return null;
    val += t * 10;
    s = s.substring(sipIdx + 1);
  }

  // 남은 단일 글자
  if (s.length > 0) {
    if (KR_DIGIT[s] !== undefined) {
      val += KR_DIGIT[s];
    } else {
      return null;
    }
  }

  return val;
}

// ─── 한글 소수 파싱 ──────────────────────────────────────────
function parseKoreanFloat(str) {
  if (!str) return null;
  const dotIdx = str.indexOf('점');
  if (dotIdx >= 0) {
    const intStr = str.substring(0, dotIdx);
    const decStr = str.substring(dotIdx + 1);
    if (decStr.length === 0) return null; // 소수점 이후 미완
    const intPart = dotIdx === 0 ? 0 : parseKoreanInt(intStr);
    const decDigit = KR_DIGIT[decStr];
    if (intPart === null || decDigit === undefined) return null;
    return parseFloat(`${intPart}.${decDigit}`);
  }
  return parseKoreanInt(str); // 소수점 없으면 정수 float
}

// ─── 숫자처럼 보이는지 판별 ──────────────────────────────────
function looksLikeNumber(str) {
  if (!str || str.length === 0) return false;
  if (/^\d/.test(str)) return true;                       // 아라비아 숫자 시작
  if (KR_DIGIT[str] !== undefined) return true;           // 단독 한글 숫자
  if (INT_MISREAD[str] !== undefined) return true;        // 오인식 교정 대상
  if (str.includes('점')) return parseKoreanFloat(str) !== null; // 소수점 포함
  return parseKoreanInt(str) !== null;                    // 한글 정수
}

// ─── 임의 수 파싱 시도 ───────────────────────────────────────
function tryParseNumber(str) {
  if (!str) return null;
  const s = str.trim();
  const arabic = parseFloat(s.replace(/,/g, ''));
  if (!isNaN(arabic)) return arabic;
  if (s.includes('점')) return parseKoreanFloat(s);
  const kr = parseKoreanInt(s);
  return kr;
}

// ─── 스키마 기반 값 파싱 ─────────────────────────────────────
function validateNum(num, schema) {
  // 노이즈 숫자 거부
  const absMax = schema.range
    ? schema.range[1]
    : schema.allowed ? Math.max(...schema.allowed) : 10000;
  if (num > absMax * 10 || num > 1e8) {
    return { value: null, status: 'noise', raw: num };
  }

  // 정수형: 소수점 버림
  if (schema.type === 'integer') {
    if (!Number.isInteger(num)) num = Math.round(num);
  }

  // 허용값 체크
  if (schema.allowed && schema.allowed.length > 0) {
    if (!schema.allowed.includes(num)) {
      return { value: null, status: 'invalid', raw: num };
    }
  }

  // 범위 체크
  if (schema.range) {
    const [min, max] = schema.range;
    if (num < min || num > max) {
      return { value: null, status: 'invalid', raw: num };
    }
  }

  // 경고 범위
  let warn = false;
  if (schema.warningRange) {
    const [wMin, wMax] = schema.warningRange;
    warn = (num >= wMin && num <= wMax);
  }

  return { value: num, status: 'ok', warn };
}

export function parseValueForField(valueStr, schema) {
  if (!valueStr || valueStr.trim() === '') return { value: null, status: 'pending' };
  const s = valueStr.trim();

  if (schema.freeText || schema.type === 'string') {
    return { value: s, status: 'ok', warn: false };
  }

  // 아라비아 숫자
  const arabic = parseFloat(s.replace(/,/g, ''));
  if (!isNaN(arabic)) return validateNum(arabic, schema);

  // 한글 소수점
  if (s.includes('점')) {
    const v = parseKoreanFloat(s);
    if (v !== null) return validateNum(v, schema);
    if (s.endsWith('점')) return { value: null, status: 'pending', hint: 'decimal_incomplete' };
    return { value: null, status: 'invalid' };
  }

  // 한글 정수
  const krInt = parseKoreanInt(s);
  if (krInt !== null) {
    return validateNum(schema.type === 'float' ? krInt : Math.round(krInt), schema);
  }

  // 오인식 교정 (정수 필드 한정)
  if (schema.type === 'integer' && INT_MISREAD[s] !== undefined) {
    return validateNum(INT_MISREAD[s], schema);
  }

  return { value: null, status: 'invalid' };
}

// ─── 필드 매칭 ───────────────────────────────────────────────
// 반환: { field, method, score, suffix } | null
// 매칭 우선순위: exact > alias > attached(숫자 suffix) > (fuzzy 없음)
function matchFieldInText(text, fields) {
  // Level 1: 정확한 이름 매칭
  for (const f of fields) {
    if (text === f.name) return { field: f, method: 'exact', score: 1.0, suffix: '' };
  }

  // Level 2: 정확한 alias 매칭
  for (const f of fields) {
    for (const alias of f.aliases) {
      if (text === alias) return { field: f, method: 'alias', score: 0.95, suffix: '' };
    }
  }

  // Level 3: 붙여말하기(attached) – alias로 시작 + 숫자 suffix
  const allRefs = [];
  for (const f of fields) {
    for (const ref of [f.name, ...f.aliases]) {
      allRefs.push({ ref, field: f });
    }
  }
  // 긴 alias 우선 (greedy)
  allRefs.sort((a, b) => b.ref.length - a.ref.length);

  for (const { ref, field } of allRefs) {
    if (text.length > ref.length && text.startsWith(ref)) {
      const suffix = text.substring(ref.length);
      if (looksLikeNumber(suffix)) {
        return { field, method: 'attached', score: 0.9, suffix };
      }
    }
  }

  return null;
}

// ─── 점(소수점) 토큰 병합 ────────────────────────────────────
function mergeDecimalTokens(tokens) {
  const result = [];
  let i = 0;
  while (i < tokens.length) {
    // X 점 Y 패턴
    if (i + 2 < tokens.length && tokens[i + 1] === '점') {
      result.push(tokens[i] + '점' + tokens[i + 2]);
      i += 3;
    // 점 Y 패턴 (앞 토큰이 result 마지막에 있는 경우)
    } else if (tokens[i] === '점' && result.length > 0 && i + 1 < tokens.length) {
      const prev = result.pop();
      result.push(prev + '점' + tokens[i + 1]);
      i += 2;
    } else {
      result.push(tokens[i]);
      i++;
    }
  }
  return result;
}

// ─── 메인 파서 ───────────────────────────────────────────────
export function parseVoice(rawText, fields) {
  if (!rawText || !rawText.trim()) return [];

  // 정규화: 한글↔숫자 경계에 공백
  const normalized = rawText
    .replace(/([가-힣])(\d)/g, '$1 $2')
    .replace(/(\d)([가-힣])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();

  let tokens = normalized.split(' ').filter(t => t.length > 0);
  tokens = mergeDecimalTokens(tokens);

  const results = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];
    const match = matchFieldInText(tok, fields);

    if (!match) { i++; continue; }

    const { field, method, score, suffix } = match;

    // 자유문장 필드(비고): 이후 토큰 전부 수집
    if (field.freeText) {
      const textParts = suffix ? [suffix, ...tokens.slice(i + 1)] : tokens.slice(i + 1);
      const freeText = textParts.join(' ').trim();
      results.push({
        field, value: freeText || null, method, score, raw: tok,
        status: freeText ? 'ok' : 'pending', warn: false
      });
      break;
    }

    // 붙여말하기 – suffix를 직접 값으로 파싱
    if (suffix) {
      const vr = parseValueForField(suffix, field);
      results.push({ field, value: vr.value, method, score, raw: tok, status: vr.status, warn: vr.warn || false });
      i++;
      continue;
    }

    // 다음 토큰을 값으로 시도
    if (i + 1 < tokens.length) {
      const nextTok = tokens[i + 1];
      if (!matchFieldInText(nextTok, fields)) {
        const vr = parseValueForField(nextTok, field);
        if (vr.status !== 'invalid') {
          results.push({ field, value: vr.value, method, score, raw: tok, status: vr.status, warn: vr.warn || false });
          i += 2;
          continue;
        }
      }
    }

    // 값 없음 – pending
    results.push({ field, value: null, method, score, raw: tok, status: 'pending', warn: false });
    i++;
  }

  return results;
}

// ─── overwrite 허용 판단 ─────────────────────────────────────
export function canOverwrite(newText, lastSaved, fields) {
  if (!lastSaved) return null;
  if (Date.now() - lastSaved.time > 1500) return null;

  const num = tryParseNumber(newText.trim());
  if (num === null) return null;
  if (num > 1e8) return null; // 노이즈 숫자 차단

  const field = fields.find(f => f.id === lastSaved.fieldId);
  if (!field) return null;

  const vr = validateNum(num, field);
  if (vr.status !== 'ok') return null;

  return { field, value: vr.value, warn: vr.warn };
}

// ─── 테스트 케이스 실행 ──────────────────────────────────────
export function runTests(fields) {
  const cases = [
    // 조사나무
    { in: '나무 일',    field: '조사나무', val: 1 },
    { in: '나무이',     field: '조사나무', val: 2 },
    { in: '나무삼',     field: '조사나무', val: 3 },
    { in: '나무 사',    field: '조사나무', val: 4 },
    { in: '나무로',     field: '조사나무', val: 5 },
    // 조사과실
    { in: '과실이',     field: '조사과실', val: 2 },
    { in: '과실삼',     field: '조사과실', val: 3 },
    { in: '과실오',     field: '조사과실', val: 5 },
    { in: '거실 사',    field: '조사과실', val: 4 },
    // 횡경
    { in: '변경 44.4',  field: '횡경',    val: 44.4 },
    { in: '생경 122.2', field: '횡경',    val: 122.2 },
    { in: '변경백',     field: '횡경',    val: 100 },
    { in: '변경 200',   field: '횡경',    val: 200 },
    { in: '행정 211',   field: '횡경',    val: 211 }, // warning
    // 종경
    { in: '동경 11.1',  field: '종경',    val: 11.1 },
    { in: '존경 55.5',  field: '종경',    val: 55.5 },
    { in: '동경 200',   field: '종경',    val: 200 },
    // 오매칭 방지
    { in: '누가 나무 위',   field: '조사나무', val: 2 },
    { in: '누가 나무 삼',   field: '조사나무', val: 3 },
    // 노이즈 숫자 – 횡경 결과 없어야 함
    { in: '횡경 10000000000', field: '횡경', val: null, expectNoValue: true },
  ];

  return cases.map(tc => {
    const parsed = parseVoice(tc.in, fields);
    const hit = parsed.find(r => r.field && r.field.name === tc.field);
    let pass;
    if (tc.expectNoValue) {
      pass = !hit || hit.value === null || hit.status === 'noise';
    } else {
      pass = !!(hit && hit.value === tc.val);
    }
    return {
      input: tc.in,
      expected: tc.expectNoValue ? `${tc.field}=null(noise)` : `${tc.field}=${tc.val}`,
      actual: hit
        ? `${hit.field.name}=${hit.value}(${hit.status}${hit.warn ? ',warn' : ''})`
        : 'no match',
      pass
    };
  });
}
