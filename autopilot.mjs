#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import { isMainModule } from './lib/is-main-module.mjs';
import {
  BLOCK_REASON_CODES,
  STATES,
  applySubmissionResult,
  detectInterview,
  isDuplicate,
  recoverInterruptedJobs,
  remainingDailyAllowance,
  remainingRunAllowance,
  routeJob,
  stableJobId,
} from './lib/autopilot-core.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import {
  collectEvaluationShadow, ensureJevShadowInReport,
} from './jev-shadow-runner.mjs';
import { formatJevShadowMarkdown } from './jev-shadow.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const DEFAULT_CONFIG = join(DATA_ROOT, 'data', 'autopilot', 'config.yml');
const DEFAULT_STATE = join(DATA_ROOT, 'data', 'autopilot', 'state.json');
const DEFAULT_PIPELINE = join(DATA_ROOT, 'data', 'pipeline.md');
const DEFAULT_REPLY_CANDIDATES = join(DATA_ROOT, 'data', 'reply-candidates.json');
const DEFAULT_REPORT_DIR = join(DATA_ROOT, 'data', 'autopilot', 'reports');

function usage() {
  return [
    'Career Autopilot v1.1',
    '',
    'Usage:',
    '  node autopilot.mjs run [--dry-run] [--no-scan] [--resume|--new-run] [--jobs jobs.json]',
    '  node autopilot.mjs resume-job --job provider:id --json',
    '  node autopilot.mjs status',
    '  node autopilot.mjs pause [--reason text]',
    '  node autopilot.mjs resume',
    '  node autopilot.mjs auto-submit enable|disable',
    '  node autopilot.mjs cycle-check',
    '  node autopilot.mjs prepare-evaluation --job provider:id --jd-file path',
    '  node autopilot.mjs record-evaluation --job provider:id --score 0..100 [--evidence path]',
    '  node autopilot.mjs record-cv --job provider:id --source path --pdf path --qa pass|fail',
    '  node autopilot.mjs record-questions --job provider:id --input questions.json',
    '  node autopilot.mjs begin-application --job provider:id',
    '  node autopilot.mjs block-application --job provider:id --reason-code CODE --step STEP [--application-url URL] [--answers answers.json]',
    '  node autopilot.mjs resume-application --job provider:id',
    '  node autopilot.mjs submission-result --job provider:id --status confirmed|uncertain|blocked|transient [--confirmation text]',
    '  node autopilot.mjs resolve-uncertain --job provider:id --outcome not-submitted|submitted --confirmation text',
    '  node autopilot.mjs tracker-recorded --job provider:id [--tracker-row number]',
    '  node autopilot.mjs finish-run',
    '  node autopilot.mjs review',
    '',
    'Common overrides: --config path --state path --pipeline path --tracker path --reply-candidates path --report-dir path --now ISO',
  ].join('\n');
}

function parseArgs(argv) {
  const [command = 'run', ...rest] = argv;
  const options = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (['dry-run', 'no-scan', 'json', 'closed', 'resume', 'new-run'].includes(name)) {
      options[name] = true;
      continue;
    }
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[name] = value;
    i += 1;
  }
  return { command, options, positional };
}

function readYaml(path) {
  if (!existsSync(path)) throw new Error(`Autopilot config not found: ${path}`);
  const value = loadYaml(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error(`Autopilot config must be a YAML object: ${path}`);
  return value;
}

function initialState(config) {
  return {
    version: 1,
    mode: config?.auto_submit?.enabled ? 'ENABLED' : 'DISABLED',
    resumeMode: config?.auto_submit?.enabled ? 'ENABLED' : 'DISABLED',
    pauseReason: '',
    jobs: {},
    runs: {},
    activeRunId: null,
    runLock: null,
    lastRun: null,
  };
}

function readState(path, config) {
  if (!existsSync(path)) return initialState(config);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.version !== 1 || !state.jobs || typeof state.jobs !== 'object') {
    throw new Error(`Unsupported or corrupt Autopilot state: ${path}`);
  }
  state.runs ??= {};
  state.activeRunId ??= null;
  state.runLock ??= null;
  return state;
}

function createRun(config, now) {
  const runId = randomUUID();
  return {
    runId,
    startedAt: now,
    activeStartedAt: now,
    activeFinishedAt: null,
    activeLastHeartbeatAt: now,
    activeDurationMs: 0,
    totalLogicalDurationMs: 0,
    maxActiveCycleMinutes: Number(config?.limits?.max_active_cycle_minutes ?? 45),
    maxSubmissionsPerRun: Number(config?.limits?.per_run_successful_submissions ?? 0),
    successfulSubmissionsThisRun: 0,
    submittedJobIdsThisRun: [],
    resumedAt: [],
    status: 'ACTIVE',
    jobsScanned: 0,
    newJobs: 0,
    duplicates: 0,
    evaluated: 0,
    newlyNeedsReviewJobIdsThisRun: [],
    existingNeedsReviewJobIdsThisRun: [],
    shortlisted: 0,
    followups: 0,
    scanErrors: [],
  };
}

function currentRun(state) {
  return state.activeRunId ? state.runs[state.activeRunId] ?? null : null;
}

function hasUncertainSubmission(state) {
  return Object.values(state.jobs).some((job) =>
    job.state === STATES.APPLICATION_IN_PROGRESS || job.submissionUncertain === true);
}

function runLockAgeMs(lock, now) {
  return new Date(now).getTime() - new Date(lock?.heartbeatAt ?? lock?.acquiredAt).getTime();
}

function accrueActiveTime(run, now, idleMs) {
  run.activeStartedAt ??= run.startedAt ?? now;
  run.activeDurationMs = Number(run.activeDurationMs ?? 0);
  const previous = new Date(run.activeLastHeartbeatAt ?? run.activeStartedAt).getTime();
  const elapsed = Math.max(0, new Date(now).getTime() - previous);
  if (elapsed <= idleMs) run.activeDurationMs += elapsed;
  run.activeLastHeartbeatAt = now;
  return run.activeDurationMs;
}

function activeBudgetReached(run) {
  return Number(run.activeDurationMs ?? 0) >= Number(run.maxActiveCycleMinutes ?? 45) * 60_000;
}

