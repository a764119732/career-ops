import { createHash } from 'node:crypto';
import { auditClaims } from '../verify-cv-facts.mjs';

export const STATES = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  EVALUATING: 'EVALUATING',
  EVALUATED: 'EVALUATED',
  SHORTLISTED: 'SHORTLISTED',
  CV_GENERATING: 'CV_GENERATING',
  CV_QA: 'CV_QA',
  READY_TO_APPLY: 'READY_TO_APPLY',
  APPLICATION_IN_PROGRESS: 'APPLICATION_IN_PROGRESS',
  APPLIED: 'APPLIED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  BLOCKED_USER_ACTION: 'BLOCKED_USER_ACTION',
  RETRY: 'RETRY',
  SKIPPED: 'SKIPPED',
  FOLLOW_UP_DUE: 'FOLLOW_UP_DUE',
  INTERVIEW_DETECTED: 'INTERVIEW_DETECTED',
});

export const BLOCK_REASON_CODES = Object.freeze({
  CHROME_FILE_UPLOAD_PERMISSION: 'CHROME_FILE_UPLOAD_PERMISSION',
  CLOUDFLARE_VERIFICATION: 'CLOUDFLARE_VERIFICATION',
  CAPTCHA: 'CAPTCHA',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  MFA_REQUIRED: 'MFA_REQUIRED',
});

const INTERRUPTED = new Set([
  STATES.EVALUATING,
  STATES.CV_GENERATING,
  STATES.CV_QA,
]);

const INTERVIEW_TERMS = [
  'interview', 'interview invitation', 'shortlisted', 'assessment',
  'hiring manager', 'schedule a call', 'availability for interview',
  'teams interview', 'zoom interview', '面试', '邀约', '笔试',
];

