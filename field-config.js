'use strict';
// field-config.js – 스키마 기반 조사 항목 설정 관리

const STORAGE_KEY = 'citrusSurveyFields_v3';

export const DEFAULT_FIELDS = [
  {
    id: 'tree_no',
    name: '조사나무',
    aliases: ['나무', '조사나무', '조사나오', '나무산', '나무성', '나보', '나 무', '나무 섬'],
    type: 'integer',
    allowed: [1, 2, 3, 4, 5],
    range: null,
    warningRange: null,
    freeText: false,
    unit: '',
    description: '조사 나무 번호 (1-5)'
  },
  {
    id: 'fruit_no',
    name: '조사과실',
    aliases: ['과실', '조사과실', '거실', '화실', '과제', '과실로', '다시', '마시', '바지다'],
    type: 'integer',
    allowed: [1, 2, 3, 4, 5],
    range: null,
    warningRange: null,
    freeText: false,
    unit: '',
    description: '조사 과실 번호 (1-5)'
  },
  {
    id: 'horizontal',
    name: '횡경',
    aliases: ['횡경', '변경', '생경', '성경', '은경', '행경', '행정', '휑경', '횡겨', '형경'],
    type: 'float',
    allowed: null,
    range: [0, 300],
    warningRange: [201, 300],
    freeText: false,
    unit: 'mm',
    description: '횡경(mm) – 주의 >200'
  },
  {
    id: 'vertical',
    name: '종경',
    aliases: ['종경', '존경', '동경', '정경', '중경', '종겨'],
    type: 'float',
    allowed: null,
    range: [0, 300],
    warningRange: [201, 300],
    freeText: false,
    unit: 'mm',
    description: '종경(mm) – 주의 >200'
  },
  {
    id: 'memo',
    name: '비고',
    aliases: ['비고'],
    type: 'string',
    allowed: null,
    range: null,
    warningRange: null,
    freeText: true,
    unit: '',
    description: '자유 메모 (LLM 정리 경로)'
  }
];

let _cache = null;

export function getFields() {
  if (_cache) return _cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { _cache = JSON.parse(raw); return _cache; }
  } catch {}
  _cache = DEFAULT_FIELDS.map(f => ({ ...f, aliases: [...f.aliases] }));
  return _cache;
}

export function saveFields(fields) {
  _cache = fields;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(fields));
}

export function resetFields() {
  _cache = DEFAULT_FIELDS.map(f => ({ ...f, aliases: [...f.aliases] }));
  saveFields(_cache);
  return _cache;
}

export function addField(field) {
  const fields = getFields();
  const newField = {
    id: `custom_${Date.now()}`,
    name: field.name || '새 항목',
    aliases: field.aliases || [field.name],
    type: field.type || 'integer',
    allowed: field.allowed || null,
    range: field.range || null,
    warningRange: field.warningRange || null,
    freeText: field.freeText || false,
    unit: field.unit || '',
    description: field.description || ''
  };
  fields.push(newField);
  saveFields(fields);
  return newField;
}

export function updateField(id, updates) {
  const fields = getFields();
  const idx = fields.findIndex(f => f.id === id);
  if (idx < 0) return null;
  fields[idx] = { ...fields[idx], ...updates };
  saveFields(fields);
  return fields[idx];
}

export function removeField(id) {
  const fields = getFields().filter(f => f.id !== id);
  saveFields(fields);
}

// 새 항목 등록 시 기본 alias 후보 생성
export function generateAliases(name) {
  const list = [name];
  if (name.length > 1) {
    // 마지막 글자 제거 버전
    list.push(name.substring(0, name.length - 1));
    // 공백 삽입
    list.push(name.substring(0, 1) + ' ' + name.substring(1));
  }
  return [...new Set(list)].filter(a => a.trim().length > 0);
}