function finishActiveCycle(run, now, status = run.status) {
  run.status = status;
  run.activeFinishedAt = now;
  run.finishedAt = now;
  run.totalLogicalDurationMs = Math.max(0, new Date(now).getTime() - new Date(run.startedAt).getTime());
}

function reviewFingerprint(job) {
  return createHash('sha256').update(JSON.stringify({
    reason: job.reason ?? '',
    questions: job.questions ?? [],
    evidence: job.evaluationEvidence ?? '',
  })).digest('hex').slice(0, 16);
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

function appendEvents(statePath, events) {
  if (!events.length) return;
  const path = join(dirname(statePath), 'events.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
}

function transition(state, key, nextState, reason, now, events, patch = {}) {
  const before = state.jobs[key]?.state ?? null;
  state.jobs[key] = { ...state.jobs[key], ...patch, state: nextState, reason, updatedAt: now };
  if (nextState === STATES.NEEDS_REVIEW) {
    state.jobs[key].reviewFingerprint = reviewFingerprint(state.jobs[key]);
  }
  if (before !== nextState || reason !== state.jobs[key].lastEventReason) {
    events.push({ timestamp: now, jobKey: key, from: before, to: nextState, reason });
  }
  state.jobs[key].lastEventReason = reason;
}

export function parsePipeline(text) {
  const jobs = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const hit = /^-\s+\[\s\]\s+(https?:\/\/\S+)\s+\|\s+([^|]+)\|\s+([^|]+)(?:\|\s+([^|]+))?/.exec(line);
    if (!hit) continue;
    const url = hit[1].trim();
    jobs.push({
      provider: url.includes('jobsdb.com') ? 'jobsdb' : new URL(url).hostname,
      url,
      company: hit[2].trim(),
      role: hit[3].trim(),
      location: hit[4]?.trim() ?? '',
    });
  }
  return jobs;
}

export function parseTracker(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const notes = cells[8] ?? '';
    const id = /(?:JobsDB|Jobstreet)\s+Job ID:\s*(\d+)/i.exec(notes)?.[1] ?? '';
    rows.push({
      number: cells[0],
      date: cells[1],
      company: cells[2],
      role: cells[3],
      score: cells[4],
      status: cells[5],
      notes,
      provider: id ? 'jobsdb' : '',
      jobId: id,
    });
  }
  return rows;
}

function readJsonArray(path) {
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(value)) return value;
  for (const key of ['candidates', 'messages', 'items']) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

function loadJobsFile(path) {
  if (!path) return [];
  const value = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!Array.isArray(value)) throw new Error('--jobs must contain a JSON array');
  return value;
}