function normalized(value) {
  return String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function salaryAmount(value) {
  const match = /^\$?(\d+(?:\.\d+)?)(k)?$/i.exec(String(value ?? '').replace(/[\s,]/g, ''));
  return match ? Number(match[1]) * (match[2] ? 1000 : 1) : NaN;
}

function companyKey(value) {
  return normalized(value)
    .replace(/\b(limited|ltd|company|co|corporation|corp|incorporated|inc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jobIdFromUrl(url) {
  const hit = /(?:\/job\/|[?&](?:jobid|job_id)=)(\d+)/i.exec(String(url ?? ''));
  return hit?.[1] ?? '';
}

export function stableJobId(job) {
  const provider = normalized(job.provider || (String(job.url).includes('jobsdb.com') ? 'jobsdb' : 'unknown'))
    .replace(/\s+/g, '-');
  const id = String(job.jobId ?? job.job_id ?? jobIdFromUrl(job.url)).trim();
  if (id) return `${provider}:${id}`;
  const material = [provider, normalized(job.company), normalized(job.role || job.title), String(job.url ?? '')].join('|');
  return `${provider}:sha256:${createHash('sha256').update(material).digest('hex').slice(0, 20)}`;
}

export function isDuplicate(job, { tracker = [], jobs = {} } = {}) {
  const key = stableJobId(job);
  const jobId = key.split(':').at(-1);
  const stateHit = jobs[key];
  if (stateHit?.state === STATES.APPLIED) return { duplicate: true, reason: 'already-applied-state', key };
  const trackerHit = tracker.find((row) => {
    const rowId = String(row.jobId ?? row.job_id ?? '').trim();
    return rowId && rowId === jobId && normalized(row.status) === 'applied';
  });
  return trackerHit
    ? { duplicate: true, reason: 'already-applied-tracker', key }
    : { duplicate: false, key };
}

export function recoverInterruptedJobs(jobs, now = new Date().toISOString()) {
  const result = structuredClone(jobs ?? {});
  for (const job of Object.values(result)) {
    if (job.state === STATES.APPLICATION_IN_PROGRESS) {
      Object.assign(job, {
        state: STATES.NEEDS_REVIEW,
        reason: 'Submission result uncertain after interruption; never retry Submit.',
        reasonCode: 'SUBMISSION_RESULT_UNCERTAIN',
        submissionUncertain: true,
        retryable: false,
        updatedAt: now,
      });
    } else if (INTERRUPTED.has(job.state)) {
      Object.assign(job, {
        state: STATES.RETRY,
        reason: 'Interrupted local step; safe to retry from the last durable checkpoint.',
        retryable: true,
        updatedAt: now,
      });
    }
  }
  return result;
}

function calendarDay(value) {
  return String(value ?? '').slice(0, 10);
}

export function remainingDailyAllowance(jobs, config, now = new Date().toISOString()) {
  const day = calendarDay(now);
  const cap = Number(config?.limits?.daily_successful_submissions ?? 0);
  const used = Object.values(jobs ?? {}).filter((job) =>
    job.state === STATES.APPLIED && calendarDay(job.appliedAt) === day).length;
  return Math.max(0, cap - used);
}

export function remainingRunAllowance(run) {
  const cap = Number(run?.maxSubmissionsPerRun ?? 0);
  if (cap <= 0) return Number.POSITIVE_INFINITY;
  const used = Number(run?.successfulSubmissionsThisRun ?? 0);
  return Math.max(0, cap - used);
}

export function companyCapReached(jobs, candidate, config, now = new Date().toISOString()) {
  const max = Number(config?.limits?.same_company_max ?? 0);
  const days = Number(config?.limits?.same_company_days ?? 0);
  if (max <= 0 || days <= 0) return false;
  const since = new Date(now).getTime() - days * 86_400_000;
  const key = companyKey(candidate.company);
  const count = Object.values(jobs ?? {}).filter((job) => {
    if (job.state !== STATES.APPLIED || companyKey(job.company) !== key || !job.appliedAt) return false;
    const time = new Date(job.appliedAt).getTime();
    return Number.isFinite(time) && time >= since;
  }).length;
  return count >= max;
}

export function resolveApprovedAnswer(question, config, { value } = {}) {
  const text = normalized(question);
  const anySalary = /\bsalary\b/.test(text);

  for (const entry of config?.approved_answers ?? []) {
    if ((entry.exact ?? []).some((phrase) => text === normalized(phrase))) {
      if (anySalary && value !== undefined && salaryAmount(value) !== salaryAmount(entry.value)) {
        return { classification: 'YELLOW', reason: 'salary-answer-not-approved' };
      }
      return { classification: 'GREEN', answerId: entry.id, value: entry.value };
    }
  }

  if (anySalary) {
    return { classification: 'YELLOW', reason: 'salary-wording-not-approved' };
  }

  const matches = (config?.approved_answers ?? []).flatMap((entry) =>
    (entry.match ?? [])
      .map((phrase) => normalized(phrase))
      .filter((phrase) => phrase && text.includes(phrase))
      .map((phrase) => ({ entry, specificity: phrase.length })));
  matches.sort((a, b) => b.specificity - a.specificity);
  if (matches[0]) {
    return { classification: 'GREEN', answerId: matches[0].entry.id, value: matches[0].entry.value };
  }

  return { classification: 'YELLOW', reason: 'unknown-question' };
}

export function routeJob(job, config, context = {}) {
  const duplicate = isDuplicate(job, context);
  if (duplicate.duplicate) return { decision: 'RED', reason: duplicate.reason };

  const title = normalized(job.role || job.title);
  if ((config?.targeting?.blocked_title_patterns ?? []).some((pattern) => title.includes(normalized(pattern)))) {
    return { decision: 'RED', reason: 'blocked-role-pattern' };
  }

  if (!Number.isFinite(Number(job.score))) return { decision: 'YELLOW', reason: 'evaluation-required' };
  if (Number(job.score) < Number(config?.targeting?.auto_apply_threshold ?? 70)) {
    return { decision: 'RED', reason: 'below-fit-threshold' };
  }
  if (job.closed === true) return { decision: 'RED', reason: 'closed-role' };
  if (job.cvQa === false) return { decision: 'YELLOW', reason: 'cv-qa-failed' };

  const answers = (job.questions ?? []).map((question) => ({
    question: typeof question === 'string' ? question : question.question,
    ...resolveApprovedAnswer(
      typeof question === 'string' ? question : question.question,
      config,
      typeof question === 'string' ? {} : { value: question.value },
    ),
  }));
  if (answers.some((answer) => answer.classification !== 'GREEN')) {
    return { decision: 'YELLOW', reason: 'question-needs-review', answers };
  }

  if (remainingDailyAllowance(context.jobs ?? {}, config, context.now) === 0) {
    return { decision: 'YELLOW', reason: 'daily-cap' };
  }
  if (companyCapReached(context.jobs ?? {}, job, config, context.now)) {
    return { decision: 'YELLOW', reason: 'same-company-cap' };
  }

  return { decision: 'GREEN', reason: 'all-policy-gates-pass', answers };
}

export function verifyCvTruth(sourceText, generatedText, config = {}) {
  const result = auditClaims(generatedText, sourceText, config);
  return { ok: result.invented.length === 0 && result.forbidden.length === 0, ...result };
}

export function applySubmissionResult(job, result, now = new Date().toISOString()) {
  if (result?.status === 'confirmed' && String(result.confirmation ?? '').trim()) {
    return {
      ...job,
      state: STATES.APPLIED,
      appliedAt: result.timestamp ?? now,
      confirmation: String(result.confirmation).trim(),
      submissionUncertain: false,
      retryable: false,
    };
  }
  if (result?.status === 'blocked') {
    return {
      ...job,
      state: STATES.BLOCKED_USER_ACTION,
      reason: result.reason ?? 'User action required',
      reasonCode: result.reasonCode ?? 'USER_ACTION_REQUIRED',
      checkpoint: result.checkpoint ?? job.checkpoint,
      submissionUncertain: false,
      retryable: false,
    };
  }
  if (result?.status === 'transient') {
    const attempts = Number(job.attempts ?? 0) + 1;
    const max = Number(result.maxAttempts ?? 2);
    return attempts <= max
      ? { ...job, state: STATES.RETRY, attempts, reason: result.reason ?? 'Transient failure', retryable: true }
      : { ...job, state: STATES.NEEDS_REVIEW, attempts, reason: 'Retry limit reached', retryable: false };
  }
  return {
    ...job,
    state: STATES.NEEDS_REVIEW,
    reason: 'Submission not explicitly confirmed; never retry Submit.',
    reasonCode: 'SUBMISSION_RESULT_UNCERTAIN',
    submissionUncertain: true,
    retryable: false,
  };
}

export function detectInterview(messages, jobs) {
  const matches = [];
  for (const message of messages ?? []) {
    const text = normalized(`${message.subject ?? ''} ${message.body ?? ''}`);
    if (!INTERVIEW_TERMS.some((term) => text.includes(normalized(term)))) continue;

    for (const [jobKey, job] of Object.entries(jobs ?? {})) {
      if (![STATES.APPLIED, STATES.FOLLOW_UP_DUE, STATES.INTERVIEW_DETECTED].includes(job.state)) continue;
      const company = companyKey(job.company);
      const companyTokens = company.split(' ').filter((token) => token.length >= 3);
      const roleTokens = normalized(job.role).split(' ').filter((token) => token.length >= 4);
      const companyMatch = companyTokens.some((token) => text.includes(token));
      const roleMatch = roleTokens.some((token) => text.includes(token));
      if (!companyMatch && !roleMatch) continue;
      matches.push({ jobKey, source: message.source ?? 'unknown', subject: message.subject ?? '', company: job.company, role: job.role });
      break;
    }
  }
  return { matches, pauseAutoSubmit: matches.length > 0 };
}
