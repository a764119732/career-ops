import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'autopilot.mjs');

test('resume-job changes only its target and keeps submission gates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-job-'));
  const config = join(dir, 'config.yml');
  const statePath = join(dir, 'state.json');
  const tracker = join(dir, 'tracker.md');
  const pipeline = join(dir, 'pipeline.md');
  const cv = join(dir, 'cv-1.pdf');
  const now = '2026-09-19T12:00:00.000Z';
  const key = 'jobsdb:1';
  const command = (name, ...args) => spawnSync(process.execPath, [cli, name,
    '--config', config, '--state', statePath, '--tracker', tracker,
    '--pipeline', pipeline, '--now', now, ...args,
  ], { encoding: 'utf8', timeout: 30_000 });
  try {
    writeFileSync(config, `targeting:\n  auto_apply_threshold: 75\nlimits:\n  daily_successful_submissions: 4\n  per_run_successful_submissions: 2\n  same_company_max: 2\n  same_company_days: 7\nauto_submit: { enabled: true }\napproved_answers: []\nscan: { enabled: true }\n`);
    writeFileSync(tracker, '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n');
    writeFileSync(pipeline, '- [ ] https://hk.jobsdb.com/id/job/555 | New Ltd | Coordinator | Hong Kong\n');
    writeFileSync(cv, '%PDF-test');
    const jobs = {
      [key]: { provider: 'jobsdb', jobId: '1', company: 'Target Ltd', role: 'Product Executive',
        state: 'READY_TO_APPLY', decision: 'GREEN', score: 80, questions: [],
        cvQa: true, cvPdf: cv, runId: 'run-1' },
      'jobsdb:2': { provider: 'jobsdb', jobId: '2', company: 'Other Ltd', role: 'Coordinator',
        state: 'READY_TO_APPLY', decision: 'GREEN', score: 80, questions: [], cvQa: true, runId: 'run-1' },
      'jobsdb:3': { state: 'NEEDS_REVIEW' },
      'jobsdb:4': { state: 'SKIPPED' },
      'jobsdb:5': { state: 'APPLIED', company: 'Prior Ltd', appliedAt: '2026-09-18T12:00:00.000Z' },
    };
    const run = { runId: 'run-1', startedAt: now, activeStartedAt: now,
      activeLastHeartbeatAt: now, activeDurationMs: 0, maxActiveCycleMinutes: 45,
      maxSubmissionsPerRun: 2, successfulSubmissionsThisRun: 0, submittedJobIdsThisRun: [],
      status: 'COMPLETE' };
    writeFileSync(statePath, JSON.stringify({ version: 1, mode: 'ENABLED', jobs,
      runs: { 'run-1': run }, activeRunId: 'run-1', lastRun: run, runLock: null }));
    const before = structuredClone(jobs);
    const beforeState = readFileSync(statePath, 'utf8');
    assert.notEqual(command('resume-job', '--job', 'jobsdb:3', '--json').status, 0);
    assert.equal(readFileSync(statePath, 'utf8'), beforeState);
    const resumed = command('resume-job', '--job', key, '--json');
    assert.equal(resumed.status, 0, resumed.stderr);
    const output = JSON.parse(resumed.stdout);
    assert.equal(output.runLock.jobScope, key);
    assert.deepEqual(output.actions.map(({ jobKey }) => jobKey), [key]);
    assert.equal(output.per_run_remaining_allowance, 2);
    assert.equal(output.daily_remaining_allowance, 4);
    const after = JSON.parse(readFileSync(statePath));
    assert.deepEqual(after.jobs, before);
    assert.equal(after.jobs['jobsdb:555'], undefined);
    assert.notEqual(command('begin-application', '--job', 'jobsdb:2', '--browser-certain', 'true',
      '--final-review-matches', 'true').status, 0);
    assert.equal(command('cycle-check').status, 0);
    assert.equal(command('begin-application', '--job', key, '--browser-certain', 'true',
      '--final-review-matches', 'true').status, 0);
    assert.equal(command('submission-result', '--job', key, '--status', 'uncertain').status, 0);
    assert.equal(command('finish-run').status, 0);
    const finalState = JSON.parse(readFileSync(statePath));
    assert.equal(finalState.runLock, null);
    assert.equal(finalState.jobs[key].submissionUncertain, true);
    for (const [otherKey, job] of Object.entries(before)) {
      if (otherKey !== key) assert.deepEqual(finalState.jobs[otherKey], job);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