function runScan(config, dryRun) {
  if (config?.scan?.enabled === false) return { skipped: true, count: 0 };
  const args = [join(CODE_ROOT, 'scan.mjs')];
  if (dryRun) args.push('--dry-run');
  args.push('--json', '--quiet', ...(config?.scan?.args ?? []));
  const result = spawnSync(process.execPath, args, {
    cwd: CODE_ROOT,
    encoding: 'utf8',
    timeout: Number(config?.scan?.timeout_ms ?? 120000),
  });
  if (result.error || result.status !== 0) {
    return { error: result.error?.message ?? result.stderr.trim() ?? `scan exited ${result.status}`, count: 0 };
  }
  const receiptLine = result.stdout.trim().split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{'));
  if (!receiptLine) return { error: 'scan produced no machine-readable receipt', receipt: null, count: 0 };
  try {
    const receipt = JSON.parse(receiptLine);
    const sourceErrors = Array.isArray(receipt.errors) ? receipt.errors : [];
    return {
      receipt,
      count: Number(receipt.found ?? receipt.new ?? receipt.new_jobs ?? receipt.added ?? 0),
      error: sourceErrors.length ? sourceErrors.length + ' scan source(s) failed' : null,
    };
  } catch {
    return { error: 'scan receipt was invalid JSON', receipt: null, count: 0 };
  }
}

function prepareJobs(state, discovered, tracker, now, events) {
  let newJobs = 0;
  let duplicates = 0;
  for (const job of discovered) {
    const key = stableJobId(job);
    if (state.jobs[key]) continue;
    const duplicate = isDuplicate(job, { tracker, jobs: state.jobs });
    if (duplicate.duplicate) {
      const trackerRow = tracker.find((row) => stableJobId(row) === key);
      if (trackerRow?.status?.toLowerCase() === 'applied') {
        transition(state, key, STATES.APPLIED, duplicate.reason, now, events, {
          ...job,
          decision: 'RED',
          appliedAt: `${trackerRow.date}T00:00:00`,
          importedApplied: true,
          trackerRow: trackerRow.number,
        });
      } else {
        transition(state, key, STATES.SKIPPED, duplicate.reason, now, events, { ...job, decision: 'RED' });
      }
      duplicates += 1;
    } else {
      transition(state, key, STATES.DISCOVERED, 'new-job', now, events, { ...job, discoveredAt: now });
      newJobs += 1;
    }
  }
  return { newJobs, duplicates };
}

function applyEvaluationPolicy(state, config, tracker, now, events) {
  let evaluated = 0;
  let shortlisted = 0;
  for (const [key, job] of Object.entries(state.jobs)) {
    if (![STATES.DISCOVERED, STATES.RETRY, STATES.EVALUATED, STATES.SHORTLISTED, STATES.READY_TO_APPLY].includes(job.state)) continue;
    const outcome = routeJob(job, config, { tracker, jobs: state.jobs, now });
    job.decision = outcome.decision;
    job.policyReason = outcome.reason;
    job.approvedAnswers = outcome.answers ?? [];

    if (outcome.reason === 'evaluation-required') {
      transition(state, key, STATES.NEEDS_REVIEW, 'Evaluation required: run the career-ops A-G evaluator.', now, events);
      continue;
    }
    evaluated += 1;
    if (outcome.decision === 'RED') {
      transition(state, key, STATES.SKIPPED, outcome.reason, now, events);
    } else if (outcome.decision === 'YELLOW') {
      transition(state, key, STATES.NEEDS_REVIEW, outcome.reason, now, events);
    } else if (!job.cvPdf || job.cvQa !== true) {
      transition(state, key, STATES.SHORTLISTED, 'GREEN; tailored CV generation and QA required.', now, events);
      shortlisted += 1;
    } else {
      transition(state, key, STATES.READY_TO_APPLY, 'All pre-application policy gates pass.', now, events);
      shortlisted += 1;
    }
  }
  return { evaluated, shortlisted };
}

function processInterviewWatch(state, messages, now, events) {
  const result = detectInterview(messages, state.jobs);
  for (const match of result.matches) {
    transition(state, match.jobKey, STATES.INTERVIEW_DETECTED, `Interview signal: ${match.subject || match.source}`, now, events, {
      interviewSource: match.source,
      interviewSubject: match.subject,
    });
  }
  if (result.pauseAutoSubmit && state.mode !== 'PAUSED') {
    state.resumeMode = state.mode;
    state.mode = 'PAUSED';
    state.pauseReason = 'Credible interview signal detected';
  }
  return result;
}

function markFollowups(state, config, now, events) {
  const dueAfterDays = Number(config?.follow_up?.days_after_application ?? 7);
  const nowMs = new Date(now).getTime();
  let due = 0;
  for (const [key, job] of Object.entries(state.jobs)) {
    if (job.state !== STATES.APPLIED || !job.appliedAt) continue;
    const dueAt = new Date(new Date(job.appliedAt).getTime() + dueAfterDays * 86_400_000);
    job.followUpAt = dueAt.toISOString();
    if (dueAt.getTime() <= nowMs) {
      transition(state, key, STATES.FOLLOW_UP_DUE, 'Follow-up due; draft only, do not send automatically.', now, events);
      due += 1;
    }
  }
  return due;
}

function counts(state, run, config, now) {
  const values = Object.values(state.jobs);
  const blockedReasonCodes = [...new Set(values
    .filter((job) => job.state === STATES.BLOCKED_USER_ACTION)
    .map((job) => job.reasonCode ?? 'USER_ACTION_REQUIRED'))];
  const interviewPause = state.mode === 'PAUSED' && (
    /interview/i.test(state.pauseReason) || values.some((job) => job.state === STATES.INTERVIEW_DETECTED));
  return {
    scanned: run.jobsScanned,
    jobs_scanned: run.jobsScanned,
    new: run.newJobs,
    new_jobs: run.newJobs,
    duplicates: run.duplicates,
    skipped: values.filter((job) => job.state === STATES.SKIPPED).length,
    NEEDS_REVIEW: values.filter((job) => job.state === STATES.NEEDS_REVIEW).length,
    newly_evaluated: run.evaluated,
    newly_needs_review: (run.newlyNeedsReviewJobIdsThisRun ?? []).length,
    existing_needs_review_seen: (run.existingNeedsReviewJobIdsThisRun ?? []).length,
    total_needs_review: values.filter((job) => job.state === STATES.NEEDS_REVIEW).length,
    BLOCKED_USER_ACTION: values.filter((job) => job.state === STATES.BLOCKED_USER_ACTION).length,
    READY_TO_APPLY: values.filter((job) => job.state === STATES.READY_TO_APPLY).length,
    successfully_submitted: run.successfulSubmissionsThisRun,
    daily_remaining_allowance: remainingDailyAllowance(state.jobs, config, now),
    per_run_remaining_allowance: remainingRunAllowance(run),
    active_run_id: run.runId,
    run_status: run.status,
    active_started_at: run.activeStartedAt ?? null,
    active_finished_at: run.activeFinishedAt ?? null,
    active_duration_ms: Number(run.activeDurationMs ?? 0),
    total_logical_duration_ms: Number(run.totalLogicalDurationMs ?? 0),
    active_budget_reached: activeBudgetReached(run),
    paused: state.mode === 'PAUSED',
    interview_pause: interviewPause,
    blocked_reason_codes: blockedReasonCodes,
  };
}

function reportMarkdown(summary, state, scan, run) {
  const lines = [
    '# Career Autopilot v1.1 Run',
    '',
    `- Run ID: ${run.runId}`,
    `- Original start: ${run.startedAt}`,
    `- Run status: ${run.status}`,
    `- Mode: ${state.mode}`,
    `- Pause reason: ${state.pauseReason || '-'}`,
    `- Scan: ${scan.error ? `failed (${scan.error})` : scan.skipped ? 'skipped' : 'completed'}`,
    '',
    '| Metric | Count |',
    '|---|---:|',
    ...Object.entries(summary).map(([key, value]) =>
      `| ${key.replaceAll('_', ' ')} | ${Array.isArray(value) ? value.join(', ') || '-' : value} |`),
  ];
  const review = Object.entries(state.jobs).filter(([, job]) =>
    [STATES.NEEDS_REVIEW, STATES.BLOCKED_USER_ACTION, STATES.INTERVIEW_DETECTED].includes(job.state));
  if (review.length) {
    lines.push('', '## Review queue', '');
    for (const [key, job] of review) {
      const questions = (job.questions ?? []).map((question) =>
        typeof question === 'string' ? question : question.question).filter(Boolean).join('; ') || '-';
      lines.push(`- ${key} - ${job.company} - ${job.role}: ${job.state}`);
      lines.push(`  - Reason: ${job.reasonCode ? `${job.reasonCode}: ` : ''}${job.reason}`);
      lines.push(`  - Questions: ${questions}`);
      lines.push(`  - Evidence: ${job.evaluationEvidence || '-'}`);
    }
  }
  return lines.join('\n') + '\n';
}

function validateCvArtifacts(sourcePath, pdfPath) {
  const source = resolve(sourcePath);
  const pdf = resolve(pdfPath);
  if (!existsSync(source) || !existsSync(pdf)) {
    return { passed: false, reason: 'CV source or PDF artifact is missing.' };
  }
  const pdfHeader = readFileSync(pdf).subarray(0, 5).toString('ascii');
  if (pdfHeader !== '%PDF-') return { passed: false, reason: 'PDF artifact has no PDF header.' };

  const facts = spawnSync(process.execPath, [join(CODE_ROOT, 'verify-cv-facts.mjs'), source, '--json'], {
    cwd: CODE_ROOT, encoding: 'utf8', timeout: 30000,
  });
  if (facts.status !== 0) {
    return { passed: false, reason: 'CV factual QA failed.', detail: facts.stdout || facts.stderr };
  }

  const ats = spawnSync(process.execPath, [join(CODE_ROOT, 'verify-ats.mjs'), source, '--json'], {
    cwd: CODE_ROOT, encoding: 'utf8', timeout: 30000,
  });
  if (ats.status !== 0) {
    return { passed: false, reason: 'CV ATS QA failed.', detail: ats.stdout || ats.stderr };
  }
  return { passed: true, source, pdf };
}

function pendingActions(state, run) {
  const actions = Object.entries(state.jobs).flatMap(([jobKey, job]) => {
    if (job.state === STATES.SHORTLISTED) return [{ jobKey, action: 'generate-and-qa-cv' }];
    if (job.state === STATES.READY_TO_APPLY) {
      if (state.mode !== 'ENABLED') return [{ jobKey, action: 'wait-auto-submit-disabled' }];
      if (remainingRunAllowance(state.runs[job.runId] ?? run) === 0) return [{ jobKey, action: 'wait-per-run-cap' }];
      return [{
        jobKey,
        action: job.resumeCheckpoint ? 'resume-application-from-checkpoint' : 'apply-with-computer-use',
        checkpoint: job.resumeCheckpoint ?? null,
        final_confirmation_required: false,
      }];
    }
    if (job.state === STATES.INTERVIEW_DETECTED) return [{ jobKey, action: 'generate-interview-prep' }];
    if (job.state === STATES.APPLIED && job.trackerPending) return [{ jobKey, action: 'record-confirmed-application-in-tracker' }];
    return [];
  });
  const priority = {
    'resume-application-from-checkpoint': 0,
    'apply-with-computer-use': 0,
    'generate-interview-prep': 1,
    'record-confirmed-application-in-tracker': 2,
    'generate-and-qa-cv': 3,
  };
  return actions.sort((a, b) => (priority[a.action] ?? 4) - (priority[b.action] ?? 4));
}
async function mutateState(paths, config, fn) {
  return withPipelineLock(paths.state, async () => {
    const state = readState(paths.state, config);
    const events = [];
    const result = await fn(state, events);
    atomicWriteJson(paths.state, state);
    appendEvents(paths.state, events);
    return result;
  });
}

function pathsFrom(options) {
  return {
    config: resolve(options.config ?? DEFAULT_CONFIG),
    state: resolve(options.state ?? DEFAULT_STATE),
    pipeline: resolve(options.pipeline ?? DEFAULT_PIPELINE),
    tracker: resolve(options.tracker ?? resolveTrackerPath(DATA_ROOT)),
    replyCandidates: resolve(options['reply-candidates'] ?? DEFAULT_REPLY_CANDIDATES),
    reportDir: resolve(options['report-dir'] ?? DEFAULT_REPORT_DIR),
  };
}

async function runCommand(options) {
  const paths = pathsFrom(options);
  const config = readYaml(paths.config);
  const now = options.now ?? new Date().toISOString();
  const dryRun = options['dry-run'] === true;
  const staleMs = Math.max(5, Number(config?.limits?.run_lock_stale_minutes ?? 30)) * 60_000;
  if (!dryRun && existsSync(paths.state)) {
    const state = readState(paths.state, config);
    if (state.runLock && runLockAgeMs(state.runLock, now) < staleMs) {
      const output = {
        locked: true,
        reason: 'ACTIVE_RUN_LOCK',
        runId: state.runLock.runId,
        acquiredAt: state.runLock.acquiredAt,
      };
      console.log(JSON.stringify(output));
      return output;
    }
  }

  const tracker = existsSync(paths.tracker) ? parseTracker(readFileSync(paths.tracker, 'utf8')) : [];
  const previousState = existsSync(paths.state) ? readState(paths.state, config) : null;
  const applicationFirst = config?.execution?.mode === 'APPLICATION_FIRST_INTERVIEW_FIRST';
  const executableReady = applicationFirst && previousState?.mode === 'ENABLED'
    && !hasUncertainSubmission(previousState)
    && remainingDailyAllowance(previousState.jobs, config, now) > 0
    && !Object.values(previousState.jobs).some((job) => job.state === STATES.INTERVIEW_DETECTED)
    && Object.values(previousState.jobs).some((job) =>
      job.state === STATES.READY_TO_APPLY && job.cvQa === true
      && job.cvPdf && existsSync(job.cvPdf)
      && routeJob(job, config, { tracker, jobs: previousState.jobs, now }).decision === 'GREEN');
  const scan = options['no-scan'] || executableReady
    ? { skipped: true, count: 0 } : runScan(config, dryRun);
  const pipelineJobs = !executableReady && existsSync(paths.pipeline)
    ? parsePipeline(readFileSync(paths.pipeline, 'utf8')) : [];
  const fixtureJobs = executableReady ? [] : loadJobsFile(options.jobs);
  const messages = readJsonArray(paths.replyCandidates);

  const execute = async (state, events) => {
    if (!dryRun && state.runLock) {
      if (runLockAgeMs(state.runLock, now) < staleMs) {
        return { locked: true, reason: 'ACTIVE_RUN_LOCK', state, run: currentRun(state) };
      }
      if (hasUncertainSubmission(state)) {
        return { locked: true, reason: 'UNCERTAIN_PREVIOUS_SUBMISSION', state, run: currentRun(state) };
      }
      const recoveredRun = state.runs[state.runLock.runId];
      if (recoveredRun) {
        accrueActiveTime(recoveredRun, state.runLock.heartbeatAt ?? now, staleMs);
        recoveredRun.activeFinishedAt = state.runLock.heartbeatAt ?? now;
        recoveredRun.staleLockRecoveredAt = now;
      }
      state.runLock = null;
    }
    if (!dryRun && hasUncertainSubmission(state)) {
      return { locked: true, reason: 'UNCERTAIN_PREVIOUS_SUBMISSION', state, run: currentRun(state) };
    }

    let run = options.resume
      ? state.runs[state.lastRun?.runId] ?? state.lastRun
      : currentRun(state);
    const resumable = run && ['ACTIVE', 'PAUSED', 'BLOCKED', 'CAP_REACHED'].includes(run.status);
    if (options['new-run'] || (!options.resume && !resumable)) run = null;
    if (options.resume && !run) throw new Error('No logical run is available to resume');
    if (!run) {
      run = createRun(config, now);
      state.runs[run.runId] = run;
    } else {
      run.resumedAt ??= [];
      run.resumedAt.push(now);
      state.runs[run.runId] = run;
      run.status = 'ACTIVE';
      run.activeStartedAt ??= now;
      run.activeFinishedAt = null;
      run.activeLastHeartbeatAt = now;
    }
    state.activeRunId = run.runId;
    state.lastRun = run;
    if (!dryRun) {
      state.runLock = {
        lockId: randomUUID(), runId: run.runId, acquiredAt: now, heartbeatAt: now, status: 'ACTIVE',
      };
    }

    const existingReviewKeys = new Set(Object.entries(state.jobs)
      .filter(([, job]) => job.state === STATES.NEEDS_REVIEW).map(([jobKey]) => jobKey));
    const beforeRecovery = structuredClone(state.jobs);
    state.jobs = recoverInterruptedJobs(state.jobs, now);
    for (const [jobKey, job] of Object.entries(state.jobs)) {
      const before = beforeRecovery[jobKey]?.state;
      if (before && before !== job.state) {
        events.push({ timestamp: now, jobKey, from: before, to: job.state, reason: job.reason });
      }
    }
    const prepared = executableReady ? { newJobs: 0, duplicates: 0 }
      : prepareJobs(state, [...pipelineJobs, ...fixtureJobs], tracker, now, events);
    processInterviewWatch(state, messages, now, events);
    if (Object.values(state.jobs).some((job) => job.state === STATES.INTERVIEW_DETECTED)
      && config?.interview_watch?.pause_auto_submit !== false) {
      if (state.mode !== 'PAUSED') state.resumeMode = state.mode;
      state.mode = 'PAUSED';
      state.pauseReason = 'Credible interview signal detected';
    }
    const policy = executableReady ? { evaluated: 0, shortlisted: 0 }
      : applyEvaluationPolicy(state, config, tracker, now, events);
    const followups = markFollowups(state, config, now, events);
    run.dryRun = dryRun;
    run.jobsScanned += scan.count || pipelineJobs.length;
    run.newJobs += prepared.newJobs;
    run.duplicates += prepared.duplicates;
    run.evaluated += policy.evaluated;
    run.shortlisted += policy.shortlisted;
    run.followups += followups;
    if (scan.error) run.scanErrors.push(scan.error);

    run.newlyNeedsReviewJobIdsThisRun ??= [];
    run.existingNeedsReviewJobIdsThisRun ??= [];
    const newlySeen = new Set(run.newlyNeedsReviewJobIdsThisRun);
    const existingSeen = new Set(run.existingNeedsReviewJobIdsThisRun);
    for (const [jobKey, job] of Object.entries(state.jobs)) {
      if (job.state !== STATES.NEEDS_REVIEW) continue;
      if (existingReviewKeys.has(jobKey) && !newlySeen.has(jobKey)) existingSeen.add(jobKey);
      else newlySeen.add(jobKey);
    }
    run.newlyNeedsReviewJobIdsThisRun = [...newlySeen];
    run.existingNeedsReviewJobIdsThisRun = [...existingSeen];

    for (const job of Object.values(state.jobs)) {
      if ([STATES.SHORTLISTED, STATES.READY_TO_APPLY].includes(job.state) && job.runId !== run.runId) job.runId = run.runId;
      if (job.state === STATES.NEEDS_REVIEW && !job.reviewFingerprint) {
        job.reviewFingerprint = reviewFingerprint(job);
      }
    }
    const freshReviewKeys = Object.entries(state.jobs)
      .filter(([, job]) => job.state === STATES.NEEDS_REVIEW
        && job.reviewNotifiedFingerprint !== job.reviewFingerprint)
      .map(([jobKey]) => jobKey);

    let actions = pendingActions(state, run);
    const activeNow = options.now ?? new Date().toISOString();
    accrueActiveTime(run, activeNow, staleMs);
    if (activeBudgetReached(run)) actions = [];
    const canProduceApplication = state.mode === 'ENABLED' && actions.some(({ action }) =>
      ['generate-and-qa-cv', 'apply-with-computer-use', 'resume-application-from-checkpoint'].includes(action));
    run.status = activeBudgetReached(run) ? 'BUDGET_REACHED'
      : state.mode === 'PAUSED' ? 'PAUSED'
        : remainingRunAllowance(run) === 0 ? 'CAP_REACHED'
        : canProduceApplication ? 'ACTIVE' : 'COMPLETE';
    if (!canProduceApplication) finishActiveCycle(run, activeNow, run.status);
    const summary = counts(state, run, config, now);
    run.summary = summary;
    if (!dryRun) {
      for (const jobKey of freshReviewKeys) {
        state.jobs[jobKey].reviewNotifiedFingerprint = state.jobs[jobKey].reviewFingerprint;
        state.jobs[jobKey].reviewNotifiedAt = now;
      }
      if (!canProduceApplication) state.runLock = null;
    }
    return { state, run, summary, actions, freshReviewKeys };
  };

  let result;
  if (dryRun) {
    result = await execute(structuredClone(readState(paths.state, config)), []);
  } else {
    result = await mutateState(paths, config, execute);
    if (result.locked) {
      const output = { locked: true, reason: result.reason, runId: result.run?.runId ?? null };
      console.log(JSON.stringify(output));
      return output;
    }
    const stamp = now.replace(/[:.]/g, '-');
    mkdirSync(paths.reportDir, { recursive: true });
    atomicWriteJson(join(paths.reportDir, `${stamp}.json`), result.summary);
    writeFileSync(join(paths.reportDir, `${stamp}.md`), reportMarkdown(result.summary, result.state, scan, result.run), 'utf8');
  }

  const output = {
    dry_run: dryRun,
    mode: result.state.mode,
    run: result.run,
    summary: result.summary,
    scan: { error: scan.error ?? null, receipt: scan.receipt ?? null },
    actions: result.actions,
    attention: Object.entries(result.state.jobs)
      .filter(([jobKey, job]) => result.freshReviewKeys.includes(jobKey)
        || [STATES.BLOCKED_USER_ACTION, STATES.INTERVIEW_DETECTED].includes(job.state))
      .map(([jobKey, job]) => ({
        jobKey, state: job.state, company: job.company, role: job.role,
        reason: job.reason, reasonCode: job.reasonCode ?? null,
        questions: job.questions ?? [], evidence: job.evaluationEvidence ?? '',
      })),
  };
  console.log(options.json ? JSON.stringify(output) : reportMarkdown(result.summary, result.state, scan, result.run));
  return output;
}

async function resumeJobCommand(options) {
  const paths = pathsFrom(options);
  const config = readYaml(paths.config);
  const now = options.now ?? new Date().toISOString();
  const key = options.job;
  if (!key) throw new Error('resume-job requires --job provider:id');
  const tracker = existsSync(paths.tracker) ? parseTracker(readFileSync(paths.tracker, 'utf8')) : [];
  const result = await mutateState(paths, config, async (state) => {
    if (state.runLock) throw new Error('resume-job requires no active runLock');
    if (hasUncertainSubmission(state)) throw new Error('resume-job blocked by an uncertain submission');
    if (state.mode !== 'ENABLED' || config?.auto_submit?.enabled !== true) {
      throw new Error('resume-job requires auto-submit ENABLED');
    }
    if (Object.values(state.jobs).some((job) => job.state === STATES.INTERVIEW_DETECTED)) {
      throw new Error('resume-job blocked by interview pause');
    }
    const job = state.jobs[key];
    if (!job || job.state !== STATES.READY_TO_APPLY) {
      throw new Error('resume-job requires an existing READY_TO_APPLY job');
    }
    if (job.decision !== 'GREEN' || job.cvQa !== true || job.profileChangePending
      || !job.cvPdf || !existsSync(job.cvPdf) || !basename(job.cvPdf).includes(key.split(':').at(-1))) {
      throw new Error('resume-job requires GREEN, verified profile and the recorded QA-passed CV');
    }
    const outcome = routeJob(job, config, { tracker, jobs: state.jobs, now });
    if (outcome.decision !== 'GREEN' || !outcome.answers?.every((answer) => answer.classification === 'GREEN')) {
      throw new Error(`resume-job policy gate failed: ${outcome.reason}`);
    }
    const run = state.runs[job.runId];
    if (!run || remainingRunAllowance(run) === 0 || activeBudgetReached(run)) {
      throw new Error('resume-job requires an existing run with remaining allowance and active time');
    }
    run.resumedAt ??= [];
    run.resumedAt.push(now);
    run.status = 'ACTIVE';
    run.activeFinishedAt = null;
    run.activeLastHeartbeatAt = now;
    state.activeRunId = run.runId;
    state.lastRun = run;
    state.runLock = {
      lockId: randomUUID(), runId: run.runId, jobScope: key,
      acquiredAt: now, heartbeatAt: now, status: 'ACTIVE',
    };
    state.lastControlAt = now;
    return {
      runId: run.runId,
      runLock: state.runLock,
      actions: [{ jobKey: key, action: job.resumeCheckpoint
        ? 'resume-application-from-checkpoint' : 'apply-with-computer-use',
      }],
      daily_remaining_allowance: remainingDailyAllowance(state.jobs, config, now),
      per_run_remaining_allowance: remainingRunAllowance(run),
    };
  });
  console.log(JSON.stringify(result));
  return result;
}

async function controlCommand(command, options, positional) {
  const paths = pathsFrom(options);
  const config = readYaml(paths.config);
  const now = options.now ?? new Date().toISOString();
  const staleMs = Math.max(5, Number(config?.limits?.run_lock_stale_minutes ?? 30)) * 60_000;
  const tracker = existsSync(paths.tracker) ? parseTracker(readFileSync(paths.tracker, 'utf8')) : [];

  if (command === 'status') {
    console.log(JSON.stringify(readState(paths.state, config), null, 2));
    return;
  }
  if (command === 'review') {
    const state = readState(paths.state, config);
    const queue = Object.entries(state.jobs)
      .filter(([, job]) => job.state === STATES.NEEDS_REVIEW)
      .map(([jobKey, job]) => ({
        jobKey, company: job.company, role: job.role, reason: job.reason,
        questions: job.questions ?? [], evidence: job.evaluationEvidence ?? '',
      }));
    console.log(JSON.stringify(queue, null, 2));
    return queue;
  }

  const result = await mutateState(paths, config, async (state, events) => {
    if (state.runLock?.jobScope && !['cycle-check', 'finish-run'].includes(command)
      && options.job !== state.runLock.jobScope) {
      throw new Error(`active runLock is scoped to ${state.runLock.jobScope}`);
    }
    const activeRun = currentRun(state);
    if (activeRun && state.runLock?.runId === activeRun.runId) accrueActiveTime(activeRun, now, staleMs);
    let commandResult = null;
    if (command === 'pause') {
      if (state.mode !== 'PAUSED') state.resumeMode = state.mode;
      state.mode = 'PAUSED';
      state.pauseReason = options.reason ?? 'Paused manually';
    } else if (command === 'resume') {
      if (Object.values(state.jobs).some((job) => job.state === STATES.INTERVIEW_DETECTED)) {
        throw new Error('interview pause is active; resolve it before resuming submissions');
      }
      state.mode = state.resumeMode || (config?.auto_submit?.enabled ? 'ENABLED' : 'DISABLED');
      state.pauseReason = '';
    } else if (command === 'auto-submit') {
      const setting = positional[0];
      if (!['enable', 'disable'].includes(setting)) throw new Error('auto-submit expects enable or disable');
      const interviewPause = Object.values(state.jobs).some((job) => job.state === STATES.INTERVIEW_DETECTED);
      state.resumeMode = setting === 'enable' ? 'ENABLED' : 'DISABLED';
      state.mode = setting === 'enable' && interviewPause ? 'PAUSED' : state.resumeMode;
      state.pauseReason = interviewPause ? 'Credible interview signal detected' : '';
    } else if (command === 'cycle-check') {
      const run = currentRun(state);
      if (!run || !state.runLock || state.runLock.runId !== run.runId) {
        commandResult = { active: false, budget_reached: false, runId: run?.runId ?? null };
      } else if (activeBudgetReached(run) && !hasUncertainSubmission(state)) {
        finishActiveCycle(run, now, 'BUDGET_REACHED');
        state.runLock = null;
        commandResult = { active: false, budget_reached: true, runId: run.runId,
          active_duration_ms: run.activeDurationMs };
      } else {
        commandResult = { active: true, budget_reached: activeBudgetReached(run), runId: run.runId,
          active_duration_ms: run.activeDurationMs,
          remaining_ms: Math.max(0, run.maxActiveCycleMinutes * 60_000 - run.activeDurationMs) };
      }
    } else if (command === 'finish-run') {
      if (hasUncertainSubmission(state) && !state.runLock?.jobScope) {
        throw new Error('cannot finish run while a submission result is uncertain');
      }
      const run = currentRun(state);
      if (run && (!run.finishedAt || state.runLock?.runId === run.runId)) {
        const ready = Object.values(state.jobs).some((job) =>
          job.runId === run.runId && [STATES.SHORTLISTED, STATES.READY_TO_APPLY].includes(job.state)
          && (!state.runLock?.jobScope || state.jobs[state.runLock.jobScope] === job));
        run.status = remainingRunAllowance(run) === 0 ? 'CAP_REACHED'
          : state.mode === 'ENABLED' && ready ? 'ACTIVE' : state.mode === 'PAUSED' ? 'PAUSED' : 'COMPLETE';
        finishActiveCycle(run, now, run.status);
      }
      state.runLock = null;
    } else {
      const key = options.job;
      if (!key || !state.jobs[key]) throw new Error(`Unknown --job: ${key ?? '(missing)'}`);
      if (command === 'record-evaluation') {
        const score = Number(options.score);
        if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error('--score must be 0..100');
        if (options.evidence && existsSync(resolve(options.evidence))) {
          try {
            await ensureJevShadowInReport(resolve(options.evidence), {
              company: state.jobs[key].company,
              title: state.jobs[key].role,
              source_url: state.jobs[key].url,
            });
          } catch {
            // Shadow failure must not block the existing Autopilot transition.
          }
        }
        transition(state, key, STATES.EVALUATED, 'Evaluation recorded.', now, events, {
          score, evaluationEvidence: options.evidence ?? '', closed: options.closed === true,
        });
      } else if (command === 'record-questions') {
        if (!options.input) throw new Error('record-questions requires --input questions.json');
        const questions = JSON.parse(readFileSync(resolve(options.input), 'utf8'));
        if (!Array.isArray(questions)) throw new Error('questions input must be a JSON array');
        state.jobs[key].questions = questions;
        const outcome = routeJob(state.jobs[key], config, { tracker: [], jobs: state.jobs, now });
        const next = outcome.decision === 'GREEN' && state.jobs[key].cvQa === true
          ? STATES.READY_TO_APPLY : STATES.NEEDS_REVIEW;
        transition(state, key, next, outcome.reason, now, events, {
          approvedAnswers: outcome.answers ?? [], decision: outcome.decision,
        });
      } else if (command === 'record-cv') {
        if (!options.source || !options.pdf || !['pass', 'fail'].includes(options.qa)) {
          throw new Error('record-cv requires --source, --pdf and --qa pass|fail');
        }
        let qa = options.qa === 'pass'
          ? validateCvArtifacts(options.source, options.pdf)
          : { passed: false, reason: 'CV QA was explicitly recorded as failed.' };
        const providerId = key.split(':').at(-1);
        if (qa.passed && !basename(qa.pdf).includes(providerId)) {
          qa = { passed: false, reason: 'CV filename must contain the provider Job ID.' };
        }
        transition(state, key, qa.passed ? STATES.READY_TO_APPLY : STATES.NEEDS_REVIEW,
          qa.passed ? 'CV factual, ATS, PDF, and filename QA passed.' : qa.reason, now, events, {
            cvSource: resolve(options.source), cvPdf: resolve(options.pdf), cvQa: qa.passed,
            cvQaDetail: qa.detail ?? '',
          });
      } else if (command === 'begin-application') {
        if (state.mode !== 'ENABLED') throw new Error('auto-submit is not ENABLED');
        if (Object.values(state.jobs).some((job) => job.state === STATES.INTERVIEW_DETECTED)) {
          throw new Error('application policy gate failed: interview-pause');
        }
        if (state.jobs[key].state !== STATES.READY_TO_APPLY) throw new Error('job is not READY_TO_APPLY');
        if (options['browser-certain'] !== 'true' || options['final-review-matches'] !== 'true') {
          throw new Error('begin-application requires --browser-certain true and --final-review-matches true');
        }
        if (state.jobs[key].profileChangePending) throw new Error('application policy gate failed: profile-change-pending');
        const run = state.runs[state.jobs[key].runId] ?? currentRun(state);
        if (!run) throw new Error('application policy gate failed: no-logical-run');
        if (activeBudgetReached(run)) {
          finishActiveCycle(run, now, 'BUDGET_REACHED');
          state.runLock = null;
          commandResult = { error: 'application policy gate failed: active-cycle-budget-reached' };
        }
        if (commandResult) return commandResult;
        if (remainingRunAllowance(run) === 0) {
          throw new Error('application policy gate failed: per-run-cap');
        }
        if (!state.runLock || state.runLock.runId !== run.runId) {
          throw new Error('application policy gate failed: no-active-run-lock');
        }
        const outcome = routeJob(state.jobs[key], config, { tracker, jobs: state.jobs, now });
        if (outcome.decision !== 'GREEN') throw new Error('application policy gate failed: ' + outcome.reason);
        transition(state, key, STATES.APPLICATION_IN_PROGRESS,
          'Final review matched; exactly one Submit click is authorized without another confirmation.', now, events, {
            runId: run.runId,
            submitAuthorizedAt: now,
            finalConfirmationRequired: false,
            submitClickLimit: 1,
            browserStateCertain: true,
            finalReviewMatches: true,
            resumeCheckpoint: null,
          });
      } else if (command === 'block-application') {
        if (![STATES.READY_TO_APPLY, STATES.APPLICATION_IN_PROGRESS].includes(state.jobs[key].state)) {
          throw new Error('block-application requires READY_TO_APPLY or APPLICATION_IN_PROGRESS');
        }
        if (!Object.hasOwn(BLOCK_REASON_CODES, options['reason-code'])) {
          throw new Error(`unsupported --reason-code: ${options['reason-code'] ?? '(missing)'}`);
        }
        if (!options.step) throw new Error('block-application requires --step');
        let applicationUrl = options['application-url'] ?? state.jobs[key].url ?? '';
        if (applicationUrl && !/^https?:\/\//i.test(applicationUrl)) throw new Error('--application-url must be http(s)');
        const completedAnswers = options.answers
          ? JSON.parse(readFileSync(resolve(options.answers), 'utf8'))
          : state.jobs[key].approvedAnswers ?? [];
        const checkpoint = {
          step: options.step,
          applicationUrl,
          cvPdf: state.jobs[key].cvPdf ?? '',
          completedAnswers,
          blockedAt: now,
        };
        const updated = applySubmissionResult(state.jobs[key], {
          status: 'blocked',
          reasonCode: BLOCK_REASON_CODES[options['reason-code']],
          reason: options.reason ?? (options['reason-code'] === 'CHROME_FILE_UPLOAD_PERMISSION'
            ? 'Enable Allow access to file URLs for the ChatGPT Chrome extension, then resume this job.'
            : 'Complete the human verification challenge, then resume this job.'),
          checkpoint,
        }, now);
        transition(state, key, updated.state, updated.reason, now, events, updated);
      } else if (command === 'resume-application') {
        if (state.jobs[key].state !== STATES.BLOCKED_USER_ACTION || !state.jobs[key].checkpoint) {
          throw new Error('resume-application requires a blocked job with a checkpoint');
        }
        transition(state, key, STATES.READY_TO_APPLY, 'User action resolved; resume from saved checkpoint.', now, events, {
          resumeCheckpoint: state.jobs[key].checkpoint,
          lastBlockedReasonCode: state.jobs[key].reasonCode,
          reasonCode: null,
        });
      } else if (command === 'submission-result') {
        if (state.jobs[key].state !== STATES.APPLICATION_IN_PROGRESS) {
          throw new Error('submission-result requires APPLICATION_IN_PROGRESS');
        }
        if (!['confirmed', 'uncertain', 'blocked', 'transient'].includes(options.status)) {
          throw new Error('--status must be confirmed, uncertain, blocked, or transient');
        }
        const updated = applySubmissionResult(state.jobs[key], {
          status: options.status,
          confirmation: options.confirmation,
          timestamp: options.timestamp,
          reason: options.reason,
          maxAttempts: config?.retry?.max_attempts,
        }, now);
        if (updated.state === STATES.APPLIED) {
          updated.trackerPending = true;
          const run = state.runs[updated.runId];
          if (run && !run.submittedJobIdsThisRun.includes(key)) {
            run.submittedJobIdsThisRun.push(key);
            run.successfulSubmissionsThisRun += 1;
            if (remainingRunAllowance(run) === 0) run.status = 'CAP_REACHED';
          }
        }
        transition(state, key, updated.state,
          updated.state === STATES.APPLIED ? updated.confirmation : updated.reason, now, events, updated);
      } else if (command === 'resolve-uncertain') {
        if (!state.jobs[key].submissionUncertain) throw new Error('job has no uncertain submission to resolve');
        if (!['not-submitted', 'submitted'].includes(options.outcome) || !options.confirmation) {
          throw new Error('resolve-uncertain requires --outcome not-submitted|submitted and --confirmation evidence');
        }
        if (options.outcome === 'submitted') {
          const updated = applySubmissionResult(state.jobs[key], {
            status: 'confirmed', confirmation: options.confirmation, timestamp: now,
          }, now);
          updated.trackerPending = true;
          const run = state.runs[updated.runId];
          if (run && !run.submittedJobIdsThisRun.includes(key)) {
            run.submittedJobIdsThisRun.push(key);
            run.successfulSubmissionsThisRun += 1;
          }
          transition(state, key, STATES.APPLIED, updated.confirmation, now, events, updated);
        } else {
          transition(state, key, STATES.READY_TO_APPLY,
            `Verified not submitted: ${options.confirmation}`, now, events, {
              submissionUncertain: false, reasonCode: null, retryable: false,
            });
        }
      } else if (command === 'tracker-recorded') {
        if (state.jobs[key].state !== STATES.APPLIED || !state.jobs[key].trackerPending) {
          throw new Error('tracker-recorded requires an APPLIED job awaiting tracker sync');
        }
        state.jobs[key].trackerPending = false;
        if (options['tracker-row']) state.jobs[key].trackerRow = options['tracker-row'];
        transition(state, key, STATES.APPLIED, 'Canonical tracker sync confirmed.', now, events);
      } else {
        throw new Error(`Unknown command: ${command}`);
      }
    }
    if (state.runLock) state.runLock.heartbeatAt = now;
    if (state.activeRunId && state.runs[state.activeRunId]) state.lastRun = state.runs[state.activeRunId];
    state.lastControlAt = now;
    return commandResult;
  });
  if (command === 'cycle-check') console.log(JSON.stringify(result));
  if (result?.error) throw new Error(result.error);
  return result;
}

export async function prepareEvaluationCommand(options, shadowOptions = {}) {
  if (!options.job || !options['jd-file']) {
    throw new Error('prepare-evaluation requires --job and --jd-file');
  }
  const paths = pathsFrom(options);
  const config = readYaml(paths.config);
  const state = readState(paths.state, config);
  const job = state.jobs[options.job];
  if (!job) throw new Error(`Unknown --job: ${options.job}`);
  const result = await collectEvaluationShadow({
    job: {
      company: job.company ?? null,
      title: job.role ?? null,
      structured_location: job.location ?? null,
      source_url: job.url ?? null,
      jd_text: readFileSync(resolve(options['jd-file']), 'utf8'),
      extraction: {
        source: options.source ?? 'autopilot_evaluation',
        complete: options.complete !== 'false',
        truncated: options.truncated === 'true',
        liveness: options.liveness ?? 'unverified',
      },
    },
    deterministic_checks: { autopilot_gates_passed: true },
  }, { dataRoot: DATA_ROOT, ...shadowOptions });
  const output = options.json
    ? JSON.stringify(result.signal, null, 2)
    : formatJevShadowMarkdown(result.signal);
  console.log(output);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options, positional } = parseArgs(argv);
  if (command === 'help' || options.help) {
    console.log(usage());
    return;
  }
  if (command === 'run') await runCommand(options);
  else if (command === 'resume-job') await resumeJobCommand(options);
  else if (command === 'prepare-evaluation') await prepareEvaluationCommand(options);
  else await controlCommand(command, options, positional);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`autopilot: ${error.message}`);
    process.exitCode = 1;
  });
}
