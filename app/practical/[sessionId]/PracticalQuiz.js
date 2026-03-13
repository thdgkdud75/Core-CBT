'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Settings } from 'lucide-react';
import { trackEvent } from '@/lib/analyticsClient';
import { removeUnknownProblem, upsertUnknownProblem } from '@/lib/unknownProblemsStore';
import { QuizResults, TestLobby, UpdateNoticeModal } from './components/QuizShellParts';
import {
  GptChatModal,
  GptHelpSection,
  GptLoadingOverlay,
  QuizSettingsPopover,
  ReportTipToast,
} from './components/QuizInteractiveParts';

const T = {
  loadFail: '문제를 불러오는 데 실패했습니다.',
  needSelect: '답을 선택해주세요.',
  problem: '문제',
  settings: '해설 설정',
  enableCheck: '문제 정답 여부 확인',
  showCorrect: '해설보기 (정답 선택 시)',
  showWrong: '해설보기 (오답 선택 시)',
  end: '종료',
  navTitle: '문제 네비게이션',
  statusCorrect: '정답',
  statusWrong: '오답',
  statusUnsolved: '미풀이',
  statusSolved: '풀이함',
  correct: '정답입니다!',
  wrong: '오답입니다!',
  unknownRetry: '모르겠어요만 다시 풀기',
  answer: '정답',
  numberSuffix: '번',
  explanation: '해설',
  prev: '이전',
  next: '다음',
  check: '정답 확인',
  resultView: '결과 보기',
  backToSession: '회차 선택으로 돌아가기',
  lobbyTitle: '모의시험 준비',
  start: '시험 시작',
  realStart: '실제 시험처럼 풀기',
  score: '총 점수',
  pass: '합격입니다!',
  fail: '불합격입니다!',
  subject: '과목',
  qCount: '문제',
  avoidFail: '통과',
  failSubject: '과락',
  chooseOther: '다른 회차 선택',
};

const UPDATE_NOTICE_KEY = 'update_notice_2026_02_keyboard_nav';
const REPORT_TIP_NOTICE_KEY = 'report_tip_notice_2026_02_once';
const SETTINGS_AUTO_OPEN_KEY = 'settings_auto_open_seen_2026_02';
const REPORT_REASONS = ['그림이 없음', '해설이 이상함', '해설이없음', '문제가 이상함', '문제가없음', '기타'];
const GPT_MAX_TURNS = 3;
const RESUME_STATE_KEY_PREFIX = 'quiz_resume_state_';
const UNKNOWN_OPTION = '__UNKNOWN_OPTION__';
const QUIZ_DURATION_SECONDS = 60 * 60;
const GPT_LOCAL_STATE_SOFT_LIMIT_BYTES = 3_500_000;
const GPT_LOCAL_STATE_HARD_LIMIT_BYTES = 4_500_000;

function estimateLocalStorageBytes(text) {
  return String(text || '').length * 2;
}

function isQuotaExceededError(error) {
  return (
    error?.name === 'QuotaExceededError' ||
    error?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error?.code === 22 ||
    error?.code === 1014
  );
}

function buildGptStatePayloadWithPrune({
  usedProblems,
  conversations,
  softLimitBytes = GPT_LOCAL_STATE_SOFT_LIMIT_BYTES,
}) {
  const nextUsed = { ...(usedProblems && typeof usedProblems === 'object' ? usedProblems : {}) };
  const nextConversations = { ...(conversations && typeof conversations === 'object' ? conversations : {}) };
  let payload = { usedProblems: nextUsed, conversations: nextConversations };
  let serialized = JSON.stringify(payload);
  if (estimateLocalStorageBytes(serialized) <= softLimitBytes) {
    return { payload, serialized, prunedCount: 0 };
  }

  // Object key insertion order is used as a lightweight "oldest first" fallback.
  let prunedCount = 0;
  for (const key of Object.keys(nextConversations)) {
    delete nextConversations[key];
    delete nextUsed[key];
    prunedCount += 1;
    payload = { usedProblems: nextUsed, conversations: nextConversations };
    serialized = JSON.stringify(payload);
    if (estimateLocalStorageBytes(serialized) <= softLimitBytes) {
      return { payload, serialized, prunedCount };
    }
  }

  for (const key of Object.keys(nextUsed)) {
    delete nextUsed[key];
    prunedCount += 1;
    payload = { usedProblems: nextUsed, conversations: nextConversations };
    serialized = JSON.stringify(payload);
    if (estimateLocalStorageBytes(serialized) <= softLimitBytes) break;
  }

  return { payload, serialized, prunedCount };
}

function saveGptStateToLocalStorage(storageKey, { usedProblems, conversations }) {
  const firstPass = buildGptStatePayloadWithPrune({
    usedProblems,
    conversations,
    softLimitBytes: GPT_LOCAL_STATE_HARD_LIMIT_BYTES,
  });

  try {
    window.localStorage.setItem(storageKey, firstPass.serialized);
    return {
      ...firstPass,
      usedProblems: firstPass.payload.usedProblems,
      conversations: firstPass.payload.conversations,
      pruned: firstPass.prunedCount > 0,
    };
  } catch (e) {
    if (!isQuotaExceededError(e)) throw e;

    const secondPass = buildGptStatePayloadWithPrune({
      usedProblems,
      conversations,
      softLimitBytes: GPT_LOCAL_STATE_SOFT_LIMIT_BYTES,
    });
    window.localStorage.setItem(storageKey, secondPass.serialized);
    return {
      ...secondPass,
      usedProblems: secondPass.payload.usedProblems,
      conversations: secondPass.payload.conversations,
      pruned: secondPass.prunedCount > 0,
    };
  }
}

function getSequenceMeta(problem, correctAnswer = '') {
  const explicitInputType = String(problem?.input_type || '');
  const explicitInputLabels = Array.isArray(problem?.input_labels)
    ? problem.input_labels.map((label) => String(label ?? '').trim()).filter(Boolean)
    : [];
  const examples = String(problem?.examples ?? '');
  const questionText = String(problem?.question_text ?? '');
  const lines = examples.split(/\r?\n/);
  const markers = [];

  for (const line of lines) {
    const m = line.match(/^\s*([ㄱ-ㅎ]|[①-⑳]|\d+)\s*[.)]\s*/);
    if (m) markers.push(m[1]);
  }

  const first = markers[0] || '';
  let kind = /[ㄱ-ㅎ]/.test(first)
    ? 'korean_jamo'
    : /[①-⑳]/.test(first)
      ? 'circled'
      : /^\d+$/.test(first)
        ? 'number'
        : 'generic';

  const answerText = String(correctAnswer ?? '');
  if (kind === 'generic') {
    if (/[ㄱ-ㅎ]/.test(answerText)) kind = 'korean_jamo';
    else if (/[①-⑳]/.test(answerText)) kind = 'circled';
    else if (/\d/.test(answerText)) kind = 'number';
  }
  const asksSelectAll =
    /(모두\s*고르|모두\s*골라|옳은\s*것(?:을)?\s*모두|해당하는\s*것(?:을)?\s*모두)/.test(questionText);
  const hasSymbolListAnswer =
    /[ㄱ-ㅎ]/.test(answerText) || /[①-⑳]/.test(answerText) || /(?:^|[^\d])\d+\s*[,→\-]/.test(answerText);
  const mode = explicitInputType === 'unordered_symbol_set'
    ? 'unordered_symbol_set'
    : explicitInputType === 'ordered_sequence'
      ? 'ordered'
      : asksSelectAll && hasSymbolListAnswer
        ? 'unordered_symbol_set'
        : 'ordered';

  return {
    count: Math.min(Math.max(explicitInputLabels.length || markers.length || 4, 2), 10),
    kind,
    mode,
    markersCount: markers.length,
  };
}

function getMultiBlankMeta(problem, correctAnswer = '') {
  const explicitInputLabels = Array.isArray(problem?.input_labels)
    ? problem.input_labels.map((label) => normalizeLabelToken(label)).filter(Boolean)
    : [];
  if (explicitInputLabels.length >= 2) {
    return { labels: [...new Set(explicitInputLabels)].slice(0, 10) };
  }

  const source = `${String(problem?.question_text ?? '')}\n${String(problem?.examples ?? '')}`;
  const lines = source.split(/\r?\n/);
  const labels = [];
  const seen = new Set();

  for (const line of lines) {
    const m = line.match(/^\s*(\([가-힣]\)|[가-힣]\.|[①-⑳]|[ㄱ-ㅎ]|\d+\)|\d+\.)\s*/);
    if (!m) continue;
    const label = normalizeLabelToken(m[1]);
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }

  // 정답 문자열에 라벨이 명확히 있으면(가/나, ①/②, ㄱ/ㄴ 등) 입력 UI 라벨로 우선 사용
  // 예: 문제 본문엔 라벨이 없는데 정답은 "가: AVG, 나: COUNT" 형태인 경우
  const answerLabels = [];
  const answerSeen = new Set();
  for (const m of getLabeledTokenMatches(String(correctAnswer ?? ''))) {
    const label = m.label;
    if (!answerSeen.has(label)) {
      answerSeen.add(label);
      answerLabels.push(label);
    }
  }

  if (answerLabels.length >= 2) {
    return { labels: answerLabels.slice(0, 10) };
  }

  // "차수 3, 카디널리티 4"처럼 명시 라벨 기호 없이 라벨+값 쌍으로 적힌 정답도 입력칸 라벨로 사용한다.
  const inferredPairLabels = inferNamedPairLabelsFromAnswer(correctAnswer);
  if (inferredPairLabels.length >= 2) {
    return { labels: inferredPairLabels.slice(0, 10) };
  }

  // 보기 항목(ㄱ,ㄴ,ㄷ,ㄹ)만 잡힌 경우가 있어도 입력칸으로는 유효함.
  // 아무 표식도 못 잡으면 기본 2칸으로 처리한다.
  if (labels.length === 0) return { labels: ['①', '②'] };
  return { labels: labels.slice(0, 10) };
}

function inferNamedPairLabelsFromAnswer(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  if (getLabeledTokenMatches(text).length >= 2) return [];

  const parts = text
    .split(/\s*[,/|]\s*/g)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return [];

  const labels = [];
  const seen = new Set();
  for (const part of parts) {
    // 예: "차수 3", "카디널리티 4", "차수(Degree): 3"
    const m = part.match(/^([^\d,:：]+?)(?:\s*[:：]\s*|\s+\d)/);
    if (!m) return [];
    let label = String(m[1] || '')
      .replace(/\s*\((.*?)\)\s*$/g, '')
      .trim();
    if (!label) return [];
    // 너무 긴 자유문장은 라벨로 보지 않는다.
    if (label.length > 20) return [];
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels.length >= 2 ? labels : [];
}

function parsePracticalSymbolChoices(problem) {
  const questionText = String(problem?.question_text ?? '');
  const examples = String(problem?.examples ?? '');
  if (!examples.trim()) return [];
  if (!/[<＜]보기[>＞]/.test(examples) && !/보기/.test(questionText)) return [];

  const choices = [];
  const seenLabels = new Set();
  for (const line of examples.split(/\r?\n/)) {
    const m = line.match(/^\s*([ㄱ-ㅎ]|[①-⑳])\s*[.)]?\s*(.+?)\s*$/);
    if (!m) continue;
    const label = m[1];
    const text = String(m[2] || '').trim();
    if (!text) continue;
    // <보기>, SQL/코드 라인 등은 제외
    if (/^<\s*보기\s*>$/i.test(text)) continue;
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    choices.push({
      label,
      text,
      fullText: `${label}. ${text}`,
      altText: `${label} ${text}`,
    });
  }
  return choices.length >= 2 ? choices : [];
}

