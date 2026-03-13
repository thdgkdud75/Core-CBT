'use client';

import { useCallback, useEffect, useState } from 'react';
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
export default function Quiz({
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
  const isReviewOnlySession = Boolean(session?.reviewOnly);
  const backToSessionHref = String(session?.backHref || '/test');
  const quizDurationSeconds =
    Number.isFinite(Number(session?.durationSeconds)) && Number(session?.durationSeconds) > 0
      ? Number(session.durationSeconds)
      : QUIZ_DURATION_SECONDS;
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
  const [remainingSeconds, setRemainingSeconds] = useState(quizDurationSeconds);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [enableAnswerCheck, setEnableAnswerCheck] = useState(true);
  const [showExplanationWhenCorrect, setShowExplanationWhenCorrect] = useState(true);
  const [showExplanationWhenIncorrect, setShowExplanationWhenIncorrect] = useState(true);
  const [showUpdateNotice, setShowUpdateNotice] = useState(false);
  const [showReportTipNotice, setShowReportTipNotice] = useState(false);
  const [reportTipCountdown, setReportTipCountdown] = useState(5);
  const [reportReason, setReportReason] = useState('');
  const [reportEtcText, setReportEtcText] = useState('');
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
    setRemainingSeconds(quizDurationSeconds);
  }, [problems, quizDurationSeconds]);

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
      trackEvent('visit_test', { sessionId: sid, path: `/test/${sid}` });
    } catch {
      trackEvent('visit_test', { sessionId: sid, path: `/test/${sid}` });
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
      setRemainingSeconds(quizDurationSeconds);
      setIsStarted(true);
      trackEvent('start_exam', { sessionId, path: `/test/${sessionId}` });
    }
    setInitialJumpApplied(true);
  }, [initialJumpApplied, initialProblemNumber, isStarted, quizProblems, quizDurationSeconds, sessionId]);

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
      setRemainingSeconds(Math.max(0, quizDurationSeconds - elapsed));
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [isStarted, quizCompleted, quizDurationSeconds, quizStartedAtMs]);

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
    setRemainingSeconds(quizDurationSeconds);
    setIsStarted(true);
    trackEvent('start_exam', { sessionId, path: `/test/${sessionId}`, payload: { mode: 'normal' } });
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

  // 시험 제출: 과목별/총점 결과 계산 후 결과 화면으로 전환
  const handleSubmitQuiz = () => {
    const isRetryMode = quizProblems.length !== allProblems.length;
    const mergedAnswers = { ...accumulatedAnswers, ...answers };
    let totalCorrect = 0;
    let currentSetCorrect = 0;
    let unknownCount = 0;
    const currentSetTotal = quizProblems.length;
    const subjectDefs = isReviewOnlySession
      ? []
      : Array.isArray(session?.examProfile?.subjects) && session.examProfile.subjects.length > 0
        ? session.examProfile.subjects.map((s, idx) => ({
            id: Number(s?.id ?? idx + 1),
            label: String(s?.label || `과목 ${idx + 1}`),
            start: Number(s?.start ?? 0),
            end: Number(s?.end ?? 0),
            passMin: Number(s?.passMin ?? 0),
          }))
        : [
            { id: 1, label: '과목 1', start: 1, end: 20, passMin: 8 },
            { id: 2, label: '과목 2', start: 21, end: 40, passMin: 8 },
            { id: 3, label: '과목 3', start: 41, end: 60, passMin: 8 },
          ];
    const subjectCorrectCounts = Object.fromEntries(subjectDefs.map((d) => [d.id, 0]));
    const subjectTotalCounts = Object.fromEntries(subjectDefs.map((d) => [d.id, 0]));
    const findSubjectId = (problemNum) => {
      const hit = subjectDefs.find((d) => problemNum >= d.start && problemNum <= d.end);
      return hit ? hit.id : null;
    };

    if (!isReviewOnlySession) {
      quizProblems.forEach((problem) => {
        const problemNum = parseInt(problem.problem_number, 10);
        const subjectId = findSubjectId(problemNum);
        if (subjectId != null) subjectTotalCounts[subjectId] = (subjectTotalCounts[subjectId] || 0) + 1;
      });
    }

    allProblems.forEach((problem) => {
      const problemNum = parseInt(problem.problem_number, 10);
      const userAnswer = mergedAnswers[problem.problem_number];
      const correctAnswer = answersMap[problem.problem_number];
      if (userAnswer === UNKNOWN_OPTION) unknownCount++;

      if (userAnswer === correctAnswer) {
        totalCorrect++;
        if (!isReviewOnlySession) {
          const subjectId = findSubjectId(problemNum);
          if (subjectId != null) subjectCorrectCounts[subjectId] = (subjectCorrectCounts[subjectId] || 0) + 1;
        }
      }
    });

    quizProblems.forEach((problem) => {
      const userAnswer = mergedAnswers[problem.problem_number];
      const correctAnswer = answersMap[problem.problem_number];
      if (userAnswer === correctAnswer) currentSetCorrect++;
    });

    const subjectPassFail = isReviewOnlySession
      ? {}
      : Object.fromEntries(subjectDefs.map((d) => [d.id, (subjectCorrectCounts[d.id] || 0) >= d.passMin]));
    const subjectSummaries = isReviewOnlySession
      ? []
      : subjectDefs.map((d) => ({
          id: d.id,
          label: d.label,
          correctCount: subjectCorrectCounts[d.id] || 0,
          totalCount: subjectTotalCounts[d.id] || 0,
          passed: Boolean(subjectPassFail[d.id]),
        }));
    const totalPassMin = Number(session?.examProfile?.totalPassMin);
    const isOverallPass = isReviewOnlySession
      ? totalCorrect === allProblems.length
      : totalCorrect >= (Number.isFinite(totalPassMin) ? totalPassMin : 36) &&
        subjectDefs.every((d) => Boolean(subjectPassFail[d.id]));
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
        isCorrect: userAnswer === correctAnswer,
        isUnknown: userAnswer === UNKNOWN_OPTION,
      };
    });

    setAccumulatedAnswers(mergedAnswers);
    trackEvent('finish_exam', {
      sessionId,
      path: `/test/${sessionId}`,
      payload: {
        totalCorrect,
        wrongCount: allProblems.length - totalCorrect,
        unknownCount,
        subjectCorrectCounts,
        subjectSummaries,
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
      subjectSummaries,
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
  const getOptionList = (problem) => {
    const base = Array.isArray(problem?.options) ? problem.options : [];
    if (base.length === 0) return [];
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
  const selectedAnswer = currentProblemNumber ? answers[currentProblemNumber] : null;
  const correctAnswer = currentProblemNumber && answersMap ? answersMap[currentProblemNumber] : null;
  const currentGptProblemKey = getGptProblemKey(currentProblem, selectedAnswer);
  const isCorrect = selectedAnswer === correctAnswer;
  const isSubjectiveProblem = Array.isArray(currentProblem?.options) && currentProblem.options.length === 0;
  const isExamLikePreset =
    !enableAnswerCheck && !showExplanationWhenCorrect && !showExplanationWhenIncorrect;
  const isDirectProgressMode = !enableAnswerCheck;
  const correctAnswerIndex = currentProblem && Array.isArray(currentProblem.options)
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

      if (['1', '2', '3', '4', '5'].includes(e.key)) {
        if (!currentProblem || isChecked) return;
        const idx = Number(e.key) - 1;
        const option = getOptionList(currentProblem)[idx];
        if (!option) return;
        e.preventDefault();
        handleSelectOption(currentProblem.problem_number, option);
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
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
          if (!selectedAnswer) return;
          if (currentProblemIndex === quizProblems.length - 1) {
            handleSubmitQuiz();
          } else {
            setCurrentProblemIndex(currentProblemIndex + 1);
          }
          return;
        }
        if (!isChecked) {
          if (selectedAnswer) handleNextClick();
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
      if (!selectedAnswer) {
        alert(T.needSelect);
        return;
      }
      if (currentProblemIndex < quizProblems.length - 1) {
        setCurrentProblemIndex(currentProblemIndex + 1);
      }
      return;
    }
    if (!isChecked) {
      if (!selectedAnswer) {
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
      path: `/test/${sessionId}`,
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
    setRemainingSeconds(quizDurationSeconds);
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
    setRemainingSeconds(quizDurationSeconds);
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
      if (userAnswer === correctAnswer) totalCorrect++;
    });

    const solvedCount = allProblems.filter((problem) => mergedAnswers[problem.problem_number] !== undefined).length;
    const totalCount = allProblems.length;
    alert(
      `\uD604\uC7AC \uC810\uC218: ${totalCorrect} / ${totalCount}\n` +
      `\uD480\uC774 \uC644\uB8CC: ${solvedCount} / ${totalCount}`
    );
    clearResumeSnapshot();
    markResumeDiscardOnRestore();
    router.push(backToSessionHref);
  };

  const getProblemStatus = (problem) => {
    const num = problem.problem_number;
    if (isDirectProgressMode && answers[num] !== undefined && !checkedProblems[num]) return '●';
    if (!checkedProblems[num]) return '?';
    return answers[num] === answersMap[num] ? 'O' : 'X';
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

  const renderExamplesRichText = (examples) => {
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
            {!showTree44 && !showTree46 && !showTree51 && !showTree56 && !showFan36 && !showGraph43 && showMemory14 && <MemoryFigure14 />}
            {!showTree44 && !showTree46 && !showTree51 && !showTree56 && !showFan36 && !showGraph43 && !showMemory14 && showPromptFigure && <PromptFigure />}

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

            {currentProblem.image_url && (
              <div className="mb-6 space-y-4">
                {currentProblem.image_url.split(',').map((u) => {
                  const src = String(u || '').trim();
                  if (!src) return null;
                  return (
                    <img
                      key={src}
                      src={src}
                      alt="보조 이미지"
                      className="max-w-full rounded-md shadow-sm border border-gray-200"
                    />
                  );
                })}
              </div>
            )}
            {currentProblem.examples && (
              <div className="mb-6 rounded-lg border border-sky-200 bg-sky-50 overflow-hidden">
                <div className="px-4 py-2 bg-sky-100 border-b border-sky-200">
                  <span className="text-sm font-bold text-sky-800">보기</span>
                </div>
                <div className="p-4">
                  {(() => {
                    const lines = currentProblem.examples.split('\n');
                    const nonEmpty = lines.filter((l) => l.trim());
                    const isTable = nonEmpty.length > 1 && nonEmpty.every((l) => l.includes('|'));
                    const isCodeLike = !isTable && isCodeLikeText(currentProblem.examples);
                    if (!isTable) {
                      if (/<img\s/i.test(currentProblem.examples)) {
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
              {isSubjectiveProblem ? (
                <div className="rounded-lg border-2 border-indigo-200 bg-white p-4">
                  <p className="text-sm font-semibold text-indigo-700 mb-2">주관식 답안 입력</p>
                  <textarea
                    value={String(selectedAnswer || '')}
                    onChange={(e) => handleSelectOption(currentProblem.problem_number, e.target.value)}
                    disabled={isChecked}
                    placeholder="정답을 입력하세요."
                    className="w-full min-h-[96px] rounded-md border border-indigo-200 px-3 py-2 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-100 disabled:text-gray-600"
                  />
                </div>
              ) : (
                getOptionList(currentProblem).map((option, index) => {
                  let buttonClass = 'bg-white hover:bg-indigo-50 border-indigo-200 text-gray-800';
                  const optionIsCode = isCodeLikeText(option);
                  const isUnknownOption = option === UNKNOWN_OPTION;
                  if (selectedAnswer === option) {
                    buttonClass = 'bg-indigo-100 text-indigo-700 border-indigo-500 ring-2 ring-indigo-500 font-bold';
                    if (showResult) {
                      buttonClass = isCorrect
                        ? 'bg-green-100 text-green-800 border-green-500 ring-2 ring-green-500'
                        : 'bg-red-100 text-red-800 border-red-500 ring-2 ring-red-500';
                    }
                  } else if (showResult && !isCorrect && option === correctAnswer) {
                    buttonClass = 'bg-green-100 text-green-800 border-green-500 ring-2 ring-green-500';
                  }
                  return (
                    <button
                      key={index}
                      onClick={() => handleSelectOption(currentProblem.problem_number, option)}
                      disabled={isChecked}
                      className={`w-full text-left p-4 rounded-lg border-2 transition-all ${buttonClass} ${isChecked ? 'cursor-not-allowed opacity-90' : ''}`}
                    >
                      {isUnknownOption ? (
                        `${index + 1}. 모르겠어요 (찍는건 시험장에서 ㅎ)`
                      ) : isFramesetChoiceQuestion ? (
                        <div className="flex items-center gap-3">
                          <div className="font-semibold">{index + 1}.</div>
                          <FramesetOptionFigure idx={index} />
                        </div>
                      ) : optionIsCode ? (
                        <div className="space-y-2">
                          <div className="font-semibold">{index + 1}.</div>
                          <div className="overflow-x-auto rounded-md border border-indigo-200 bg-white/80">
                            <pre className="m-0 p-3 text-sm leading-6 text-gray-900 whitespace-pre-wrap">
                              {formatCodeForDisplay(option)}
                            </pre>
                          </div>
                        </div>
                      ) : (
                        `${index + 1}. ${option}`
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {shouldShowExplanation && (
              <div className={`mt-6 p-6 rounded-lg animate-in fade-in border ${isCorrect ? 'bg-blue-50 border-blue-200' : 'bg-red-50 border-red-200'}`}>
                <h3 className={`text-lg font-bold mb-1 ${isCorrect ? 'text-blue-800' : 'text-red-800'}`}>
                  {isCorrect ? T.correct : T.wrong}
                </h3>
                <p className="text-lg font-semibold text-indigo-900 mb-3">
                  {T.answer}: {isSubjectiveProblem ? (String(correctAnswer || '').trim() || '-') : `${correctAnswerIndex + 1}${T.numberSuffix}`}
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
                const primaryDisabled = !selectedAnswer;
                // 하단 메인 버튼: 모드/마지막 문제 여부에 따라 확인/다음/결과 보기 처리
                const handlePrimaryClick = () => {
                  if (isDirectProgressMode) {
                    if (!selectedAnswer) {
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