function renderExamplesRichText(examples) {
  const lines = String(examples ?? '').split(/\r?\n/);
  const nodes = [];
  let key = 0;

  for (const line of lines) {
    if (!line.trim()) {
      nodes.push(<div key={`ex-sp-${key++}`} className="h-3" aria-hidden="true" />);
      continue;
    }

    if (!/<img\s/i.test(line)) {
      nodes.push(
        <p key={`ex-t-${key++}`} className="text-gray-800 whitespace-pre-wrap leading-relaxed font-mono text-sm">
          {line}
        </p>
      );
      continue;
    }

    const imgRegex = /<img\s+[^>]*src=(\"|')(.*?)\1[^>]*>/gi;
    let lastIndex = 0;
    let match;
    while ((match = imgRegex.exec(line)) !== null) {
      const before = line.slice(lastIndex, match.index);
      if (before.trim()) {
        nodes.push(
          <p key={`ex-t-${key++}`} className="text-gray-800 whitespace-pre-wrap leading-relaxed font-mono text-sm">
            {before}
          </p>
        );
      }
      const tag = match[0];
      const src = match[2] || '';
      const altMatch = tag.match(/alt=(\"|')(.*?)\1/i);
      const alt = altMatch ? altMatch[2] : 'image';
      if (src.startsWith('/')) {
        nodes.push(
          <div key={`ex-img-${key++}`} className="my-2">
            <img src={src} alt={alt} className="max-w-full h-auto rounded-md border border-sky-200" />
          </div>
        );
      } else {
        nodes.push(
          <p key={`ex-t-${key++}`} className="text-gray-800 whitespace-pre-wrap leading-relaxed font-mono text-sm">
            [이미지: {src}]
          </p>
        );
      }
      lastIndex = match.index + match[0].length;
    }
    const after = line.slice(lastIndex);
    if (after.trim()) {
      nodes.push(
        <p key={`ex-t-${key++}`} className="text-gray-800 whitespace-pre-wrap leading-relaxed font-mono text-sm">
          {after}
        </p>
      );
    }
  }

  return nodes;
}

function splitSequenceDraft(value, count) {
  const tokens = String(value ?? '')
    .split(/\s*(?:->|→|-|,|\/)\s*/g)
    .map((v) => v.trim())
    .filter(Boolean);
  return Array.from({ length: count }, (_, idx) => tokens[idx] || '');
}

function splitMultiBlankDraft(value, labels) {
  const text = String(value ?? '');
  if (!text.trim()) return labels.map(() => '');

  const escaped = labels
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(^|[\\s,\\/|])(${escaped.join('|')})(?:\\s*[:：-]\\s*|\\s+(?=[^,\\/|\\s]))`, 'g');
  const matches = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const prefix = m[1] || '';
    matches.push({
      label: m[2],
      index: (m.index ?? 0) + prefix.length,
      fullLength: m[0].length - prefix.length,
    });
  }
  if (matches.length > 0) {
    const result = labels.map(() => '');
    for (let i = 0; i < matches.length; i++) {
      const label = matches[i].label;
      const start = matches[i].index + matches[i].fullLength;
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
      const idx = labels.indexOf(label);
      if (idx >= 0) {
        result[idx] = text
          .slice(start, end)
          .trim()
          .replace(/^[-:：]\s*/, '')
          .replace(/\s*(?:\/|,|\|)\s*$/g, '');
      }
    }
    return result;
  }

  // fallback: 구분자로 대충 나눈다(재입력/이전 저장값 호환용)
  const tokens = text
    .split(/\s*(?:\/|,|\|)\s*/g)
    .map((v) => v.trim())
    .filter(Boolean);
  return labels.map((_, idx) => tokens[idx] || '');
}

function sanitizeSequenceToken(value, kind) {
  const rawOriginal = String(value ?? '').replace(/\s+/g, '');
  if (!rawOriginal) return '';

  if (kind === 'korean_jamo') {
    const m = rawOriginal.match(/[ㄱ-ㅎ]/);
    if (m) return m[0];

    // 일부 IME/브라우저 조합 입력은 초성 자모(U+1100대)로 들어올 수 있어 호환 자모로 변환한다.
    const compatibilityMap = {
      '\u1100': 'ㄱ', '\u1101': 'ㄲ', '\u1102': 'ㄴ', '\u1103': 'ㄷ', '\u1104': 'ㄸ',
      '\u1105': 'ㄹ', '\u1106': 'ㅁ', '\u1107': 'ㅂ', '\u1108': 'ㅃ', '\u1109': 'ㅅ',
      '\u110A': 'ㅆ', '\u110B': 'ㅇ', '\u110C': 'ㅈ', '\u110D': 'ㅉ', '\u110E': 'ㅊ',
      '\u110F': 'ㅋ', '\u1110': 'ㅌ', '\u1111': 'ㅍ', '\u1112': 'ㅎ',
    };
    for (const ch of rawOriginal.normalize('NFD')) {
      if (compatibilityMap[ch]) return compatibilityMap[ch];
    }
    return '';
  }
  if (kind === 'circled') {
    const m = rawOriginal.match(/[①-⑳]/);
    if (m) return m[0];
    // 숫자 입력도 허용하고 내부 표현은 원문자 숫자로 통일한다.
    const digit = rawOriginal.normalize('NFKC').match(/\d+/)?.[0];
    const circled = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
    if (!digit) return '';
    const n = Number(digit);
    return Number.isInteger(n) && n >= 1 && n <= 20 ? circled[n - 1] : '';
  }
  if (kind === 'number') {
    const m = rawOriginal.normalize('NFKC').match(/\d+/);
    return m ? m[0].slice(0, 2) : '';
  }
  return rawOriginal.normalize('NFKC').slice(0, 4);
}

function normalizePracticalAnswer(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeLabelToken(label) {
  const raw = String(label ?? '').trim();
  if (!raw) return raw;

  // (가), 가., 가 -> 가
  const koreanParen = raw.match(/^\(([가-힣])\)$/);
  if (koreanParen) return koreanParen[1];
  const koreanDot = raw.match(/^([가-힣])\.$/);
  if (koreanDot) return koreanDot[1];
  if (/^[가-힣]$/.test(raw)) return raw;

  // (1), 1), 1. -> 1
  const numParen = raw.match(/^\((\d+)\)$/);
  if (numParen) return numParen[1];
  const numDot = raw.match(/^(\d+)[.)]$/);
  if (numDot) return numDot[1];
  if (/^\d+$/.test(raw)) return raw;

  return raw;
}

function getLabeledTokenMatches(text) {
  const target = String(text ?? '').trim();
  if (!target) return [];
  const labelCore =
    '(\\([가-힣]\\)|[가-힣]\\.|\\(\\d+\\)|[가나다라마바사아자차카타파하]|[①-⑳]|[ㄱ-ㅎ]|\\d+\\)|\\d+\\.)';
  const pattern = new RegExp(`(^|[\\s,\\/|])${labelCore}(?:\\s*[:：-]\\s*|\\s+(?=[^,\\/|\\s]))`, 'g');
  const matches = [];
  let m;
  while ((m = pattern.exec(target)) !== null) {
    const prefix = m[1] || '';
    matches.push({
      label: normalizeLabelToken(m[2]),
      index: (m.index ?? 0) + prefix.length,
      fullLength: m[0].length - prefix.length,
    });
  }
  return matches;
}

function normalizeSequenceLikeAnswer(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const arrowNormalized = raw.replace(/->/g, '→');

  // ㄱ-ㄴ-ㄷ / ㄱ, ㄴ, ㄷ / ㄱ → ㄴ → ㄷ 같은 순서형 답안을 같은 형식으로 정규화
  if (/[ㄱ-ㅎ]/.test(arrowNormalized)) {
    const cleaned = arrowNormalized.replace(/\s+/g, '');
    if (/^[ㄱ-ㅎ,./→\-]+$/.test(cleaned)) {
      const tokens = cleaned.match(/[ㄱ-ㅎ]/g) || [];
      return tokens.length >= 2 ? tokens.join('-') : null;
    }
  }

  // ①②③ 또는 ①-②-③ 형태
  if (/[①-⑳]/.test(arrowNormalized)) {
    const cleaned = arrowNormalized.replace(/\s+/g, '');
    if (/^[①-⑳,./→\-]+$/.test(cleaned)) {
      const tokens = cleaned.match(/[①-⑳]/g) || [];
      return tokens.length >= 2 ? tokens.join('-') : null;
    }
  }

  // 1-2-3, 1,2,3 같은 숫자 순서형
  const compact = arrowNormalized.replace(/\s+/g, '');
  if (/^\d+(?:[,./→\-]\d+)+$/.test(compact)) {
    const tokens = compact.match(/\d+/g) || [];
    return tokens.length >= 2 ? tokens.join('-') : null;
  }

  return null;
}

function normalizeUnorderedSymbolSetAnswer(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const text = raw.replace(/->/g, '→').replace(/\s+/g, '');

  if (/[ㄱ-ㅎ]/.test(text) && /^[ㄱ-ㅎ,./→\-]+$/.test(text)) {
    const tokens = [...new Set(text.match(/[ㄱ-ㅎ]/g) || [])].sort();
    return tokens.length >= 1 ? tokens.join('|') : null;
  }
  if (/[①-⑳]/.test(text) && /^[①-⑳,./→\-]+$/.test(text)) {
    const tokens = [...new Set(text.match(/[①-⑳]/g) || [])].sort();
    return tokens.length >= 1 ? tokens.join('|') : null;
  }
  if (/^\d+(?:[,./→\-]\d+)+$/.test(text) || /^\d+$/.test(text)) {
    const tokens = [...new Set(text.match(/\d+/g) || [])].sort((a, b) => Number(a) - Number(b));
    return tokens.length >= 1 ? tokens.join('|') : null;
  }

  return null;
}

function normalizeLabeledMultiBlankAnswer(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const matches = getLabeledTokenMatches(text);
  if (matches.length < 2) return null;

  const pairs = [];
  const seenLabels = new Set();
  for (let i = 0; i < matches.length; i++) {
    const label = matches[i].label;
    if (seenLabels.has(label)) return null;
    seenLabels.add(label);
    const start = (matches[i].index ?? 0) + matches[i].fullLength;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    // "가: 값 / 나: 값" 직렬화 형식에서 다음 라벨 앞 구분자(/)가 값 끝에 남지 않도록 제거
    const rawValue = text.slice(start, end).trim().replace(/[,\s/|]+$/g, '');
    if (!rawValue) continue;
    const normalizedValue = normalizePracticalAnswer(rawValue);
    if (!normalizedValue) continue;
    pairs.push(`${label}:${normalizedValue}`);
  }

  return pairs.length >= 2 ? pairs.join('|') : null;
}

function normalizeLabeledMultiBlankValuesOnly(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const matches = getLabeledTokenMatches(text);
  if (matches.length < 2) return null;

  const values = [];
  for (let i = 0; i < matches.length; i++) {
    const start = (matches[i].index ?? 0) + matches[i].fullLength;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const rawValue = text.slice(start, end).trim().replace(/[,\s/|]+$/g, '');
    if (!rawValue) continue;
    const normalizedValue = normalizePracticalAnswer(rawValue);
    if (!normalizedValue) continue;
    values.push(normalizedValue);
  }
  return values.length >= 2 ? values.join('|') : null;
}

function parseLabeledMultiBlankValues(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const matches = getLabeledTokenMatches(text);
  if (matches.length < 2) return null;

  const values = [];
  for (let i = 0; i < matches.length; i++) {
    const start = (matches[i].index ?? 0) + matches[i].fullLength;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const rawValue = text.slice(start, end).trim().replace(/[,\s/|]+$/g, '');
    if (!rawValue) continue;
    values.push(rawValue);
  }
  return values.length >= 2 ? values : null;
}

function parseLabeledMultiBlankValuesByKnownLabels(value, labels) {
  if (!Array.isArray(labels) || labels.length < 2) return null;
  const text = String(value ?? '');
  if (!text.trim()) return null;

  // UI 직렬화 형식(라벨: 값 / 라벨: 값)을 기준으로 known label 순서대로 안정적으로 분해한다.
  // 정규식 추론이 흔들리는 (가)/(나)/(다)/(라), 1)/2), 한글 조사 포함 값 케이스를 우선적으로 처리한다.
  const values = [];
  let searchFrom = 0;

  for (let i = 0; i < labels.length; i++) {
    const label = String(labels[i] ?? '');
    if (!label) return null;

    const labelIndex = text.indexOf(label, searchFrom);
    if (labelIndex < 0) return null;

    let valueStart = labelIndex + label.length;
    // 라벨 뒤 구분자(: / - / . / ) / 공백)를 넘긴다.
    while (valueStart < text.length && /[\s:：\-.)]/.test(text[valueStart])) valueStart += 1;

    let valueEnd = text.length;
    if (i + 1 < labels.length) {
      const nextLabel = String(labels[i + 1] ?? '');
      const nextIndex = text.indexOf(nextLabel, valueStart);
      if (nextIndex < 0) return null;
      valueEnd = nextIndex;
      searchFrom = nextIndex;
    } else {
      searchFrom = valueStart;
    }

    const raw = text
      .slice(valueStart, valueEnd)
      .trim()
      .replace(/^[,\/|]\s*/g, '')
      .replace(/[,\s/|]+$/g, '');
    values.push(raw);
  }

  if (values.filter(Boolean).length >= labels.length) return values;

  // fallback: 기존 draft 분해 로직 (예전 저장 문자열 호환)
  const parts = splitMultiBlankDraft(text, labels).map((v) => String(v ?? '').trim());
  if (parts.filter(Boolean).length < labels.length) return null;
  return parts.map((v) => v.replace(/[,\s/|]+$/g, ''));
}

function buildFlexibleFieldVariants(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return new Set();
  const normalizedRaw = normalizePracticalAnswer(raw);
  const variants = new Set([normalizedRaw]);

  const text = raw.normalize('NFKC').trim();
  const colonIdx = text.search(/[:：]/);
  const head = colonIdx >= 0 ? text.slice(0, colonIdx).trim() : text;
  const tail = colonIdx >= 0 ? text.slice(colonIdx + 1).trim() : '';

  const headNorm = normalizePracticalAnswer(head);
  if (headNorm) variants.add(headNorm);

  const parenMatch = head.match(/^(.+?)\s*\((.+)\)\s*$/);
  if (parenMatch) {
    const left = normalizePracticalAnswer(parenMatch[1]);
    const right = normalizePracticalAnswer(parenMatch[2]);
    if (left) variants.add(left);
    if (right) variants.add(right);
    if (tail) {
      const tailNorm = normalizePracticalAnswer(tail);
      if (left && tailNorm) variants.add(`${left}: ${tailNorm}`);
      if (right && tailNorm) variants.add(`${right}: ${tailNorm}`);
    }
  }

  if (tail) {
    const tailNorm = normalizePracticalAnswer(tail);
    if (headNorm && tailNorm) variants.add(`${headNorm}: ${tailNorm}`);
  }

  // "A 또는 B" 형태도 필드 단위에서 허용
  for (const part of text.split(/\s*또는\s*/)) {
    const p = normalizePracticalAnswer(part);
    if (p) variants.add(p);
  }

  return variants;
}

function normalizeCommaSeparatedTermSet(value) {
  const text = String(value ?? '').trim();
  if (!text.includes(',')) return null;
  const tokens = text
    .split(',')
    .map((part) => normalizePracticalAnswer(part).replace(/[.)]+$/g, '').trim())
    .filter(Boolean);
  if (tokens.length < 2) return null;
  return [...new Set(tokens)].sort().join('|');
}

function isEquivalentMultiBlankFieldValue(userValue, correctValue) {
  const userVariants = buildFlexibleFieldVariants(userValue);
  const correctVariants = buildFlexibleFieldVariants(correctValue);
  if (userVariants.size === 0 || correctVariants.size === 0) return false;
  for (const v of userVariants) {
    if (correctVariants.has(v)) return true;
  }

  // 쉼표로 나열한 분류형 답안(예: DDL/DML/DCL 목록)은 순서를 무시하고 비교한다.
  const userCommaSet = normalizeCommaSeparatedTermSet(userValue);
  const correctCommaSet = normalizeCommaSeparatedTermSet(correctValue);
  if (userCommaSet && correctCommaSet && userCommaSet === correctCommaSet) return true;

  // "ㄴㄹ", "ㄴ, ㄹ", "ㄹ-ㄴ" 같은 기호 집합 입력도 필드 단위에서 순서 무시 비교
  const userSymbolSet = normalizeUnorderedSymbolSetAnswer(userValue);
  const correctSymbolSet = normalizeUnorderedSymbolSetAnswer(correctValue);
  if (userSymbolSet && correctSymbolSet && userSymbolSet === correctSymbolSet) return true;

  return false;
}

function buildAcceptedPracticalAnswers(correctAnswer, problem = null) {
  const raw = String(correctAnswer ?? '').trim();
  const accepted = new Set();
  if (raw) accepted.add(raw);

  const explicitAccepted = Array.isArray(problem?.accepted_answers)
    ? problem.accepted_answers
    : [];
  for (const candidate of explicitAccepted) {
    const t = String(candidate ?? '').trim();
    if (t) accepted.add(t);
  }

  if (!raw) {
    return [...accepted].map(normalizePracticalAnswer).filter(Boolean);
  }

  const parenMatch = raw.match(/^(.+?)\s*\((.+)\)$/);
  if (parenMatch) {
    accepted.add(parenMatch[1].trim());
    accepted.add(parenMatch[2].trim());
  }

  // 단일 입력 문제인데 정답 데이터가 "(가) 값", "1) 값", "ㄱ: 값"처럼
  // 라벨 1개가 포함된 형태로 저장된 경우에는 값만 입력해도 정답으로 본다.
  const singleLabeledValues = parseLabeledMultiBlankValues(raw);
  if (singleLabeledValues && singleLabeledValues.length === 1) {
    accepted.add(String(singleLabeledValues[0] ?? '').trim());
  }
  const singleLeadingLabel = raw.match(/^\s*(\([^)]+\)|[①-⑳]|\d+[.)]|[ㄱ-ㅎ가-힣][.:)]?)\s+(.+?)\s*$/);
  if (singleLeadingLabel && singleLeadingLabel[2]) {
    accepted.add(String(singleLeadingLabel[2]).trim());
  }

  raw.split(/\s*또는\s*/).forEach((part) => {
    if (part.trim()) accepted.add(part.trim());
  });

  // <보기>의 기호 선택형 단답 문제는 "기호만", "기호+문구", "문구만" 모두 허용
  const symbolChoices = parsePracticalSymbolChoices(problem);
  if (symbolChoices.length > 0) {
    const rawNorm = normalizePracticalAnswer(raw);
    for (const choice of symbolChoices) {
      const labelNorm = normalizePracticalAnswer(choice.label);
      const fullNorm = normalizePracticalAnswer(choice.fullText);
      const altNorm = normalizePracticalAnswer(choice.altText);
      const textNorm = normalizePracticalAnswer(choice.text);
      const isMatch =
        rawNorm === labelNorm ||
        rawNorm === fullNorm ||
        rawNorm === altNorm ||
        rawNorm === textNorm;
      if (!isMatch) continue;
      accepted.add(choice.label);
      accepted.add(choice.fullText);
      accepted.add(choice.altText);
      accepted.add(choice.text);
      accepted.add(`${choice.label}. ${choice.text}`);
      accepted.add(`${choice.label}) ${choice.text}`);
      accepted.add(`${choice.label}: ${choice.text}`);
      break;
    }
  }

  return [...accepted].map(normalizePracticalAnswer).filter(Boolean);
}

function isPracticalAnswerMatch(userAnswer, correctAnswer, problem = null) {
  if (userAnswer == null || userAnswer === UNKNOWN_OPTION) return false;
  const normalizedUser = normalizePracticalAnswer(userAnswer);
  if (!normalizedUser) return false;
  const accepted = buildAcceptedPracticalAnswers(correctAnswer, problem);
  if (accepted.includes(normalizedUser)) return true;

  const practicalType = String(problem?.input_type || '');
  const isExplicitSequenceType =
    practicalType === 'ordered_sequence' || practicalType === 'unordered_symbol_set';
  const seqMetaForProblem =
    (practicalType === 'sequence' || isExplicitSequenceType) ? getSequenceMeta(problem, correctAnswer) : null;

  if (seqMetaForProblem?.mode === 'unordered_symbol_set') {
    const setUser = normalizeUnorderedSymbolSetAnswer(userAnswer);
    if (setUser) {
      const setAccepted = new Set();
      for (const candidate of [String(correctAnswer ?? ''), ...buildAcceptedPracticalAnswers(correctAnswer, problem)]) {
        const normalized = normalizeUnorderedSymbolSetAnswer(candidate);
        if (normalized) setAccepted.add(normalized);
      }
      if (setAccepted.has(setUser)) return true;
    }
  }

  const seqUser = normalizeSequenceLikeAnswer(userAnswer);
  if (seqUser) {
    const seqAccepted = new Set();
    for (const candidate of [String(correctAnswer ?? ''), ...buildAcceptedPracticalAnswers(correctAnswer, problem)]) {
      const normalized = normalizeSequenceLikeAnswer(candidate);
      if (normalized) seqAccepted.add(normalized);
    }
    if (seqAccepted.has(seqUser)) return true;
  }

  const multiUser = normalizeLabeledMultiBlankAnswer(userAnswer);
  if (multiUser) {
    const multiAccepted = new Set();
    for (const candidate of [String(correctAnswer ?? ''), ...buildAcceptedPracticalAnswers(correctAnswer, problem)]) {
      const normalized = normalizeLabeledMultiBlankAnswer(candidate);
      if (normalized) multiAccepted.add(normalized);
    }
    if (multiAccepted.has(multiUser)) return true;
  }

  // 라벨 표기(가/나 vs ①/② vs ㄱ/ㄴ)가 달라도 값의 순서가 같으면 정답 처리
  const multiValuesUser = normalizeLabeledMultiBlankValuesOnly(userAnswer);
  if (multiValuesUser) {
    const multiValuesAccepted = new Set();
    for (const candidate of [String(correctAnswer ?? ''), ...buildAcceptedPracticalAnswers(correctAnswer, problem)]) {
      const normalized = normalizeLabeledMultiBlankValuesOnly(candidate);
      if (normalized) multiValuesAccepted.add(normalized);
    }
    if (multiValuesAccepted.has(multiValuesUser)) return true;
  }

  // multi_blank 필드별 유연 비교: 한글/영문/괄호/콜론/수치 표기 차이 일부 허용
  const parsedUserMulti = parseLabeledMultiBlankValues(userAnswer);
  if (parsedUserMulti) {
    const candidates = [String(correctAnswer ?? ''), ...buildAcceptedPracticalAnswers(correctAnswer, problem)];
    for (const candidate of candidates) {
      const parsedCorrectMulti = parseLabeledMultiBlankValues(candidate);
      if (!parsedCorrectMulti || parsedCorrectMulti.length !== parsedUserMulti.length) continue;
      const allMatched = parsedUserMulti.every((uv, idx) =>
        isEquivalentMultiBlankFieldValue(uv, parsedCorrectMulti[idx])
      );
      if (allMatched) return true;
    }
  }

  // multi_blank 라벨이 명확한 문제는(가/나, ①/②, 1)/2), UI 라벨 기준으로 직접 값 배열 비교
  // 정규식 라벨 추론이 흔들리는 케이스(구분자/문장 조각 포함)에서도 안정적으로 동작하도록 보강한다.
  const knownMultiLabels = getMultiBlankMeta(problem, correctAnswer)?.labels || [];
  if (knownMultiLabels.length >= 2) {
    const userKnownValues = parseLabeledMultiBlankValuesByKnownLabels(userAnswer, knownMultiLabels);
    if (userKnownValues) {
      const candidates = [String(correctAnswer ?? ''), ...buildAcceptedPracticalAnswers(correctAnswer, problem)];
      for (const candidate of candidates) {
        const correctKnownValues = parseLabeledMultiBlankValuesByKnownLabels(candidate, knownMultiLabels);
        if (!correctKnownValues || correctKnownValues.length !== userKnownValues.length) continue;
        const allMatched = userKnownValues.every((uv, idx) =>
          isEquivalentMultiBlankFieldValue(uv, correctKnownValues[idx])
        );
        if (allMatched) return true;
      }
    }
  }

  return false;
}

export default function PracticalQuiz({
  problems,
  session,
  answersMap,
  commentsMap,
  sessionId,
  initialProblemNumber = null,
  shouldResume = false,
  resumeToken = '',
}) {
  const router = useRouter();
  const isReviewOnlySession = session?.reviewOnly ?? true;
  const isPracticalMode = true;
  const [allProblems] = useState(problems);
  const [quizProblems, setQuizProblems] = useState(problems);
  const [isStarted, setIsStarted] = useState(false);
  const [currentProblemIndex, setCurrentProblemIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [accumulatedAnswers, setAccumulatedAnswers] = useState({});
  const [checkedProblems, setCheckedProblems] = useState({});
  const [quizCompleted, setQuizCompleted] = useState(false);
  const [quizResults, setQuizResults] = useState(null);
  const [quizStartedAtMs, setQuizStartedAtMs] = useState(null);
  const [remainingSeconds, setRemainingSeconds] = useState(QUIZ_DURATION_SECONDS);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [enableAnswerCheck, setEnableAnswerCheck] = useState(true);
  const [showExplanationWhenCorrect, setShowExplanationWhenCorrect] = useState(true);
  const [showExplanationWhenIncorrect, setShowExplanationWhenIncorrect] = useState(true);
  const [showUpdateNotice, setShowUpdateNotice] = useState(false);
  const [showReportTipNotice, setShowReportTipNotice] = useState(false);
  const [reportTipCountdown, setReportTipCountdown] = useState(5);
  const [reportReason, setReportReason] = useState('');
  const [reportEtcText, setReportEtcText] = useState('');
  const [multiBlankDraftsByProblem, setMultiBlankDraftsByProblem] = useState({});
  const [reportedProblems, setReportedProblems] = useState({});
  const [showGptHelp, setShowGptHelp] = useState(false);
  const [gptQuestion, setGptQuestion] = useState('');
  const [gptMessages, setGptMessages] = useState([]);
  const [gptChatOpen, setGptChatOpen] = useState(false);
  const [gptLoading, setGptLoading] = useState(false);
  const [gptError, setGptError] = useState('');
  const [gptUsedProblems, setGptUsedProblems] = useState({});
  const [gptConversationsByProblem, setGptConversationsByProblem] = useState({});
  const [gptVoteMap, setGptVoteMap] = useState({});
  const [initialJumpApplied, setInitialJumpApplied] = useState(false);
  const sequenceInputRefs = useRef([]);
  const multiBlankInputRefs = useRef([]);
  const multiBlankDraftsRef = useRef({});
  const gptStateStorageKey = `gpt_objection_state_${sessionId}`;
  const gptVoteStorageKey = `gpt_feedback_votes_${sessionId}`;
  const resumeStorageKey = `${RESUME_STATE_KEY_PREFIX}${sessionId}`;
  const resumeDiscardFlagKey = `${resumeStorageKey}__discard`;

  const clearResumeSnapshot = useCallback(() => {
    try {
      window.localStorage.removeItem(resumeStorageKey);
    } catch {}
  }, [resumeStorageKey]);

  const markResumeDiscardOnRestore = useCallback(() => {
    try {
      window.sessionStorage.setItem(resumeDiscardFlagKey, '1');
    } catch {}
  }, [resumeDiscardFlagKey]);

  const resetProgressStateForFreshStart = useCallback(() => {
    setQuizProblems(problems);
    setIsStarted(false);
    setCurrentProblemIndex(0);
    setAnswers({});
    setAccumulatedAnswers({});
    setCheckedProblems({});
    setQuizCompleted(false);
    setQuizResults(null);
    setQuizStartedAtMs(null);
    setRemainingSeconds(QUIZ_DURATION_SECONDS);
    setMultiBlankDraftsByProblem({});
    multiBlankDraftsRef.current = {};
  }, [problems]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(gptStateStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.usedProblems && typeof parsed.usedProblems === 'object') {
          setGptUsedProblems(parsed.usedProblems);
        }
        if (parsed.conversations && typeof parsed.conversations === 'object') {
          setGptConversationsByProblem(parsed.conversations);
        }
      }
    } catch {}
  }, [gptStateStorageKey]);

  useEffect(() => {
    multiBlankDraftsRef.current = multiBlankDraftsByProblem;
  }, [multiBlankDraftsByProblem]);

  useEffect(() => {
    try {
      const saved = saveGptStateToLocalStorage(gptStateStorageKey, {
        usedProblems: gptUsedProblems,
        conversations: gptConversationsByProblem,
      });
      if (saved?.pruned) {
        if (saved.conversations !== gptConversationsByProblem) setGptConversationsByProblem(saved.conversations);
        if (saved.usedProblems !== gptUsedProblems) setGptUsedProblems(saved.usedProblems);
      }
    } catch {}
  }, [gptConversationsByProblem, gptStateStorageKey, gptUsedProblems]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(gptVoteStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') setGptVoteMap(parsed);
    } catch {}
  }, [gptVoteStorageKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(gptVoteStorageKey, JSON.stringify(gptVoteMap));
    } catch {}
  }, [gptVoteMap, gptVoteStorageKey]);

  useEffect(() => {
    if (!shouldResume) return;
    try {
      const raw = window.localStorage.getItem(resumeStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (resumeToken && String(parsed?.resumeToken || '') !== String(resumeToken)) return;
      if (parsed?.answers && typeof parsed.answers === 'object') {
        setAnswers(parsed.answers);
      }
      if (parsed?.checkedProblems && typeof parsed.checkedProblems === 'object') {
        setCheckedProblems(parsed.checkedProblems);
      }
    } catch {}
  }, [resumeStorageKey, resumeToken, shouldResume]);

  // 뒤로가기(popstate)로 이탈할 때는 이어풀기 스냅샷을 지우고,
  // 브라우저 bfcache로 복원되면 이전 O/X 상태를 초기화한다.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handlePopState = () => {
      clearResumeSnapshot();
      markResumeDiscardOnRestore();
    };

    const handlePageShow = (event) => {
      if (shouldResume) return;
      if (!event?.persisted) return;
      try {
        const shouldDiscard = window.sessionStorage.getItem(resumeDiscardFlagKey) === '1';
        if (!shouldDiscard) return;
        window.sessionStorage.removeItem(resumeDiscardFlagKey);
      } catch {
        return;
      }
      resetProgressStateForFreshStart();
    };

    window.addEventListener('popstate', handlePopState);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [
    clearResumeSnapshot,
    markResumeDiscardOnRestore,
    resetProgressStateForFreshStart,
    resumeDiscardFlagKey,
    shouldResume,
  ]);

  useEffect(() => {
    try {
      const seen = window.localStorage.getItem(UPDATE_NOTICE_KEY);
      if (!seen) setShowUpdateNotice(true);
    } catch {
      setShowUpdateNotice(true);
    }
  }, []);

  useEffect(() => {
    const sid = String(sessionId || '');
    if (
      sid !== 'random' &&
      sid !== '100' &&
      sid !== 'random22' &&
      sid !== 'high-wrong' &&
      sid !== 'high-unknown' &&
      !sid.startsWith('random22-')
    ) return;

    try {
      const day = new Date().toISOString().slice(0, 10);
      const key = `visit_test_${sid}_${day}`;
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, 'seen');
      trackEvent('visit_test', { sessionId: sid, path: `/practical/${sid}` });
    } catch {
      trackEvent('visit_test', { sessionId: sid, path: `/practical/${sid}` });
    }
  }, [sessionId]);

  useEffect(() => {
    if (initialJumpApplied) return;
    if (!initialProblemNumber) return;
    if (!Array.isArray(quizProblems) || quizProblems.length === 0) return;

    const targetIndex = quizProblems.findIndex(
      (p) => Number(p.problem_number) === Number(initialProblemNumber)
    );
    if (targetIndex < 0) {
      setInitialJumpApplied(true);
      return;
    }

    setCurrentProblemIndex(targetIndex);
    if (!isStarted) {
      setQuizStartedAtMs(Date.now());
      setRemainingSeconds(QUIZ_DURATION_SECONDS);
      setIsStarted(true);
      trackEvent('start_exam', { sessionId, path: `/practical/${sessionId}` });
    }
    setInitialJumpApplied(true);
  }, [initialJumpApplied, initialProblemNumber, isStarted, quizProblems, sessionId]);

  useEffect(() => {
    if (!isStarted) return;
    try {
      const seen = window.localStorage.getItem(REPORT_TIP_NOTICE_KEY);
      if (!seen) setShowReportTipNotice(true);
    } catch {
      setShowReportTipNotice(true);
    }
  }, [isStarted]);

  useEffect(() => {
    if (!isStarted) return;
    try {
      const seen = window.localStorage.getItem(SETTINGS_AUTO_OPEN_KEY);
      if (!seen) {
        setIsSettingsOpen(true);
        window.localStorage.setItem(SETTINGS_AUTO_OPEN_KEY, 'seen');
      }
    } catch {}
  }, [isStarted]);

  useEffect(() => {
    if (!showReportTipNotice) return;
    setReportTipCountdown(5);

    const interval = window.setInterval(() => {
      setReportTipCountdown((prev) => (prev > 1 ? prev - 1 : 1));
    }, 1000);

    const timer = window.setTimeout(() => {
      setShowReportTipNotice(false);
      try {
        window.localStorage.setItem(REPORT_TIP_NOTICE_KEY, 'seen');
      } catch {}
    }, 5000);

    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [showReportTipNotice]);

  useEffect(() => {
    if (!isStarted || quizCompleted || !quizStartedAtMs) return;

    const tick = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - quizStartedAtMs) / 1000));
      setRemainingSeconds(Math.max(0, QUIZ_DURATION_SECONDS - elapsed));
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [isStarted, quizCompleted, quizStartedAtMs]);

  // 시험 시작: 상태 초기화 및 시작 이벤트 기록
  const handleStartQuiz = () => {
    if (!shouldResume) {
      setAnswers({});
      setCheckedProblems({});
      try {
        window.localStorage.removeItem(resumeStorageKey);
      } catch {}
    }
    setQuizStartedAtMs(Date.now());
    setRemainingSeconds(QUIZ_DURATION_SECONDS);
    setIsStarted(true);
    trackEvent('start_exam', { sessionId, path: `/practical/${sessionId}`, payload: { mode: 'normal' } });
  };

  // 보기 선택: 현재 문제의 선택값 저장
  const handleSelectOption = (problemNumber, option) => {
    if (checkedProblems[problemNumber]) return;
    setAnswers((prev) => ({ ...prev, [problemNumber]: option }));

    const problem = quizProblems.find((p) => String(p.problem_number) === String(problemNumber));
    if (!problem) return;
    const sourceSessionId = String(problem.originSessionId || sessionId || '');
    const sourceProblemNumber = Number(problem.originProblemNumber || problem.problem_number || 0);
    if (!sourceSessionId || Number.isNaN(sourceProblemNumber) || sourceProblemNumber <= 0) return;

    if (option === UNKNOWN_OPTION) {
      upsertUnknownProblem({
        sourceSessionId,
        sourceProblemNumber,
        sourceKey: String(problem.originSourceKey || ''),
        questionText: String(problem.question_text || ''),
        sectionTitle: String(problem.sectionTitle || ''),
      });
      return;
    }

    removeUnknownProblem(sourceSessionId, sourceProblemNumber);
  };

  // 주관식 입력값 저장
  const handleSubjectiveInput = (problemNumber, value) => {
    if (checkedProblems[problemNumber]) return;
    setAnswers((prev) => ({ ...prev, [problemNumber]: value }));

    if (!value || !String(value).trim()) return;

    const problem = quizProblems.find((p) => String(p.problem_number) === String(problemNumber));
    if (!problem) return;
    const sourceSessionId = String(problem.originSessionId || sessionId || '');
    const sourceProblemNumber = Number(problem.originProblemNumber || problem.problem_number || 0);
    if (!sourceSessionId || Number.isNaN(sourceProblemNumber) || sourceProblemNumber <= 0) return;
    removeUnknownProblem(sourceSessionId, sourceProblemNumber);
  };

  const handleSequenceSlotInput = (problemNumber, slotIndex, rawValue) => {
    if (!sequenceMeta) return;
    const next = [...sequenceDraft];
    const sanitized = sanitizeSequenceToken(rawValue, sequenceMeta.kind);
    next[slotIndex] = sanitized;
    const combined = next.filter(Boolean).join('-');
    handleSubjectiveInput(problemNumber, combined);
    return sanitized;
  };

  // 순서형 입력 UX: 자동 다음칸 이동 / 빈칸 Backspace 시 이전칸 이동+삭제
  const handleSequenceSlotKeyDown = (e, problemNumber, slotIndex) => {
    if (!sequenceMeta) return;
    if (e.nativeEvent?.isComposing) return;

    const currentToken = String(sequenceDraft?.[slotIndex] || '');
    const lastIndex = sequenceDraft.length - 1;

    if (e.key === 'Backspace') {
      if (!currentToken && slotIndex > 0) {
        e.preventDefault();
        handleSequenceSlotInput(problemNumber, slotIndex - 1, '');
        requestAnimationFrame(() => {
          const prev = sequenceInputRefs.current[slotIndex - 1];
          prev?.focus();
          prev?.select?.();
        });
      }
      return;
    }

    // 이미 값이 있는 칸에서 입력 시 현재 칸을 대체하고 다음 칸으로 이동
    if (e.key.length === 1 && currentToken) {
      const sanitized = sanitizeSequenceToken(e.key, sequenceMeta.kind);
      if (!sanitized) return;
      e.preventDefault();
      handleSequenceSlotInput(problemNumber, slotIndex, sanitized);
      requestAnimationFrame(() => {
        const nextIndex = Math.min(slotIndex + 1, lastIndex);
        const nextRef = sequenceInputRefs.current[nextIndex];
        nextRef?.focus();
        nextRef?.select?.();
      });
    }
  };

  // 복합 입력(①/②, ㄱ/ㄴ 등): 라벨별 입력값을 하나의 문자열로 합쳐 저장
  const handleMultiBlankSlotInput = (problemNumber, labels, slotIndex, rawValue) => {
    // 입력 중에는 직렬화된 답안 문자열을 재파싱하지 않고 ref에 유지한 draft를 우선 사용한다.
    // (재파싱 시 구분자 "/"가 다른 칸 값에 섞여 들어가는 현상 방지)
    const currentDrafts = multiBlankDraftsRef.current || {};
    const current =
      Array.isArray(currentDrafts[problemNumber]) && currentDrafts[problemNumber].length === labels.length
        ? [...currentDrafts[problemNumber]]
        : splitMultiBlankDraft(
            answers[problemNumber] === UNKNOWN_OPTION ? '' : answers[problemNumber],
            labels
          );
    current[slotIndex] = String(rawValue ?? '');

    const nextDrafts = { ...currentDrafts, [problemNumber]: current };
    multiBlankDraftsRef.current = nextDrafts;
    setMultiBlankDraftsByProblem(nextDrafts);

    const combined = labels
      .map((label, idx) => ({ label, raw: String(current[idx] || '') }))
      .filter((item) => item.raw.trim())
      // 라벨형 답안은 "가 값 나 값"으로 저장하면 값 내부 조사(가/나/다/라)를 라벨로 오인식할 수 있어
      // 파서가 안정적으로 읽을 수 있는 "가: 값 / 나: 값" 형식으로 직렬화한다.
      .map((item) => `${item.label}: ${item.raw.trim()}`)
      .join(' / ');
    handleSubjectiveInput(problemNumber, combined);
  };

  // 복합 입력칸 UX: 빈칸에서 Backspace 시 이전칸 이동+삭제
  const handleMultiBlankSlotKeyDown = (e, problemNumber, labels, slotIndex, multiBlankDraft) => {
    if (e.nativeEvent?.isComposing) return;
    const currentToken = String(multiBlankDraft?.[slotIndex] || '');
    if (e.key === 'Backspace' && !currentToken && slotIndex > 0) {
      e.preventDefault();
      handleMultiBlankSlotInput(problemNumber, labels, slotIndex - 1, '');
      requestAnimationFrame(() => {
        const prev = multiBlankInputRefs.current[slotIndex - 1];
        prev?.focus();
        prev?.select?.();
      });
    }
  };

  // 시험 제출: 과목별/총점 결과 계산 후 결과 화면으로 전환
  const handleSubmitQuiz = () => {
    const isRetryMode = quizProblems.length !== allProblems.length;
    const mergedAnswers = { ...accumulatedAnswers, ...answers };
    let totalCorrect = 0;
    let currentSetCorrect = 0;
    let unknownCount = 0;
    const currentSetTotal = quizProblems.length;
    const subjectCorrectCounts = isReviewOnlySession ? {} : { 1: 0, 2: 0, 3: 0 };
    const subjectTotalCounts = isReviewOnlySession ? {} : { 1: 0, 2: 0, 3: 0 };

    if (!isReviewOnlySession) {
      quizProblems.forEach((problem) => {
        const problemNum = parseInt(problem.problem_number, 10);
        if (problemNum >= 1 && problemNum <= 20) subjectTotalCounts[1]++;
        else if (problemNum >= 21 && problemNum <= 40) subjectTotalCounts[2]++;
        else if (problemNum >= 41 && problemNum <= 60) subjectTotalCounts[3]++;
      });
    }

    allProblems.forEach((problem) => {
      const problemNum = parseInt(problem.problem_number, 10);
      const userAnswer = mergedAnswers[problem.problem_number];
      const correctAnswer = answersMap[problem.problem_number];
      if (userAnswer === UNKNOWN_OPTION) unknownCount++;

      if (isPracticalAnswerMatch(userAnswer, correctAnswer, problem)) {
        totalCorrect++;
        if (!isReviewOnlySession) {
          if (problemNum >= 1 && problemNum <= 20) subjectCorrectCounts[1]++;
          else if (problemNum >= 21 && problemNum <= 40) subjectCorrectCounts[2]++;
          else if (problemNum >= 41 && problemNum <= 60) subjectCorrectCounts[3]++;
        }
      }
    });

    quizProblems.forEach((problem) => {
      const userAnswer = mergedAnswers[problem.problem_number];
      const correctAnswer = answersMap[problem.problem_number];
      if (isPracticalAnswerMatch(userAnswer, correctAnswer, problem)) currentSetCorrect++;
    });

    const subjectPassFail = isReviewOnlySession
      ? {}
      : {
          1: subjectCorrectCounts[1] >= 8,
          2: subjectCorrectCounts[2] >= 8,
          3: subjectCorrectCounts[3] >= 8,
        };
    const isOverallPass = isReviewOnlySession
      ? totalCorrect === allProblems.length
      : totalCorrect >= 36 && subjectPassFail[1] && subjectPassFail[2] && subjectPassFail[3];
    const elapsedSeconds = quizStartedAtMs
      ? Math.max(0, Math.floor((Date.now() - quizStartedAtMs) / 1000))
      : 0;
    // 현재 제출 세트 기준 문항별 결과(오답률 집계용)
    const problemOutcomes = quizProblems.map((problem) => {
      const problemNum = Number(problem.problem_number);
      const userAnswer = mergedAnswers[problem.problem_number];
      const correctAnswer = answersMap[problem.problem_number];
      return {
        sessionId: String(problem.originSessionId || sessionId || ''),
        problemNumber: Number(problem.originProblemNumber || problemNum || 0),
        localProblemNumber: problemNum,
        selectedAnswer: userAnswer == null ? '' : String(userAnswer),
        correctAnswer: correctAnswer == null ? '' : String(correctAnswer),
        isCorrect: isPracticalAnswerMatch(userAnswer, correctAnswer, problem),
        isUnknown: userAnswer === UNKNOWN_OPTION,
      };
    });

    setAccumulatedAnswers(mergedAnswers);
    trackEvent('finish_exam', {
      sessionId,
      path: `/practical/${sessionId}`,
      payload: {
        totalCorrect,
        wrongCount: allProblems.length - totalCorrect,
        unknownCount,
        subjectCorrectCounts,
        isOverallPass,
        isRetryMode,
        currentSetCorrect,
        currentSetTotal,
        elapsedSeconds,
        completionScope: quizProblems.length,
        completionTotal: allProblems.length,
        reviewOnly: isReviewOnlySession,
        problemOutcomes,
      },
    });
    setQuizResults({
      totalCorrect,
      totalCount: allProblems.length,
      wrongCount: allProblems.length - totalCorrect,
      unknownCount,
      subjectCorrectCounts,
      subjectTotalCounts,
      subjectPassFail,
      isOverallPass,
      isRetryMode,
      currentSetCorrect,
      currentSetTotal,
      elapsedSeconds,
      reviewOnly: isReviewOnlySession,
    });
    setQuizCompleted(true);
    try {
      window.localStorage.removeItem(resumeStorageKey);
    } catch {}
  };

  const currentProblem = quizProblems[currentProblemIndex] ?? null;
  const currentProblemNumber = currentProblem?.problem_number;
  const actualProblemNumber = Number(currentProblem?.originProblemNumber ?? currentProblemNumber ?? 0);
  const practicalInputTypeRaw = String(currentProblem?.input_type || 'single');
  const isExplicitSequenceInputType =
    practicalInputTypeRaw === 'ordered_sequence' || practicalInputTypeRaw === 'unordered_symbol_set';
  const practicalAnswerFormatHint = String(currentProblem?.answer_format_hint || '').trim();
  const correctAnswer = currentProblemNumber && answersMap ? answersMap[currentProblemNumber] : null;
  const practicalSymbolChoices =
    practicalInputTypeRaw === 'single' ? parsePracticalSymbolChoices(currentProblem) : [];
  const hasUnorderedSymbolSetAnswerEvidence =
    practicalInputTypeRaw === 'single' && !!normalizeUnorderedSymbolSetAnswer(correctAnswer);
  const sequenceMetaRawBase =
    (practicalInputTypeRaw === 'sequence' || isExplicitSequenceInputType || hasUnorderedSymbolSetAnswerEvidence)
      ? getSequenceMeta(currentProblem, correctAnswer)
      : null;
  // 일부 실기 문항은 질문 문구 인코딩/문장 형태 때문에 "모두 고르기" 문구 감지가 실패할 수 있다.
  // 이 경우에도 정답이 기호 집합(예: ㄱ, ㄴ)이고 보기 목록이 존재하면 unordered 모드로 강제한다.
  const forceUnorderedSymbolSetByAnswer =
    practicalInputTypeRaw === 'single' &&
    hasUnorderedSymbolSetAnswerEvidence &&
    practicalSymbolChoices.length >= 2;
  const sequenceMetaRaw =
    sequenceMetaRawBase && forceUnorderedSymbolSetByAnswer
      ? { ...sequenceMetaRawBase, mode: 'unordered_symbol_set' }
      : sequenceMetaRawBase;
  // sequence 타입은 과거 자동 분류 오탐(보기의 ㄱ/ㄴ 목록만 보고 sequence로 지정) 케이스가 있어
  // "정답 문자열이 실제로 순서/기호형 답안인지"를 기준으로 런타임에서 다시 판정한다.
  const sequenceHasEvidence =
    !!sequenceMetaRaw &&
    (
      !!normalizeSequenceLikeAnswer(correctAnswer) ||
      !!normalizeUnorderedSymbolSetAnswer(correctAnswer)
    );
  // 단답형(예: RR, Integration Test, HTTP 등)은 어떤 이유로든 sequence로 렌더되면 안 된다.
  const looksLikeSimpleWordAnswer =
    !normalizeSequenceLikeAnswer(correctAnswer) &&
    !normalizeUnorderedSymbolSetAnswer(correctAnswer) &&
    !normalizeLabeledMultiBlankAnswer(correctAnswer) &&
    /^[\p{L}\p{N}\s().,+/-]+$/u.test(String(correctAnswer ?? '').trim());
  const hasExplicitMultiBlankLabelsInAnswer =
    practicalInputTypeRaw === 'single' && getLabeledTokenMatches(String(correctAnswer ?? '')).length >= 2;
  const inferredNamedPairLabels =
    practicalInputTypeRaw === 'single' ? inferNamedPairLabelsFromAnswer(correctAnswer) : [];
  const practicalInputType =
    isExplicitSequenceInputType
      ? 'sequence'
      : practicalInputTypeRaw === 'sequence' && (!sequenceHasEvidence || looksLikeSimpleWordAnswer)
      ? 'single'
      : practicalInputTypeRaw === 'single' &&
          sequenceMetaRaw?.mode === 'unordered_symbol_set' &&
          !!normalizeUnorderedSymbolSetAnswer(correctAnswer)
        ? 'sequence'
      : practicalInputTypeRaw === 'single' && (hasExplicitMultiBlankLabelsInAnswer || inferredNamedPairLabels.length >= 2)
        ? 'multi_blank'
        : practicalInputTypeRaw;
  const sequenceMeta =
    practicalInputType === 'sequence' ? sequenceMetaRaw : null;
  const multiBlankMeta =
    practicalInputType === 'multi_blank' ? getMultiBlankMeta(currentProblem, correctAnswer) : null;
  const practicalInputPlaceholder =
    practicalInputType === 'sequence'
      ? sequenceMeta?.mode === 'unordered_symbol_set'
        ? (practicalAnswerFormatHint || '예: ㄱ, ㄴ')
        : (practicalAnswerFormatHint || '예: ㄴ-ㄷ-ㄱ-ㄹ-ㅁ')
      : practicalInputType === 'multi_blank'
        ? (practicalAnswerFormatHint || '예: ① 값 ② 값')
        : practicalInputType === 'textarea'
          ? '답안을 입력하세요'
          : '정답을 입력하세요';
  const practicalAnswerFormatHintDisplay =
    practicalInputType === 'sequence' && sequenceMeta?.mode === 'unordered_symbol_set'
      ? '예: ㄱ, ㄴ'
      : practicalAnswerFormatHint;
  const selectedAnswer = currentProblemNumber ? answers[currentProblemNumber] : null;
  const selectedPracticalChoice =
    practicalInputType === 'single' && practicalSymbolChoices.length > 0
      ? practicalSymbolChoices.find((c) =>
          isPracticalAnswerMatch(selectedAnswer, c.fullText, { ...currentProblem, accepted_answers: [c.label, c.altText, c.text] })
        ) || null
      : null;
  const getOptionList = (problem) => {
    if (isPracticalMode) return [UNKNOWN_OPTION];
    const base = Array.isArray(problem?.options) ? problem.options : [];
    return [...base, UNKNOWN_OPTION];
  };
  const getGptProblemKey = (problem, answerValue = '') => {
    if (!problem) return '';
    const srcSession = String(problem.originSessionId || sessionId || 'unknown');
    const srcNumber = String(problem.originProblemNumber || problem.problem_number || '0');
    const selected = String(answerValue || '').trim();
    return `${srcSession}:${srcNumber}::selected:${selected}`;
  };
  const isChecked = currentProblemNumber ? checkedProblems[currentProblemNumber] : false;
  const sequenceDraft =
    practicalInputType === 'sequence' && sequenceMeta
      ? splitSequenceDraft(selectedAnswer === UNKNOWN_OPTION ? '' : selectedAnswer, sequenceMeta.count)
      : [];
  const multiBlankDraft =
    practicalInputType === 'multi_blank' && multiBlankMeta
      ? (Array.isArray(multiBlankDraftsByProblem[currentProblemNumber])
          ? multiBlankDraftsByProblem[currentProblemNumber]
          : splitMultiBlankDraft(selectedAnswer === UNKNOWN_OPTION ? '' : selectedAnswer, multiBlankMeta.labels))
      : [];
  const isSequenceComplete =
    practicalInputType === 'sequence'
      ? sequenceMeta?.mode === 'unordered_symbol_set'
        ? sequenceDraft.some((token) => String(token || '').trim().length > 0)
        : sequenceDraft.length > 0 && sequenceDraft.every((token) => String(token || '').trim().length > 0)
      : false;
  const isMultiBlankComplete =
    practicalInputType === 'multi_blank'
      ? multiBlankDraft.length > 0 && multiBlankDraft.some((token) => String(token || '').trim().length > 0)
      : false;
  const hasSelectedAnswer =
    selectedAnswer === UNKNOWN_OPTION ||
    (practicalInputType === 'sequence'
      ? isSequenceComplete
      : practicalInputType === 'multi_blank'
        ? isMultiBlankComplete
      : String(selectedAnswer ?? '').trim().length > 0);
  const currentGptProblemKey = getGptProblemKey(currentProblem, selectedAnswer);
  const isCorrect = isPracticalAnswerMatch(selectedAnswer, correctAnswer, currentProblem);
  const isExamLikePreset =
    !enableAnswerCheck && !showExplanationWhenCorrect && !showExplanationWhenIncorrect;
  const isDirectProgressMode = !enableAnswerCheck;
  const correctAnswerIndex =
    currentProblem && Array.isArray(currentProblem.options)
      ? currentProblem.options.indexOf(correctAnswer)
      : -1;
  const showResult = isChecked;
  const shouldShowExplanation =
    showResult &&
    ((isCorrect && showExplanationWhenCorrect) || (!isCorrect && showExplanationWhenIncorrect));
  const explanationText =
    currentProblemNumber && commentsMap ? commentsMap[currentProblemNumber] : '';

  useEffect(() => {
    if (!isStarted || quizCompleted || !currentProblemNumber) return;
    try {
      window.localStorage.setItem(
        resumeStorageKey,
        JSON.stringify({
          problemNumber: Number(currentProblemNumber),
          answers,
          checkedProblems,
          resumeToken: String(resumeToken || ''),
          updatedAt: Date.now(),
        })
      );
    } catch {}
  }, [answers, checkedProblems, currentProblemNumber, isStarted, quizCompleted, resumeStorageKey, resumeToken]);

  const formatExplanation = (text) => {
    if (!text) return '';

    return text
      .replace(/\r\n?/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\u00A0/g, ' ')
      // 헤더/구분선 앞뒤 정리
      .replace(/\s*(={3,})\s*/g, '\n\n')
      // 숫자 목록(1) / 1. / 1) 형태 줄바꿈
      .replace(/\s+(\d+[\)\.]\s)/g, '\n')
      // 중점 불릿(·) 줄바꿈 (공백 유무와 무관하게 처리)
      .replace(/\s*·\s*/g, '\n· ')
      // 불릿(-, *, •) 줄바꿈
      .replace(/\s+([\-\*•]\s+)/g, '\n')
      // 문장 단위 줄바꿈(. ! ? 뒤 공백 기준)
      .replace(/([.!?])\s+(?=[^\d])/g, '$1\n')
      // 콜론 라벨은 줄 유지
      .replace(/\s*:\s*/g, ': ')
      // 과도한 공백/빈줄 정리
      .replace(/[\t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };

  useEffect(() => {
    if (!isStarted || quizCompleted) return;

    const onKeyDown = (e) => {
      const target = e.target;
      const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
      const isEditable = tag === 'input' || tag === 'textarea' || (target && target.isContentEditable);
      if (isEditable) return;

      if (!isPracticalMode && ['1', '2', '3', '4', '5'].includes(e.key)) {
        if (!currentProblem || isChecked) return;
        const idx = Number(e.key) - 1;
        const option = getOptionList(currentProblem)[idx];
        if (!option) return;
        e.preventDefault();
        handleSelectOption(currentProblem.problem_number, option);
        return;
      }

      if (!isPracticalMode && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        if (!currentProblem || isChecked) return;
        const options = getOptionList(currentProblem);
        if (options.length === 0) return;

        const currentIdx = selectedAnswer ? options.indexOf(selectedAnswer) : -1;
        const nextIdx =
          e.key === 'ArrowDown'
            ? (currentIdx + 1 + options.length) % options.length
            : (currentIdx - 1 + options.length) % options.length;
        const nextOption = options[nextIdx];
        if (!nextOption) return;

        e.preventDefault();
        handleSelectOption(currentProblem.problem_number, nextOption);
        return;
      }

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isDirectProgressMode) {
          if (!hasSelectedAnswer) return;
          if (currentProblemIndex === quizProblems.length - 1) {
            handleSubmitQuiz();
          } else {
            setCurrentProblemIndex(currentProblemIndex + 1);
          }
          return;
        }
        if (!isChecked) {
          if (hasSelectedAnswer) handleNextClick();
          return;
        }

        if (currentProblemIndex === quizProblems.length - 1) {
          handleSubmitQuiz();
        } else {
          handleNextClick();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isStarted,
    quizCompleted,
    enableAnswerCheck,
    isChecked,
    selectedAnswer,
    currentProblem,
    currentProblemIndex,
    quizProblems.length,
  ]);

  // 정답 확인 또는 다음 문제 이동(모드에 따라 동작 분기)
  const handleNextClick = () => {
    if (!currentProblem) return;
    if (isDirectProgressMode) {
      if (!hasSelectedAnswer) {
        alert(T.needSelect);
        return;
      }
      if (currentProblemIndex < quizProblems.length - 1) {
        setCurrentProblemIndex(currentProblemIndex + 1);
      }
      return;
    }
    if (!isChecked) {
      if (!hasSelectedAnswer) {
        alert(T.needSelect);
        return;
      }
      setCheckedProblems((prev) => ({ ...prev, [currentProblemNumber]: true }));
      return;
    }
    if (currentProblemIndex < quizProblems.length - 1) {
      setCurrentProblemIndex(currentProblemIndex + 1);
    }
  };

  // 문제 신고: 선택 사유(기타 포함)를 서버로 전송
  const handleReportProblem = async () => {
    if (!currentProblem || !reportReason) return;
    if (reportReason === '기타' && !reportEtcText.trim()) {
      alert('기타 사유를 입력해주세요.');
      return;
    }
    const finalReason = reportReason === '기타' ? `기타: ${reportEtcText.trim()}` : reportReason;
    const hasOrigin =
      currentProblem.originSessionId !== undefined &&
      currentProblem.originProblemNumber !== undefined;
    await trackEvent('report_problem', {
      sessionId,
      path: `/practical/${sessionId}`,
      payload: {
        problemNumber: currentProblem.problem_number,
        reason: finalReason,
        questionText: String(currentProblem.question_text || '').slice(0, 150),
        ...(hasOrigin
          ? {
              originSessionId: String(currentProblem.originSessionId),
              originProblemNumber: Number(currentProblem.originProblemNumber),
              originSourceKey: String(currentProblem.originSourceKey || ''),
            }
          : {}),
      },
    });
    alert('신고가 접수되었습니다.');
    setReportedProblems((prev) => ({ ...prev, [currentProblem.problem_number]: true }));
    setReportReason('');
    setReportEtcText('');
  };

  // GPT 이의신청 질문 전송: 캐시 우선 조회 + 응답 저장
  const handleAskGptObjection = async () => {
    if (!currentProblem) return;
    const problemKey = getGptProblemKey(currentProblem, selectedAnswer);
    const userTurns = gptMessages.filter((m) => m.role === 'user').length;
    if (userTurns >= GPT_MAX_TURNS) {
      setGptError(`대화는 최대 ${GPT_MAX_TURNS}번까지 가능합니다.`);
      return;
    }
    if (userTurns === 0) {
      setGptUsedProblems((prev) => ({ ...prev, [problemKey]: true }));
    }

    const userText = (gptQuestion || '이게 왜 답인지 모르겠음 난 해설보고도 이해안감').trim();
    if (!userText) return;

    const nextMessages = [...gptMessages, { role: 'user', content: userText }];
    setGptMessages(nextMessages);
    setGptConversationsByProblem((prev) => {
      const next = { ...prev };
      delete next[problemKey];
      next[problemKey] = nextMessages;
      return next;
    });
    setGptQuestion('');

    try {
      setGptLoading(true);
      setGptError('');

      const res = await fetch('/api/gpt/objection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceSessionId: currentProblem.originSessionId || sessionId,
          sourceProblemNumber: currentProblem.originProblemNumber || currentProblem.problem_number,
          questionText: currentProblem.question_text || '',
          options: Array.isArray(currentProblem.options) ? currentProblem.options : [],
          selectedAnswer: selectedAnswer || '',
          correctAnswer: correctAnswer || '',
          explanationText: explanationText || '',
          history: nextMessages,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.message || 'GPT 요청 실패');
      }

      const assistantText = String(data.answer || '답변이 비어 있습니다.');
      const finalMessages = [
        ...nextMessages,
        {
          role: 'assistant',
          content: assistantText,
          cached: !!data.cached,
          cacheKey: String(data?.cacheKey || ''),
          feedback: {
            like: Number(data?.feedback?.like || 0),
            dislike: Number(data?.feedback?.dislike || 0),
          },
        },
      ];
      setGptMessages(finalMessages);
      setGptConversationsByProblem((prev) => {
        const next = { ...prev };
        delete next[problemKey];
        next[problemKey] = finalMessages;
        return next;
      });
      setGptChatOpen(true);
    } catch (e) {
      setGptError(String(e?.message || e));
    } finally {
      setGptLoading(false);
    }
  };

  useEffect(() => {
    setReportReason('');
    setReportEtcText('');
    setShowGptHelp(false);
    setGptQuestion('');
    const savedMessages =
      currentGptProblemKey && Array.isArray(gptConversationsByProblem[currentGptProblemKey])
        ? gptConversationsByProblem[currentGptProblemKey]
        : [];
    setGptMessages(savedMessages);
    setGptChatOpen(false);
    setGptError('');
    setGptLoading(false);
  }, [currentGptProblemKey]);

  const goToPreviousProblem = () => {
    if (currentProblemIndex > 0) setCurrentProblemIndex(currentProblemIndex - 1);
  };

  const goToProblem = (index) => {
    if (index >= 0 && index < quizProblems.length) setCurrentProblemIndex(index);
  };

  // 오답 재풀이: 틀린 문제만 추려 새 시험 상태로 재시작
  const handleRetryWrongProblems = () => {
    const mergedAnswers = { ...accumulatedAnswers, ...answers };
    const wrongProblems = allProblems.filter((p) => mergedAnswers[p.problem_number] !== answersMap[p.problem_number]);
    if (wrongProblems.length === 0) return;

    setAccumulatedAnswers(mergedAnswers);
    setQuizProblems(wrongProblems);
    setAnswers({});
    setCheckedProblems({});
    setCurrentProblemIndex(0);
    setQuizCompleted(false);
    setQuizResults(null);
    setQuizStartedAtMs(null);
    setRemainingSeconds(QUIZ_DURATION_SECONDS);
  };

  // 모르겠어요 재풀이: 전역 기준이 아닌 현재 시험에서 UNKNOWN 선택한 문항만 재시작
  const handleRetryUnknownProblems = () => {
    const mergedAnswers = { ...accumulatedAnswers, ...answers };
    const unknownProblems = allProblems.filter((p) => mergedAnswers[p.problem_number] === UNKNOWN_OPTION);
    if (unknownProblems.length === 0) return;

    setAccumulatedAnswers(mergedAnswers);
    setQuizProblems(unknownProblems);
    setAnswers({});
    setCheckedProblems({});
    setCurrentProblemIndex(0);
    setQuizCompleted(false);
    setQuizResults(null);
    setQuizStartedAtMs(null);
    setRemainingSeconds(QUIZ_DURATION_SECONDS);
  };

  // 중도 종료: 확인 후 현재까지 답안 기준으로 결과 처리
  const handleEndQuiz = () => {
    const shouldEnd = window.confirm('\uC885\uB8CC\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?');
    if (!shouldEnd) return;

    const mergedAnswers = { ...accumulatedAnswers, ...answers };
    let totalCorrect = 0;
    allProblems.forEach((problem) => {
      const userAnswer = mergedAnswers[problem.problem_number];
      const correctAnswer = answersMap[problem.problem_number];
      if (isPracticalAnswerMatch(userAnswer, correctAnswer, problem)) totalCorrect++;
    });

    const solvedCount = allProblems.filter((problem) => mergedAnswers[problem.problem_number] !== undefined).length;
    const totalCount = allProblems.length;
    alert(
      `\uD604\uC7AC \uC810\uC218: ${totalCorrect} / ${totalCount}\n` +
      `\uD480\uC774 \uC644\uB8CC: ${solvedCount} / ${totalCount}`
    );
    clearResumeSnapshot();
    markResumeDiscardOnRestore();
    router.push('/practical');
  };

  const getProblemStatus = (problem) => {
    const num = problem.problem_number;
    if (isDirectProgressMode && answers[num] !== undefined && !checkedProblems[num]) return '●';
    if (!checkedProblems[num]) return '?';
    return isPracticalAnswerMatch(answers[num], answersMap[num], problem) ? 'O' : 'X';
  };

  if (!currentProblem) {
    return <div>{T.loadFail}</div>;
  }
  const isGptUsedForCurrent = !!gptUsedProblems[currentGptProblemKey];
  const savedGptMessagesForCurrent = Array.isArray(gptConversationsByProblem[currentGptProblemKey])
    ? gptConversationsByProblem[currentGptProblemKey]
    : [];
  const hasSavedGptForCurrent = savedGptMessagesForCurrent.length > 0;
  const hasAssistantReplyForCurrent = savedGptMessagesForCurrent.some((m) => m?.role === 'assistant');

  // GPT 해설 보기 버튼: 캐시 대화가 있으면 바로 모달, 없으면 질문 입력창 표시
  const handleOpenGptView = () => {
    if (hasAssistantReplyForCurrent) {
      if (gptMessages.length === 0) {
        setGptMessages(savedGptMessagesForCurrent);
      }
      setShowGptHelp(false);
      setGptChatOpen(true);
      return;
    }
    setShowGptHelp(true);
  };

  // GPT 도움 패널에서 대화 모달 열기(저장된 대화 복원 포함)
  const handleOpenGptChatFromHelp = () => {
    if (gptMessages.length === 0 && hasSavedGptForCurrent) {
      setGptMessages(savedGptMessagesForCurrent);
    }
    setGptChatOpen(true);
  };

  // GPT 답변 평가(좋아요/싫어요): 캐시 키 기준 1회만 저장
  const handleVoteGpt = async (msgIndex, vote) => {
    const msg = gptMessages[msgIndex];
    if (!msg || msg.role !== 'assistant') return;
    const cacheKey = String(msg.cacheKey || '').trim();
    if (!cacheKey) return;
    if (gptVoteMap[cacheKey]) return;

    try {
      const res = await fetch('/api/gpt/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cacheKey, vote }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.message || '피드백 저장 실패');

      const nextMessages = gptMessages.map((m, i) => {
        if (i !== msgIndex) return m;
        return {
          ...m,
          feedback: {
            like: Number(data?.feedback?.like || 0),
            dislike: Number(data?.feedback?.dislike || 0),
          },
        };
      });
      setGptMessages(nextMessages);
      setGptConversationsByProblem((prev) => {
        const next = { ...prev };
        delete next[currentGptProblemKey];
        next[currentGptProblemKey] = nextMessages;
        return next;
      });
      setGptVoteMap((prev) => ({ ...prev, [cacheKey]: vote }));
    } catch (e) {
      setGptError(String(e?.message || e));
    }
  };

  const getStatusClass = (status) => {
    if (status === 'O') return 'bg-green-100 text-green-700 border-green-300';
    if (status === 'X') return 'bg-red-100 text-red-700 border-red-300';
    if (status === '●') return 'bg-blue-100 text-blue-700 border-blue-300';
    return 'bg-gray-100 text-gray-700 border-gray-300';
  };
  const timerMinutes = String(Math.floor(remainingSeconds / 60)).padStart(2, '0');
  const timerSeconds = String(Math.floor(remainingSeconds % 60)).padStart(2, '0');

  const parseBookPriceVisual = (text) => {
    const raw = String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\u00A0/g, ' ')
      .trim();

    if (!/SELECT\s+가격\s+FROM\s+도서가격/i.test(raw)) return null;
    if (!/운영체제/.test(raw)) return null;

    const qIdx = raw.indexOf('?');
    const stem = qIdx >= 0 ? raw.slice(0, qIdx + 1).trim() : '다음 질의문 실행의 결과는?';

    const sqlMatch = raw.match(/SELECT\s+가격\s+FROM\s+도서가격[\s\S]*?\);/i);
    const sql = (sqlMatch?.[0] || "SELECT 가격 FROM 도서가격 WHERE 책번호 = (SELECT 책번호 FROM 도서 WHERE 책명 = '운영체제');")
      .replace(/\s+/g, ' ')
      .replace(/\bFROM\b/ig, '\nFROM')
      .replace(/\bWHERE\b/ig, '\nWHERE')
      .trim();

    return {
      stem,
      sql,
      left: {
        title: '도서',
        headers: ['책번호', '책명'],
        rows: [
          ['1111', '운영체제'],
          ['2222', '세계지도'],
          ['3333', '생활영어'],
        ],
      },
      right: {
        title: '도서가격',
        headers: ['책번호', '가격'],
        rows: [
          ['1111', '15000'],
          ['2222', '23000'],
          ['3333', '7000'],
          ['4444', '5000'],
        ],
      },
    };
  };

  const parseRelationDegreeVisual = (text) => {
    const raw = String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const hasHeader =
      /학번\(SNO\)/.test(raw) &&
      /이름\(SNAME\)/.test(raw) &&
      /학년\(YEAR\)/.test(raw) &&
      /학과\(DEPT\)/.test(raw);
    const hasStem = /릴레이션의 차수는\?/.test(raw);
    if (!hasHeader || !hasStem) return null;

    const qIdx = raw.indexOf('?');
    const stem = qIdx >= 0 ? raw.slice(0, qIdx + 1).trim() : raw;

    // 자주 출제되는 원본 표(학번/이름/학년/학과)
    return {
      stem,
      headers: ['학번(SNO)', '이름(SNAME)', '학년(YEAR)', '학과(DEPT)'],
      rows: [
        ['100', '홍길동', '4', '전기'],
        ['200', '임꺽정', '1', '컴퓨터'],
        ['300', '이몽룡', '2', '전자'],
        ['400', '강감찬', '4', '제어계측'],
        ['500', '김유신', '3', '컴퓨터'],
      ],
    };
  };

  const parseTradeMaxVisual = (text) => {
    const raw = String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!/<거래내역>/i.test(raw)) return null;
    if (!/SELECT\s+상호\s+FROM\s+거래내역\s+WHERE\s+금액\s+IN/i.test(raw)) return null;

    const qIdx = raw.indexOf('?');
    const stem = qIdx >= 0 ? raw.slice(0, qIdx + 1).trim() : '다음 SQL의 실행 결과로 옳은 것은?';

    const sqlMatch = raw.match(/SELECT\s+상호\s+FROM\s+거래내역[\s\S]*?;/i);
    const sql = (sqlMatch?.[0] || 'SELECT 상호 FROM 거래내역 WHERE 금액 IN (SELECT MAX(금액) FROM 거래내역);')
      .replace(/\s+/g, ' ')
      .replace(/\bFROM\b/ig, '\nFROM')
      .replace(/\bWHERE\b/ig, '\nWHERE')
      .trim();

    return {
      stem,
      sql,
      headers: ['상호', '금액'],
      rows: [
        ['대명금속', '255,000'],
        ['정금강업', '900,000'],
        ['효신산업', '600,000'],
        ['율촌화학', '220,000'],
        ['한국제지', '200,000'],
        ['한국화이바', '795,000'],
      ],
    };
  };

  const bookPriceVisual = parseBookPriceVisual(currentProblem?.question_text);
  const relationDegreeVisual = parseRelationDegreeVisual(currentProblem?.question_text);
  const tradeMaxVisual = parseTradeMaxVisual(currentProblem?.question_text);
  const showTree44 =
    actualProblemNumber === 44 &&
    /이진 트리|binary tree|트리/i.test(String(currentProblem?.question_text || ''));
  const showTree51 =
    actualProblemNumber === 51 &&
    /다음 트리|트리를 전위 순서|전위 순회|트리/i.test(String(currentProblem?.question_text || ''));
  const showTree56 =
    actualProblemNumber === 56 &&
    /다음 그림에서 트리|터미널 노드|Degree|트리/i.test(String(currentProblem?.question_text || ''));
  const showTree46 =
    actualProblemNumber === 46 &&
    /이진 트리|전위|preorder/i.test(String(currentProblem?.question_text || ''));
  const showFan36 =
    actualProblemNumber === 36 &&
    /fan-in|fan-out/i.test(String(currentProblem?.question_text || ''));
  const showGraph43 =
    actualProblemNumber === 43 &&
    /그래프|간선/.test(String(currentProblem?.question_text || ''));
  const showMemory14 =
    actualProblemNumber === 14 &&
    /(5K|10K|15K|20K|3K|11K|7K|메모리|버디)/i.test(String(currentProblem?.question_text || ''));
  const showTcpHeader14 =
    actualProblemNumber === 14 &&
    /TCP\s*헤더|Sequence Number|Acknowledgment Number/i.test(
      `${String(currentProblem?.question_text || '')} ${String(currentProblem?.examples || '')}`
    );
  const showOutputFrame16 =
    actualProblemNumber === 16 &&
    /파란색 빈칸|출력결과/i.test(String(currentProblem?.question_text || ''));
  const showPromptFigure = (() => {
    const qText = String(currentProblem?.question_text || '');
    const opts = Array.isArray(currentProblem?.options) ? currentProblem.options : [];
    const hasPromptOption = opts.some((opt) => /prompt\s*\(|alert\s*\(|title|default/i.test(String(opt || '')));
    if (!hasPromptOption) return false;
    // 본문/보기에 키워드가 있거나, JavaScript 창(대화상자) 문제면 도식 표시
    return /이 페이지 내용|prompt|title|default|JavaScript|창을 띄우기|대화상자/i.test(qText) || actualProblemNumber === 22;
  })();

  const parseQuestionCodeBlock = (text) => {
    const raw = String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\\n/g, '\n')
      .trim();

    // 코드형 문항(HTML/C/JS/Java/SQL)을 본문과 코드 블록으로 분리한다.
    const markerRegex =
      /(<html>|#include\b|public\s+class\b|SELECT\b|<script\b|\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\bdo\s*\{)/i;
    const marker = markerRegex.exec(raw);
    if (!marker) return { stem: raw, code: null };

    const idx = marker.index;
    const stem = raw.slice(0, idx).trim();
    const code = raw.slice(idx).trim();
    return { stem: stem || raw, code: code || null };
  };

  const normalizeKnownCorruptedQuestion = (text, problemNumber, sessionId) => {
    const raw = String(text || '');
    const sid = String(sessionId || '').toLowerCase();

    // 2024년 1회 26번: 데이터가 깨져 '?'로 치환된 경우 화면에서 안전 보정
    if (
      problemNumber === 26 &&
      (sid.includes('2024') || sid.includes('first')) &&
      /javascript/i.test(raw) &&
      /\?{3,}/.test(raw)
    ) {
      return '다음은 1000까지의 7의 배수를 모두 합하는 JavaScript 코드이다. 괄호(㉠, ㉡)에 들어갈 알맞은 예약어는? ……생략… <script> var r = 0, i = 0; ( ㉠ ) { i = i + 1; if (i%7 == 0) { r = r + i; } } ( ㉡ ) (i < 1000); console.log(r); </script> ……생략…';
    }

    return raw;
  };

  const formatCodeForDisplay = (code) => {
    const raw = String(code || '').replace(/\r\n?/g, '\n').trim();
    if (!raw) return raw;

    // HTML 계열 문항은 한 줄로 들어오는 경우가 많아 가독성용 개행/들여쓰기를 적용한다.
    if (/^<html>|<body>|<form|<table|<script/i.test(raw)) {
      let s = raw.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      s = s.replace(/>\s*</g, '>\n<');
      s = s
        .replace(/<(p|tr|td|th|li|option)\b/gi, '\n<$1')
        .replace(/\n{2,}/g, '\n')
        .trim();

      const lines = s.split('\n').map((line) => line.trim()).filter(Boolean);
      let depth = 0;
      const out = [];
      for (const line of lines) {
        const isClosing = /^<\//.test(line);
        if (isClosing) depth = Math.max(0, depth - 1);
        out.push(`${'  '.repeat(depth)}${line}`);
        const isOpening =
          /^<[^!/][^>]*>$/.test(line) &&
          !/\/>$/.test(line) &&
          !/^<(input|br|hr|img|meta|link)\b/i.test(line) &&
          !/^<.*<\/.*>$/.test(line);
        if (isOpening) depth += 1;
      }
      return out.join('\n');
    }

    return raw;
  };

  const isCodeLikeText = (text) => {
    const raw = String(text || '').trim();
    if (!raw) return false;
    return /(<html>|#include\b|public\s+class\b|SELECT\b|<script\b|\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\bdo\s*\{|=>|;\s*$)/i.test(raw);
  };

  const isFramesetChoiceQuestion = (() => {
    const q = String(currentProblem?.question_text || '');
    const ex = String(currentProblem?.examples || '');
    return (
      actualProblemNumber === 28 &&
      /frameset/i.test(q) &&
      /<FRAMESET/i.test(ex) &&
      /cols=/i.test(ex) &&
      /rows=/i.test(ex)
    );
  })();

  const FramesetOptionFigure = ({ idx }) => {
    const w = 74;
    const h = 74;
    const stroke = '#4b5563';
    const halfW = w / 2;
    const halfH = h / 2;

    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`frameset option ${idx + 1}`}>
        <rect x="1" y="1" width={w - 2} height={h - 2} fill="#fff" stroke={stroke} strokeWidth="2" />
        {idx === 0 && (
          <>
            <line x1={halfW} y1="1" x2={halfW} y2={h - 1} stroke={stroke} strokeWidth="2" />
            <line x1={halfW} y1={halfH} x2={w - 1} y2={halfH} stroke={stroke} strokeWidth="2" />
          </>
        )}
        {idx === 1 && (
          <>
            <line x1={halfW} y1="1" x2={halfW} y2={h - 1} stroke={stroke} strokeWidth="2" />
            <line x1="1" y1={halfH} x2={halfW} y2={halfH} stroke={stroke} strokeWidth="2" />
          </>
        )}
        {idx === 2 && (
          <>
            <line x1="1" y1={halfH} x2={w - 1} y2={halfH} stroke={stroke} strokeWidth="2" />
            <line x1={halfW} y1="1" x2={halfW} y2={halfH} stroke={stroke} strokeWidth="2" />
          </>
        )}
        {idx === 3 && (
          <>
            <line x1="1" y1={halfH} x2={w - 1} y2={halfH} stroke={stroke} strokeWidth="2" />
            <line x1={halfW} y1={halfH} x2={halfW} y2={h - 1} stroke={stroke} strokeWidth="2" />
          </>
        )}
      </svg>
    );
  };

  const safeQuestionText = normalizeKnownCorruptedQuestion(
    currentProblem?.question_text,
    actualProblemNumber,
    currentProblem?.originSessionId || session?.id || sessionId
  );
  const rawQuestionText = bookPriceVisual
    ? bookPriceVisual.stem
    : relationDegreeVisual
      ? relationDegreeVisual.stem
      : tradeMaxVisual
        ? tradeMaxVisual.stem
      : safeQuestionText;
  const { stem: questionTitle, code: questionCodeBlock } = parseQuestionCodeBlock(rawQuestionText);

  const formatQuestionTitle = (text) => {
    const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!raw) return raw;
    if (raw.includes('\n')) return raw;

    const qIdx = raw.indexOf('?');
    if (qIdx < 0 || qIdx === raw.length - 1) return raw;

    const head = raw.slice(0, qIdx + 1).trim();
    const tail = raw.slice(qIdx + 1).trim();
    return tail ? `${head}\n${tail}` : head;
  };

  const TreeFigure46 = () => (
    <div className="mb-6 inline-block rounded-md border border-gray-300 bg-white p-3">
      <svg width="300" height="140" viewBox="0 0 300 140" role="img" aria-label="이진 트리 다이어그램">
        <g stroke="#444" strokeWidth="2" fill="none">
          <line x1="150" y1="20" x2="95" y2="55" />
          <line x1="150" y1="20" x2="205" y2="55" />
          <line x1="95" y1="55" x2="60" y2="92" />
          <line x1="205" y1="55" x2="170" y2="92" />
          <line x1="205" y1="55" x2="240" y2="92" />
        </g>
        {[
          ['A', 150, 20],
          ['B', 95, 55],
          ['C', 205, 55],
          ['D', 60, 92],
          ['E', 170, 92],
          ['F', 240, 92],
        ].map(([label, x, y]) => (
          <g key={label} transform={`translate(${x},${y})`}>
            <circle r="14" fill="#fff" stroke="#444" strokeWidth="2" />
            <text
              x="0"
              y="1"
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="13"
              fontWeight="700"
              fill="#111"
            >
              {label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );

  const TreeFigure44 = () => (
    <div className="mb-6 inline-block rounded-md border border-gray-300 bg-white p-3">
      <svg width="320" height="180" viewBox="0 0 320 180" role="img" aria-label="트리 다이어그램">
        <g stroke="#444" strokeWidth="2" fill="none">
          <line x1="160" y1="20" x2="105" y2="55" />
          <line x1="160" y1="20" x2="215" y2="55" />
          <line x1="105" y1="55" x2="70" y2="92" />
          <line x1="215" y1="55" x2="175" y2="92" />
          <line x1="215" y1="55" x2="250" y2="92" />
          <line x1="175" y1="92" x2="140" y2="130" />
          <line x1="175" y1="92" x2="210" y2="130" />
        </g>
        {[
          ['A', 160, 20],
          ['B', 105, 55],
          ['C', 215, 55],
          ['D', 70, 92],
          ['E', 175, 92],
          ['F', 250, 92],
          ['G', 140, 130],
          ['H', 210, 130],
        ].map(([label, x, y]) => (
          <g key={label} transform={`translate(${x},${y})`}>
            <circle r="14" fill="#fff" stroke="#444" strokeWidth="2" />
            <text
              x="0"
              y="1"
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="13"
              fontWeight="700"
              fill="#111"
            >
              {label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );

  const TreeFigure51 = () => (
    <div className="mb-6 inline-block rounded-md border border-gray-300 bg-white p-3">
      <svg width="300" height="150" viewBox="0 0 300 150" role="img" aria-label="트리 다이어그램">
        <g stroke="#444" strokeWidth="2" fill="none">
          <line x1="150" y1="24" x2="95" y2="62" />
          <line x1="150" y1="24" x2="205" y2="62" />
          <line x1="95" y1="62" x2="60" y2="100" />
          <line x1="205" y1="62" x2="150" y2="100" />
          <line x1="205" y1="62" x2="240" y2="100" />
        </g>
        {[
          ['A', 150, 24],
          ['B', 95, 62],
          ['C', 205, 62],
          ['D', 60, 100],
          ['E', 150, 100],
          ['F', 240, 100],
        ].map(([label, x, y]) => (
          <g key={label} transform={`translate(${x},${y})`}>
            <circle r="14" fill="#fff" stroke="#444" strokeWidth="2" />
            <text x="0" y="1" textAnchor="middle" dominantBaseline="middle" fontSize="13" fontWeight="700" fill="#111">
              {label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );

  const TreeFigure56 = () => (
    <div className="mb-6 inline-block rounded-md border border-gray-300 bg-white p-3">
      <svg width="300" height="180" viewBox="0 0 300 180" role="img" aria-label="트리 다이어그램">
        <g stroke="#444" strokeWidth="2" fill="none">
          <line x1="150" y1="24" x2="95" y2="62" />
          <line x1="150" y1="24" x2="205" y2="62" />
          <line x1="95" y1="62" x2="60" y2="100" />
          <line x1="205" y1="62" x2="150" y2="100" />
          <line x1="205" y1="62" x2="240" y2="100" />
          <line x1="150" y1="100" x2="120" y2="138" />
          <line x1="150" y1="100" x2="180" y2="138" />
        </g>
        {[
          ['A', 150, 24],
          ['B', 95, 62],
          ['C', 205, 62],
          ['D', 60, 100],
          ['E', 150, 100],
          ['F', 240, 100],
          ['G', 120, 138],
          ['H', 180, 138],
        ].map(([label, x, y]) => (
          <g key={label} transform={`translate(${x},${y})`}>
            <circle r="14" fill="#fff" stroke="#444" strokeWidth="2" />
            <text x="0" y="1" textAnchor="middle" dominantBaseline="middle" fontSize="13" fontWeight="700" fill="#111">
              {label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );

  const FanDiagram36 = () => (
    <div className="mb-6 inline-block rounded-md border border-gray-300 bg-white p-3">
      <svg width="320" height="190" viewBox="0 0 320 190" role="img" aria-label="모듈 구조도">
        <g stroke="#444" strokeWidth="2" fill="none">
          <line x1="160" y1="24" x2="80" y2="62" />
          <line x1="160" y1="24" x2="160" y2="62" />
          <line x1="160" y1="24" x2="240" y2="62" />
          <line x1="80" y1="62" x2="60" y2="100" />
          <line x1="80" y1="62" x2="160" y2="100" />
          <line x1="160" y1="62" x2="160" y2="100" />
          <line x1="240" y1="62" x2="160" y2="100" />
          <line x1="160" y1="100" x2="120" y2="138" />
          <line x1="160" y1="100" x2="200" y2="138" />
        </g>
        {[
          ['A', 160, 24],
          ['B', 80, 62],
          ['C', 160, 62],
          ['D', 240, 62],
          ['E', 60, 100],
          ['F', 160, 100],
          ['G', 120, 138],
          ['H', 200, 138],
        ].map(([label, x, y]) => (
          <g key={label} transform={`translate(${x},${y})`}>
            <rect x="-20" y="-10" width="40" height="20" fill="#fff" stroke="#444" strokeWidth="2" />
            <text x="0" y="1" textAnchor="middle" dominantBaseline="middle" fontSize="12" fontWeight="700" fill="#111">
              {label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );

  const GraphFigure43 = () => (
    <div className="mb-6 inline-block rounded-md border border-gray-300 bg-white p-3">
      <svg width="220" height="160" viewBox="0 0 220 160" role="img" aria-label="그래프 도식">
        <g stroke="#444" strokeWidth="2" fill="none">
          <line x1="110" y1="24" x2="60" y2="70" />
          <line x1="110" y1="24" x2="160" y2="70" />
          <line x1="60" y1="70" x2="110" y2="116" />
          <line x1="160" y1="70" x2="110" y2="116" />
          <line x1="110" y1="24" x2="110" y2="116" />
          <line x1="60" y1="70" x2="160" y2="70" />
        </g>
        {[
          ['1', 110, 24],
          ['2', 60, 70],
          ['3', 160, 70],
          ['4', 110, 116],
        ].map(([label, x, y]) => (
          <g key={label} transform={`translate(${x},${y})`}>
            <circle r="12" fill="#fff" stroke="#444" strokeWidth="2" />
            <text x="0" y="1" textAnchor="middle" dominantBaseline="middle" fontSize="12" fontWeight="700" fill="#111">
              {label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );

  const PromptFigure = () => (
    <div className="mb-6 inline-block rounded-md border border-gray-300 bg-white p-0 shadow-sm">
      <div className="w-[320px] bg-[#f5f5f5] p-3">
        <p className="text-xs text-gray-700 mb-2">이 페이지 내용:</p>
        <p className="text-[11px] text-gray-500 mb-2">title</p>
        <div className="mb-3 rounded border border-blue-400 bg-white px-2 py-1 text-xs text-gray-700">
          default
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded bg-blue-600 px-3 py-1 text-[11px] font-semibold text-white">
            확인
          </button>
          <button type="button" className="rounded px-3 py-1 text-[11px] text-slate-400">
            취소
          </button>
        </div>
      </div>
    </div>
  );

  const MemoryFigure14 = () => (
    <div className="mb-6 inline-block rounded-md border border-gray-300 bg-white p-3">
      <svg width="360" height="130" viewBox="0 0 360 130" role="img" aria-label="메모리 블록 도식">
        <g fill="#fff" stroke="#444" strokeWidth="1.5">
          {/* left blocks */}
          <rect x="8" y="72" width="45" height="28" />
          <rect x="53" y="72" width="45" height="28" />
          <rect x="98" y="72" width="55" height="28" />
          <rect x="153" y="72" width="45" height="28" />

          {/* right stack */}
          <rect x="250" y="10" width="60" height="28" />
          <rect x="250" y="38" width="60" height="28" />
          <rect x="250" y="66" width="60" height="28" />
          <rect x="250" y="94" width="60" height="28" />
        </g>

        {/* arrow */}
        <g stroke="#444" strokeWidth="1.8" fill="none">
          <line x1="205" y1="86" x2="238" y2="86" />
          <polyline points="232,80 240,86 232,92" />
        </g>

        <g fontSize="14" fontWeight="700" fill="#111" textAnchor="middle" dominantBaseline="middle">
          <text x="30" y="86">15K</text>
          <text x="75" y="86">3K</text>
          <text x="125" y="86">11K</text>
          <text x="175" y="86">7K</text>

          <text x="280" y="24">5K</text>
          <text x="280" y="52">10K</text>
          <text x="280" y="80">15K</text>
          <text x="280" y="108">20K</text>
        </g>
      </svg>
    </div>
  );

  const TcpHeaderFigure14 = () => (
    <div className="mb-6 inline-block rounded-md border border-gray-300 bg-white p-3">
      <svg width="430" height="150" viewBox="0 0 430 150" role="img" aria-label="TCP 헤더 구조도">
        <rect x="1" y="18" width="408" height="112" fill="#fff" stroke="#444" strokeWidth="1.5" />
        <g stroke="#444" strokeWidth="1.2" fill="none">
          <line x1="205" y1="18" x2="205" y2="34" />
          <line x1="1" y1="34" x2="409" y2="34" />
          <line x1="1" y1="50" x2="409" y2="50" />
          <line x1="1" y1="66" x2="409" y2="66" />
          <line x1="1" y1="98" x2="409" y2="98" />
          <line x1="1" y1="114" x2="409" y2="114" />

          <line x1="97" y1="66" x2="97" y2="114" />
          <line x1="161" y1="66" x2="161" y2="98" />
          <line x1="177" y1="66" x2="177" y2="98" />
          <line x1="193" y1="66" x2="193" y2="98" />
          <line x1="209" y1="66" x2="209" y2="98" />
          <line x1="225" y1="66" x2="225" y2="98" />
          <line x1="241" y1="66" x2="241" y2="98" />
          <line x1="257" y1="66" x2="257" y2="98" />
          <line x1="273" y1="66" x2="273" y2="98" />
          <line x1="337" y1="66" x2="337" y2="114" />
          <line x1="337" y1="98" x2="409" y2="98" />
        </g>

        <g fontSize="12" fill="#111" fontFamily="ui-sans-serif, system-ui, sans-serif">
          <text x="0" y="11">0</text>
          <text x="95" y="11">7</text>
          <text x="197" y="11">15</text>
          <text x="309" y="11">27</text>
          <text x="401" y="11">31</text>

          <text x="77" y="31" textAnchor="middle">Source Port</text>
          <text x="307" y="31" textAnchor="middle">Destination Port</text>

          <text x="205" y="47" textAnchor="middle">(가)</text>
          <text x="205" y="63" textAnchor="middle">(나)</text>

          <text x="49" y="87" textAnchor="middle">Data Offset</text>
          <text x="129" y="87" textAnchor="middle">Reserved</text>

          <text x="169" y="79" textAnchor="middle">C</text>
          <text x="169" y="93" textAnchor="middle">W</text>
          <text x="169" y="107" textAnchor="middle">R</text>

          {['E', 'U', 'A', 'P', 'R', 'S', 'F'].map((ch, idx) => (
            <text key={ch} x={185 + idx * 16} y="87" textAnchor="middle">
              {ch}
            </text>
          ))}
          {['C', 'R', 'C', 'S', 'S', 'Y', 'I'].map((ch, idx) => (
            <text key={`${ch}-${idx}`} x={185 + idx * 16} y="101" textAnchor="middle">
              {ch}
            </text>
          ))}
          {['G', 'K', 'H', 'T', 'N', 'N'].map((ch, idx) => (
            <text key={`${ch}-b-${idx}`} x={201 + idx * 16} y="115" textAnchor="middle">
              {ch}
            </text>
          ))}

          <text x="373" y="87" textAnchor="middle">Window Size</text>
          <text x="101" y="111" textAnchor="middle">Checksum</text>
          <text x="370" y="111" textAnchor="middle">Urgent Point</text>
          <text x="204" y="127" textAnchor="middle">Options and Padding</text>
        </g>
      </svg>
    </div>
  );

  const OutputFrameFigure16 = () => (
    <div className="mb-6 inline-block rounded-md border border-gray-300 bg-white p-3">
      <svg width="360" height="210" viewBox="0 0 360 210" role="img" aria-label="출력 결과 도식">
        <rect x="0" y="0" width="360" height="210" fill="#000" rx="4" />

        <g fontSize="28" fontWeight="700" fill="#ffffff" fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">
          {[5, 4, 3, 2, 1, 0].map((n, idx) => (
            <text key={`top-${n}`} x={28 + idx * 56} y="34">
              {n}
            </text>
          ))}
          <text x="2" y="70">11</text>
          <text x="330" y="70">6</text>
          {[29, 28, 27, 26, 25, 24].map((n, idx) => (
            <text key={`bottom-${n}`} x={2 + idx * 56} y="196">
              {n}
            </text>
          ))}
        </g>

        <g fill="#4f7ed1" stroke="#7ea3e8" strokeWidth="1.5">
          <rect x="16" y="94" width="46" height="36" />
          <rect x="16" y="136" width="46" height="36" />
          <rect x="314" y="94" width="30" height="36" />
          <rect x="314" y="136" width="30" height="36" />
        </g>

        <g stroke="#ffffff" strokeWidth="1" opacity="0.6">
          <line x1="0" y1="84" x2="360" y2="84" />
          <line x1="0" y1="182" x2="360" y2="182" />
        </g>
      </svg>
    </div>
  );

  if (!isStarted) {
    return (
      <>
        <TestLobby
          session={session}
          onStart={handleStartQuiz}
          problemCount={quizProblems.length}
          labels={T}
        />
        <UpdateNoticeModal
          isOpen={showUpdateNotice}
          onClose={() => {
            setShowUpdateNotice(false);
            try {
              window.localStorage.setItem(UPDATE_NOTICE_KEY, 'seen');
            } catch {}
          }}
        />
      </>
    );
  }

  if (quizCompleted) {
    return (
        <QuizResults
          session={session}
          results={quizResults}
          onRetryWrong={handleRetryWrongProblems}
          onRetryUnknown={handleRetryUnknownProblems}
          labels={T}
          isReviewOnly={isReviewOnlySession}
        />
      );
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 flex flex-col">
      <header className="bg-white shadow-md p-4 flex justify-between items-center relative z-10">
        <div className="flex items-center gap-4 min-w-0">
          <h1 className="text-xl font-bold text-indigo-900 hidden md:block">{session.title}</h1>
          <h1 className="text-xl font-bold text-indigo-900 md:hidden">{session.title.split(' ')[0]}...</h1>
        </div>
        <div className="text-lg font-semibold text-gray-900 whitespace-nowrap">
          {T.problem} {currentProblemIndex + 1} / {quizProblems.length}
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1 text-sm font-bold text-indigo-700 tabular-nums">
            {timerMinutes}:{timerSeconds}
          </div>
          <button
            type="button"
            onClick={() => {
              if (isExamLikePreset) {
                setEnableAnswerCheck(true);
                setShowExplanationWhenCorrect(true);
                setShowExplanationWhenIncorrect(true);
              } else {
                setEnableAnswerCheck(false);
                setShowExplanationWhenCorrect(false);
                setShowExplanationWhenIncorrect(false);
              }
              setIsSettingsOpen(false);
            }}
            className={`px-3 py-2 rounded-lg text-xs md:text-sm font-bold text-white ${
              isExamLikePreset
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : 'bg-slate-700 hover:bg-slate-800'
            }`}
          >
            {isExamLikePreset ? '해설 및 정답 다시 보기' : T.realStart}
          </button>
          <div className="relative">
            <button
              onClick={() => setIsSettingsOpen((prev) => !prev)}
              className="p-2 text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
              aria-label="Settings"
            >
              <Settings className="w-6 h-6" />
            </button>
            <QuizSettingsPopover
              isOpen={isSettingsOpen}
              onClose={() => setIsSettingsOpen(false)}
              labels={T}
              enableAnswerCheck={enableAnswerCheck}
              onChangeEnableAnswerCheck={setEnableAnswerCheck}
              showExplanationWhenCorrect={showExplanationWhenCorrect}
              onChangeShowExplanationWhenCorrect={setShowExplanationWhenCorrect}
              showExplanationWhenIncorrect={showExplanationWhenIncorrect}
              onChangeShowExplanationWhenIncorrect={setShowExplanationWhenIncorrect}
            />
          </div>
          <button
            onClick={handleEndQuiz}
            className="px-4 py-2 bg-red-600 text-white font-bold rounded-lg hover:bg-red-700 text-sm md:text-base"
          >
            {T.end}
          </button>
        </div>
      </header>

      <main className="flex-grow container mx-auto p-4 md:p-8">
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4 md:gap-6">
          <aside className="bg-white rounded-xl shadow-lg p-4 h-fit lg:sticky lg:top-24">
            <h3 className="text-sm font-bold text-gray-700 mb-3">{T.navTitle}</h3>
            <div className="grid grid-cols-5 sm:grid-cols-8 lg:grid-cols-4 gap-2">
              {quizProblems.map((problem, index) => {
                const status = getProblemStatus(problem);
                const isCurrent = index === currentProblemIndex;
                return (
                  <button
                    key={problem.problem_number}
                    onClick={() => goToProblem(index)}
                    className={`h-10 rounded-md border text-xs font-semibold transition ${getStatusClass(status)} ${isCurrent ? 'ring-2 ring-indigo-500' : ''}`}
                    title={`${T.problem} ${problem.problem_number} (${status})`}
                  >
                    {problem.problem_number} {status}
                  </button>
                );
              })}
            </div>
            <div className="mt-4 text-xs text-gray-600 space-y-1">
              <p><span className="font-bold text-green-700">O</span> {T.statusCorrect}</p>
              <p><span className="font-bold text-red-700">X</span> {T.statusWrong}</p>
              {isDirectProgressMode && <p><span className="font-bold text-blue-700">●</span> {T.statusSolved}</p>}
              <p><span className="font-bold text-gray-700">?</span> {T.statusUnsolved}</p>
            </div>
          </aside>

          <div className="bg-white p-6 md:p-8 rounded-xl shadow-lg">
            <p className="text-sm font-semibold text-indigo-600 mb-2">{currentProblem.sectionTitle}</p>
            {(typeof currentProblem?.wrongRatePercent === 'number' || typeof currentProblem?.unknownRatePercent === 'number') && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {typeof currentProblem?.wrongRatePercent === 'number' && (
                  <span className="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-bold text-rose-700">
                    오답률 {Number(currentProblem.wrongRatePercent).toFixed(1)}%
                  </span>
                )}
                {typeof currentProblem?.unknownRatePercent === 'number' && (
                  <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-bold text-violet-700">
                    모르겠어요 비율 {Number(currentProblem.unknownRatePercent).toFixed(1)}%
                  </span>
                )}
                {Number.isFinite(Number(currentProblem?.attemptCount)) && (
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                    시도 {Number(currentProblem.attemptCount)}회
                  </span>
                )}
                {Number.isFinite(Number(currentProblem?.wrongCountStat)) && Number.isFinite(Number(currentProblem?.unknownCountStat)) && (
                  <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
                    틀림 {Number(currentProblem.wrongCountStat)} / 모르겠어요 {Number(currentProblem.unknownCountStat)}
                  </span>
                )}
              </div>
            )}
            <h2 className="text-xl md:text-2xl font-semibold text-gray-900 mb-6 leading-relaxed whitespace-pre-wrap">
              {currentProblem.problem_number}. {formatQuestionTitle(questionTitle)}
            </h2>

            {questionCodeBlock && (
              <div className="mb-6 overflow-x-auto rounded-md border border-gray-300 bg-white">
                <pre className="m-0 p-3 text-sm leading-6 text-gray-900 whitespace-pre-wrap">
                  {formatCodeForDisplay(questionCodeBlock)}
                </pre>
              </div>
            )}

            {showTree44 && <TreeFigure44 />}
            {!showTree44 && showTree46 && <TreeFigure46 />}
            {!showTree44 && !showTree46 && showTree51 && <TreeFigure51 />}
            {!showTree44 && !showTree46 && !showTree51 && showTree56 && <TreeFigure56 />}
            {!showTree44 && !showTree46 && !showTree51 && !showTree56 && showFan36 && <FanDiagram36 />}
            {!showTree44 && !showTree46 && !showTree51 && !showTree56 && !showFan36 && showGraph43 && <GraphFigure43 />}
            {!showTree44 && !showTree46 && !showTree51 && !showTree56 && !showFan36 && !showGraph43 && showTcpHeader14 && <TcpHeaderFigure14 />}
            {!showTree44 && !showTree46 && !showTree51 && !showTree56 && !showFan36 && !showGraph43 && !showTcpHeader14 && showMemory14 && <MemoryFigure14 />}
            {!showTree44 && !showTree46 && !showTree51 && !showTree56 && !showFan36 && !showGraph43 && !showTcpHeader14 && !showMemory14 && showOutputFrame16 && <OutputFrameFigure16 />}
            {!showTree44 && !showTree46 && !showTree51 && !showTree56 && !showFan36 && !showGraph43 && !showTcpHeader14 && !showMemory14 && !showOutputFrame16 && showPromptFigure && <PromptFigure />}

            {bookPriceVisual && (
              <div className="mb-6">
                <div className="mb-3 overflow-x-auto rounded-md border border-gray-300 bg-gray-50">
                  <pre className="m-0 p-3 text-sm leading-6 text-gray-900 whitespace-pre-wrap">
                    {bookPriceVisual.sql}
                  </pre>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {[bookPriceVisual.left, bookPriceVisual.right].map((tbl) => (
                    <div key={tbl.title} className="overflow-x-auto rounded-md border border-gray-300 bg-white">
                      <div className="px-3 py-2 text-sm font-bold text-gray-800 border-b border-gray-200">{`<${tbl.title}>`}</div>
                      <table className="min-w-full text-sm text-gray-900">
                        <thead className="bg-gray-100">
                          <tr>
                            {tbl.headers.map((h) => (
                              <th key={h} className="border border-gray-300 px-3 py-2 text-center font-semibold">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tbl.rows.map((r, idx) => (
                            <tr key={`${tbl.title}-${idx}`} className="odd:bg-white even:bg-gray-50">
                              {r.map((c, cidx) => (
                                <td key={`${idx}-${cidx}`} className="border border-gray-300 px-3 py-2 text-center">{c}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {relationDegreeVisual && (
              <div className="mb-6 overflow-x-auto rounded-md border border-gray-300 bg-white">
                <table className="min-w-full text-sm text-gray-900">
                  <thead className="bg-gray-100">
                    <tr>
                      {relationDegreeVisual.headers.map((h) => (
                        <th key={h} className="border border-gray-300 px-3 py-2 text-center font-semibold">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {relationDegreeVisual.rows.map((row, ridx) => (
                      <tr key={`rel-${ridx}`} className="odd:bg-white even:bg-gray-50">
                        {row.map((cell, cidx) => (
                          <td key={`rel-${ridx}-${cidx}`} className="border border-gray-300 px-3 py-2 text-center">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tradeMaxVisual && (
              <div className="mb-6">
                <div className="mb-3 overflow-x-auto rounded-md border border-gray-300 bg-gray-50">
                  <pre className="m-0 p-3 text-sm leading-6 text-gray-900 whitespace-pre-wrap">
                    {tradeMaxVisual.sql}
                  </pre>
                </div>
                <div className="overflow-x-auto rounded-md border border-gray-300 bg-white">
                  <div className="px-3 py-2 text-sm font-bold text-gray-800 border-b border-gray-200">{'<거래내역>'}</div>
                  <table className="min-w-full text-sm text-gray-900">
                    <thead className="bg-gray-100">
                      <tr>
                        {tradeMaxVisual.headers.map((h) => (
                          <th key={h} className="border border-gray-300 px-3 py-2 text-center font-semibold">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tradeMaxVisual.rows.map((row, ridx) => (
                        <tr key={`tm-${ridx}`} className="odd:bg-white even:bg-gray-50">
                          {row.map((cell, cidx) => (
                            <td key={`tm-${ridx}-${cidx}`} className="border border-gray-300 px-3 py-2 text-center">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {(currentProblem.examples || currentProblem.image_url) && (
              <div className="mb-6 rounded-lg border border-sky-200 bg-sky-50 overflow-hidden">
                <div className="px-4 py-2 bg-sky-100 border-b border-sky-200">
                  <span className="text-sm font-bold text-sky-800">보기</span>
                </div>
                <div className="p-4">
                  {currentProblem.image_url && (
                    <div className={`${currentProblem.examples ? 'mb-4' : ''} flex justify-center`}>
                      <img src={currentProblem.image_url} alt="보조 이미지" className="max-w-full rounded-md shadow-sm border border-gray-200" />
                    </div>
                  )}
                  {currentProblem.examples && (() => {
                    const lines = currentProblem.examples.split('\n');
                    const nonEmpty = lines.filter((l) => l.trim());
                    const isTable = nonEmpty.length > 1 && nonEmpty.every((l) => l.includes('|'));
                    const isCodeLike = !isTable && isCodeLikeText(currentProblem.examples);
                    const hasImageTag = /<img\s/i.test(currentProblem.examples);
                    if (!isTable) {
                      if (hasImageTag) {
                        return <div className="space-y-2">{renderExamplesRichText(currentProblem.examples)}</div>;
                      }
                      if (isCodeLike) {
                        return (
                          <div className="overflow-x-auto rounded-md border border-sky-200 bg-white">
                            <pre className="m-0 p-3 text-sm leading-6 text-gray-900 whitespace-pre-wrap">
                              {formatCodeForDisplay(currentProblem.examples)}
                            </pre>
                          </div>
                        );
                      }
                      return <p className="text-gray-800 whitespace-pre-wrap leading-relaxed font-mono text-sm">{currentProblem.examples}</p>;
                    }
                    const tables = currentProblem.examples.split('\n\n').filter(Boolean);
                    return (
                      <div className="space-y-3">
                        {tables.map((tbl, ti) => (
                          <table key={ti} className="w-full text-sm border-collapse">
                            <tbody>
                              {tbl.split('\n').filter(Boolean).map((row, ri) => {
                                const cells = row.split('|').map((c) => c.trim());
                                const Tag = ri === 0 ? 'th' : 'td';
                                return (
                                  <tr key={ri} className={ri === 0 ? 'bg-sky-100' : ri % 2 === 0 ? 'bg-sky-50' : 'bg-white'}>
                                    {cells.map((cell, ci) => (
                                      <Tag key={ci} className="border border-sky-200 px-3 py-2 text-center text-gray-800 font-medium">
                                        {cell}
                                      </Tag>
                                    ))}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

                <div className="space-y-4">
                  <div className="rounded-lg border-2 border-indigo-200 bg-white p-4">
                    <label className="mb-2 block text-sm font-semibold text-gray-700">답안 입력</label>
                    {practicalInputType === 'sequence' && sequenceMeta ? (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {sequenceDraft.map((token, idx) => (
                            <div key={`seq-slot-${idx}`} className="flex items-center gap-2">
                                <input
                                  ref={(el) => {
                                    sequenceInputRefs.current[idx] = el;
                                  }}
                                  type="text"
                                  inputMode={sequenceMeta.kind === 'number' ? 'numeric' : 'text'}
                                  value={token}
                                  onChange={(e) => {
                                    const inserted = handleSequenceSlotInput(
                                      currentProblem.problem_number,
                                      idx,
                                      e.target.value
                                    );
                                    if (inserted && idx < sequenceDraft.length - 1) {
                                      requestAnimationFrame(() => {
                                        const nextRef = sequenceInputRefs.current[idx + 1];
                                        nextRef?.focus();
                                        nextRef?.select?.();
                                      });
                                    }
                                  }}
                                  onKeyDown={(e) =>
                                    handleSequenceSlotKeyDown(e, currentProblem.problem_number, idx)
                                  }
                                  onFocus={(e) => e.target.select()}
                                  disabled={isChecked}
                                  className="h-11 w-14 rounded-lg border border-gray-300 bg-white text-center text-lg font-semibold text-gray-900 outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-100 disabled:text-gray-400"
                                  aria-label={`순서 입력 ${idx + 1}`}
                                maxLength={sequenceMeta.kind === 'number' ? 2 : 2}
                              />
                              {idx < sequenceDraft.length - 1 && sequenceMeta.mode !== 'unordered_symbol_set' ? (
                                <span className="text-gray-400 font-bold select-none">→</span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                        <p className="text-xs text-gray-500">
                          {sequenceMeta.mode === 'unordered_symbol_set'
                            ? '옳은 기호만 골라 입력하세요. (예: ㄱ, ㄴ)'
                            : '순서대로 기호를 입력하세요. (예: ㄱ, ㄴ, ㄷ ...)'}
                        </p>
                      </div>
                      ) : practicalInputType === 'multi_blank' && multiBlankMeta ? (
                        <div className="space-y-2">
                          {multiBlankMeta.labels.map((label, idx) => (
                            <div key={`multi-blank-${label}-${idx}`} className="flex items-center gap-2">
                              <div className="w-14 shrink-0 rounded-md border border-gray-300 bg-gray-50 px-2 py-2 text-center text-sm font-semibold text-gray-700">
                                {label}
                              </div>
                              <span className="text-gray-400 select-none">-</span>
                              <input
                                ref={(el) => {
                                  multiBlankInputRefs.current[idx] = el;
                                }}
                                type="text"
                                value={multiBlankDraft[idx] || ''}
                                onChange={(e) =>
                                  handleMultiBlankSlotInput(
                                    currentProblem.problem_number,
                                    multiBlankMeta.labels,
                                    idx,
                                    e.target.value
                                  )
                                }
                                onKeyDown={(e) =>
                                  handleMultiBlankSlotKeyDown(
                                    e,
                                    currentProblem.problem_number,
                                    multiBlankMeta.labels,
                                    idx,
                                    multiBlankDraft
                                  )
                                }
                                onFocus={(e) => e.target.select()}
                                disabled={isChecked}
                                placeholder="답 입력"
                                className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-100 disabled:text-gray-500"
                              />
                            </div>
                          ))}
                        </div>
                      ) : practicalInputType === 'textarea' ? (
                        <textarea
                        value={selectedAnswer === UNKNOWN_OPTION ? '' : String(selectedAnswer || '')}
                        onChange={(e) => handleSubjectiveInput(currentProblem.problem_number, e.target.value)}
                      disabled={isChecked}
                      placeholder={practicalInputPlaceholder}
                      rows={4}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-100 disabled:text-gray-500 font-mono text-sm"
                    />
                  ) : practicalInputType === 'single' && practicalSymbolChoices.length > 0 ? (
                    <div className="space-y-3">
                      <div className="rounded-xl border border-indigo-200 bg-gradient-to-b from-indigo-50/80 to-white p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-xs font-extrabold tracking-wide text-indigo-800">
                            답안 선택 (보기와 별개)
                          </p>
                          {selectedPracticalChoice && selectedAnswer !== UNKNOWN_OPTION ? (
                            <span className="rounded-full border border-indigo-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                              선택 완료
                            </span>
                          ) : null}
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {practicalSymbolChoices.map((choice) => {
                          const isSelected =
                            selectedAnswer !== UNKNOWN_OPTION &&
                            isPracticalAnswerMatch(selectedAnswer, choice.fullText, {
                              ...currentProblem,
                              accepted_answers: [choice.label, choice.altText, choice.text],
                            });
                          return (
                            <button
                              key={`practical-choice-${choice.label}`}
                              type="button"
                              onClick={() => handleSubjectiveInput(currentProblem.problem_number, choice.fullText)}
                              disabled={isChecked}
                              className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                                isSelected
                                  ? 'border-indigo-600 bg-gradient-to-r from-indigo-100 to-blue-100 text-indigo-900 ring-2 ring-indigo-300 shadow-md shadow-indigo-100'
                                  : 'border-indigo-200 bg-white text-gray-800 hover:border-indigo-400 hover:bg-indigo-50'
                              } ${isChecked ? 'cursor-not-allowed opacity-80' : ''}`}
                            >
                              <span className={`mr-2 inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-bold ${
                                isSelected
                                  ? 'border-indigo-500 bg-white text-indigo-700'
                                  : 'border-gray-300 bg-gray-50 text-gray-700'
                              }`}>
                                {choice.label}
                              </span>
                              <span className={isSelected ? 'font-semibold' : ''}>{choice.text}</span>
                              {isSelected ? (
                                <span className="ml-2 inline-flex rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                                  선택됨
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                        </div>
                      </div>
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
                        <p className="mb-2 text-xs font-bold text-emerald-800">선택된 답안 / 직접 수정</p>
                        <input
                          type="text"
                          value={
                            selectedAnswer === UNKNOWN_OPTION
                              ? ''
                              : selectedPracticalChoice
                                ? selectedPracticalChoice.fullText
                                : String(selectedAnswer || '')
                          }
                          onChange={(e) => handleSubjectiveInput(currentProblem.problem_number, e.target.value)}
                          disabled={isChecked}
                          placeholder={practicalInputPlaceholder}
                          className="w-full rounded-lg border border-emerald-300 bg-white px-3 py-2 text-gray-900 outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-gray-100 disabled:text-gray-500"
                        />
                      </div>
                      <p className="text-xs text-gray-500">
                        보기에서 기호를 선택하면 답안이 자동 입력됩니다.
                      </p>
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={selectedAnswer === UNKNOWN_OPTION ? '' : String(selectedAnswer || '')}
                      onChange={(e) => handleSubjectiveInput(currentProblem.problem_number, e.target.value)}
                      disabled={isChecked}
                      placeholder={practicalInputPlaceholder}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-100 disabled:text-gray-500"
                    />
                  )}
                  {practicalAnswerFormatHintDisplay ? (
                    <p className="mt-2 text-xs text-indigo-700">
                      정답 형식: {practicalAnswerFormatHintDisplay}
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs text-gray-500">
                    영문/한글, 괄호 표기 차이는 일부 정규화해서 채점합니다.
                  </p>
                </div>

              <button
                type="button"
                onClick={() => handleSelectOption(currentProblem.problem_number, UNKNOWN_OPTION)}
                disabled={isChecked}
                className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                  selectedAnswer === UNKNOWN_OPTION
                    ? (showResult && !isCorrect
                        ? 'bg-red-100 text-red-800 border-red-500 ring-2 ring-red-500'
                        : 'bg-indigo-100 text-indigo-700 border-indigo-500 ring-2 ring-indigo-500 font-bold')
                    : 'bg-white hover:bg-indigo-50 border-indigo-200 text-gray-800'
                } ${isChecked ? 'cursor-not-allowed opacity-90' : ''}`}
              >
                모르겠어요 (찍는건 시험장에서 ㅎ)
              </button>
            </div>

            {shouldShowExplanation && (
              <div className={`mt-6 p-6 rounded-lg animate-in fade-in border ${isCorrect ? 'bg-blue-50 border-blue-200' : 'bg-red-50 border-red-200'}`}>
                <h3 className={`text-lg font-bold mb-1 ${isCorrect ? 'text-blue-800' : 'text-red-800'}`}>
                  {isCorrect ? T.correct : T.wrong}
                </h3>
                <p className="text-lg font-semibold text-indigo-900 mb-3">
                  {T.answer}: {String(correctAnswer || '').trim() || '-'}
                </p>
                {explanationText && (
                  <p className={`text-gray-700 whitespace-pre-wrap border-t pt-3 leading-relaxed ${isCorrect ? 'border-blue-100' : 'border-red-100'}`}>
                    <span className="font-semibold">{T.explanation}:</span>{'\n'}
                    {formatExplanation(explanationText)}
                  </p>
                )}

                <GptHelpSection
                  isGptUsedForCurrent={isGptUsedForCurrent}
                  hasAssistantReplyForCurrent={hasAssistantReplyForCurrent}
                  showGptHelp={showGptHelp}
                  gptQuestion={gptQuestion}
                  onChangeGptQuestion={setGptQuestion}
                  onAskGpt={handleAskGptObjection}
                  gptLoading={gptLoading}
                  gptMessages={gptMessages}
                  gptError={gptError}
                  hasSavedGptForCurrent={hasSavedGptForCurrent}
                  onOpenGptView={handleOpenGptView}
                  onOpenGptChat={handleOpenGptChatFromHelp}
                  gptMaxTurns={GPT_MAX_TURNS}
                />
              </div>
            )}

            <div className="mt-6 flex justify-end">
              {(() => {
                const isLast = currentProblemIndex === quizProblems.length - 1;
                const primaryLabel = isDirectProgressMode
                  ? (isLast ? T.resultView : T.next)
                  : (isChecked ? (isLast ? T.resultView : T.next) : T.check);
                const primaryDisabled = !hasSelectedAnswer;
                // 하단 메인 버튼: 모드/마지막 문제 여부에 따라 확인/다음/결과 보기 처리
                const handlePrimaryClick = () => {
                  if (isDirectProgressMode) {
                    if (!hasSelectedAnswer) {
                      alert(T.needSelect);
                      return;
                    }
                    if (isLast) {
                      handleSubmitQuiz();
                    } else {
                      setCurrentProblemIndex(currentProblemIndex + 1);
                    }
                    return;
                  }
                  if (isChecked) {
                    if (isLast) handleSubmitQuiz();
                    else handleNextClick();
                    return;
                  }
                  handleNextClick();
                };
                return (
              <button
                onClick={handlePrimaryClick}
                disabled={primaryDisabled}
                className="px-8 py-3 bg-indigo-600 text-white font-bold rounded-lg hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed inline-flex items-center"
              >
                {primaryLabel}
                {(isDirectProgressMode ? !isLast : (isChecked && !isLast)) && <ChevronRight className="ml-2 w-5 h-5" />}
              </button>
                );
              })()}
            </div>

            {!reportedProblems[currentProblem.problem_number] && (
              <div className="mt-4 border-t pt-4">
                <p className="text-sm font-semibold text-gray-700 mb-2">문제 신고하기</p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    value={reportReason}
                    onChange={(e) => setReportReason(e.target.value)}
                    className="flex-1 rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                    style={{ color: '#111827', backgroundColor: '#ffffff' }}
                  >
                    <option value="" style={{ color: '#6b7280', backgroundColor: '#ffffff' }}>
                      선택해주세요
                    </option>
                    {REPORT_REASONS.map((reason) => (
                      <option key={reason} value={reason} style={{ color: '#111827', backgroundColor: '#ffffff' }}>
                        {reason}
                      </option>
                    ))}
                  </select>
                  {reportReason === '기타' && (
                    <input
                      type="text"
                      value={reportEtcText}
                      onChange={(e) => setReportEtcText(e.target.value)}
                      placeholder="신고 사유를 입력해주세요"
                      className="flex-1 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-500 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  )}
                  <button
                    onClick={handleReportProblem}
                    disabled={!reportReason || (reportReason === '기타' && !reportEtcText.trim())}
                    className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-700 disabled:bg-rose-300 disabled:cursor-not-allowed"
                  >
                    신고하기
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="bg-white shadow-t-md p-4 flex justify-between items-center">
        <button
          onClick={goToPreviousProblem}
          disabled={currentProblemIndex === 0}
          className="px-8 py-3 bg-gray-200 text-gray-700 font-bold rounded-lg hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed inline-flex items-center"
        >
          <ChevronLeft className="mr-2 w-5 h-5" />
          {T.prev}
        </button>
        <div />
      </footer>

      <ReportTipToast isOpen={showReportTipNotice} countdown={reportTipCountdown} />

      <GptChatModal
        isOpen={gptChatOpen}
        onClose={() => setGptChatOpen(false)}
        gptMessages={gptMessages}
        gptVoteMap={gptVoteMap}
        onVoteGpt={handleVoteGpt}
        gptMaxTurns={GPT_MAX_TURNS}
        gptQuestion={gptQuestion}
        onChangeGptQuestion={setGptQuestion}
        onAskGpt={handleAskGptObjection}
        gptLoading={gptLoading}
        gptError={gptError}
      />

      <GptLoadingOverlay isOpen={gptLoading} />

    </div>
  );
}
