import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resetJevCircuitBreakerForTests } from './jev-shadow.mjs';
import {
  attachJevShadowToReport, collectEvaluationShadow, ensureJevShadowInReport,
} from './jev-shadow-runner.mjs';
import { prepareEvaluationCommand } from './autopilot.mjs';

const SALES = {
  non_sales: 1,
  sales_adjacent_account_support: 0,
  target_driven_bd_lead_gen: 0,
  insurance_or_financial_agent_sales: 0,
  explicit_commission_based_sales: 0,
  sales_role_compensation_unclear: 0,
  unclear: 0,
};

function successBody() {
  return {
    model: 'jev-1.13.0',
    answers: {
      sales_nature: { type: 'choice', choice: 'non_sales', probabilities: SALES, confidence: 1 },
      language_barrier: {
        type: 'score', score: 0,
        legend: { 0: 'No barrier', 1: 'Optional', 2: 'Ambiguous', 3: 'Unmet' },
        probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 }, confidence: 1,
      },
      semantic_job_fit: {
        type: 'score', score: 3,
        legend: { 0: 'None', 1: 'Weak', 2: 'Partial', 3: 'Good', 4: 'Strong' },
        probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0 }, confidence: 1,
      },
      needs_human_review: {
        type: 'choice', choice: 'safe_to_continue',
        probabilities: { safe_to_continue: 1, human_review_needed: 0, insufficient_evidence: 0 }, confidence: 1,
      },
    },
    usage: { input_tokens: 10, output_tokens: 4 },
  };
}

function response(body) {
  return {
    ok: true, status: 200, headers: { get: () => null },
    async text() { return JSON.stringify(body); },
  };
}

function envelope(jdText = 'Coordinate a complete project delivery workflow for customers.') {
  return {
    job: {
      company: 'Example', title: 'Project Coordinator', structured_location: 'Hong Kong',
      source_url: 'https://example.com/jobs/1', jd_text: jdText,
      extraction: { source: 'test', complete: true, truncated: false, liveness: 'active' },
    },
    deterministic_checks: { liveness: 'active', duplicate: false, blacklist: false },
  };
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jev-shadow-runner-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'modes'), { recursive: true });
  writeFileSync(join(root, 'cv.md'), '# Summary\nVerified candidate.\n\n## Experience\n- Service work\n\n## Core Competencies\n- Project delivery\n\n## Languages and Certificates\n- Mandarin: Native\n');
  writeFileSync(join(root, 'config/profile.yml'), 'target_roles:\n  primary: [Project Coordinator]\nlocation:\n  authorized_in: [Hong Kong]\n');
  writeFileSync(join(root, 'modes/_profile.md'), '## Evaluation Priorities\n- Prefer junior delivery roles.\n');
  return root;
}

test.beforeEach(() => resetJevCircuitBreakerForTests());

test('same schema and input hash reuse one successful Jev request; changed input calls again', async () => {
  const root = fixtureRoot();
  let calls = 0;
  const options = {
    apiKey: 'test-key', dataRoot: root, cacheDir: join(root, 'cache'),
    fetchImpl: async () => { calls += 1; return response(successBody()); },
  };
  try {
    const first = await collectEvaluationShadow(envelope(), options);
    const reused = await collectEvaluationShadow(envelope(), options);
    const changed = await collectEvaluationShadow(envelope('A materially changed complete job description.'), options);

    assert.equal(first.reused, false);
    assert.equal(reused.reused, true);
    assert.equal(reused.signal.input_hash, first.signal.input_hash);
    assert.notEqual(changed.signal.input_hash, first.signal.input_hash);
    assert.equal(calls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('report finalizer appends one shadow block without changing score or decision', async () => {
  const root = fixtureRoot();
  const report = join(root, 'report.md');
  const original = [
    '# Evaluation: Example — Project Coordinator',
    '',
    '**URL:** https://example.com/jobs/1',
    '**Score:** 84/100',
    '**Decision:** GREEN — apply',
    '',
    '## Machine Summary',
    '',
    '```yaml',
    'score: 4.2',
    'final_decision: Apply',
    '```',
    '',
    '## A) Role Summary',
    '',
    'Existing A–G judgment.',
    '',
    '## Job Description (archived verbatim)',
    '',
    'Coordinate a complete project delivery workflow for customers, maintain schedules, document requirements, work with stakeholders, track risks, prepare status reports, support service quality, and help the team deliver agreed outcomes. This archived description is complete for the test role and contains the duties and requirements used in evaluation.',
    '',
  ].join('\n');
  writeFileSync(report, original);
  let calls = 0;
  const options = {
    apiKey: 'test-key', dataRoot: root, cacheDir: join(root, 'cache'),
    fetchImpl: async () => { calls += 1; return response(successBody()); },
  };
  try {
    await ensureJevShadowInReport(report, {}, options);
    await ensureJevShadowInReport(report, {}, options);
    await ensureJevShadowInReport(report, { extraction_source: 'nested_retry' }, options);
    const saved = readFileSync(report, 'utf8');
    assert.equal((saved.match(/^## Jev Signals \(shadow\)$/gm) || []).length, 1);
    assert.match(saved, /\*\*Score:\*\* 84\/100/);
    assert.match(saved, /\*\*Decision:\*\* GREEN — apply/);
    assert.match(saved, /score: 4\.2/);
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel processes coalesce the same schema and input hash', async () => {
  const root = fixtureRoot();
  const callsFile = join(root, 'calls.log');
  const child = join(root, 'child.mjs');
  const runnerUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'jev-shadow-runner.mjs')).href;
  writeFileSync(child, `
    import { appendFileSync } from 'node:fs';
    import { collectEvaluationShadow } from ${JSON.stringify(runnerUrl)};
    const body = ${JSON.stringify(successBody())};
    const envelope = ${JSON.stringify(envelope())};
    const response = { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    const result = await collectEvaluationShadow(envelope, {
      apiKey: 'test-key', dataRoot: process.argv[2], cacheDir: process.argv[3],
      fetchImpl: async () => { appendFileSync(process.argv[4], 'call\\n'); await new Promise(r => setTimeout(r, 150)); return response; },
    });
    process.stdout.write(result.signal.status);
  `);
  const run = () => new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, [child, root, join(root, 'cache'), callsFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    processChild.stdout.on('data', chunk => { stdout += chunk; });
    processChild.stderr.on('data', chunk => { stderr += chunk; });
    processChild.on('error', reject);
    processChild.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)));
  });
  try {
    assert.deepEqual(await Promise.all([run(), run()]), ['ok', 'ok']);
    assert.equal(readFileSync(callsFile, 'utf8').trim().split(/\r?\n/).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('incomplete or truncated JD never calls Jev and leaves the caller free to continue', async () => {
  const root = fixtureRoot();
  let calls = 0;
  const incomplete = envelope('Short shell');
  incomplete.job.extraction.complete = false;
  incomplete.job.extraction.truncated = true;
  try {
    const result = await collectEvaluationShadow(incomplete, {
      apiKey: 'test-key', dataRoot: root, cacheDir: join(root, 'cache'),
      fetchImpl: async () => { calls += 1; return response(successBody()); },
    });
    assert.equal(result.signal.status, 'jev_unavailable');
    assert.equal(result.signal.error_type, 'incomplete_jd');
    assert.equal(calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI builds an envelope from a JD file and exits successfully when Jev is unavailable', () => {
  const root = fixtureRoot();
  const jdFile = join(root, 'jd.txt');
  const output = join(root, 'shadow.json');
  writeFileSync(jdFile, 'A complete role description. '.repeat(20));
  try {
    const run = spawnSync(process.execPath, [
      join(dirname(fileURLToPath(import.meta.url)), 'jev-shadow-runner.mjs'),
      '--jd-file', jdFile, '--company', 'Example', '--title', 'Coordinator',
      '--url', 'https://example.com/jobs/1', '--source', 'test', '--complete', 'true',
      '--output', output,
    ], {
      encoding: 'utf8',
      env: { ...process.env, TYPESAFE_API_KEY: '', CAREER_OPS_ROOT: root },
    });
    assert.equal(run.status, 0, run.stderr);
    const signal = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(signal.status, 'jev_unavailable');
    assert.equal(signal.error_type, 'missing_api_key');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('precomputed batch signal attaches without another Jev request', () => {
  const root = fixtureRoot();
  const report = join(root, 'report.md');
  const signal = {
    schema_version: 'jev-shadow-v2', input_hash: 'sha256:test', requested_model: 'jev-latest',
    actual_model: 'jev-1.13.0', status: 'ok', error_type: null,
  };
  writeFileSync(report, '# Evaluation: Example — Coordinator\n\n**Score:** 80/100\n');
  try {
    attachJevShadowToReport(report, signal);
    const saved = readFileSync(report, 'utf8');
    assert.match(saved, /## Jev Signals \(shadow\)/);
    assert.match(saved, /"input_hash": "sha256:test"/);
    assert.match(saved, /\*\*Score:\*\* 80\/100/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ['timeout', '401', '422', 'malformed']) {
  test(`Jev ${failure} leaves the existing evaluation state and submit actions unchanged`, async () => {
    const root = fixtureRoot();
    const existing = { score: 84, color: 'GREEN', state: 'EVALUATED', submitActions: [] };
    const before = structuredClone(existing);
    try {
      const fetchImpl = failure === 'timeout'
        ? async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
            const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
          }))
        : async () => ({
            ok: !['401', '422'].includes(failure),
            status: failure === '401' ? 401 : failure === '422' ? 422 : 200,
            headers: { get: () => null },
            async text() { return failure === 'malformed' ? '{' : '{}'; },
          });
      const result = await collectEvaluationShadow(envelope(`Complete ${failure} JD. `.repeat(20)), {
        apiKey: 'test-key', dataRoot: root, cacheDir: join(root, 'cache'),
        timeoutMs: 5, fetchImpl,
      });
      assert.equal(result.signal.status, 'jev_unavailable');
      assert.deepEqual(existing, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('circuit breaker stops further calls and the caller continues unchanged', async () => {
  const root = fixtureRoot();
  let calls = 0;
  const existing = { score: 76, color: 'YELLOW', state: 'NEEDS_REVIEW', submitActions: [] };
  try {
    const options = {
      apiKey: 'test-key', dataRoot: root, cacheDir: join(root, 'cache'),
      fetchImpl: async () => { calls += 1; return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{' }; },
    };
    for (let i = 0; i < 3; i += 1) {
      const failed = await collectEvaluationShadow(envelope(`Circuit JD ${i}. `.repeat(20)), options);
      assert.equal(failed.signal.status, 'jev_unavailable');
    }
    const open = await collectEvaluationShadow(envelope('Circuit open JD. '.repeat(20)), options);
    assert.equal(open.signal.error_type, 'circuit_open');
    assert.equal(calls, 3);
    assert.deepEqual(existing, { score: 76, color: 'YELLOW', state: 'NEEDS_REVIEW', submitActions: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Autopilot prepare-evaluation calls Jev once without mutating durable state', async () => {
  const root = fixtureRoot();
  const config = join(root, 'autopilot.yml');
  const stateFile = join(root, 'state.json');
  const jdFile = join(root, 'jd.txt');
  writeFileSync(config, 'auto_submit:\n  enabled: false\n');
  writeFileSync(stateFile, JSON.stringify({
    version: 1, mode: 'DISABLED', jobs: {
      'test:1': { company: 'Example', role: 'Coordinator', location: 'Hong Kong', url: 'https://example.com/jobs/1', state: 'NEEDS_REVIEW' },
    }, runs: {}, activeRunId: null, runLock: null,
  }, null, 2));
  writeFileSync(jdFile, 'Complete coordinator job description. '.repeat(20));
  const before = readFileSync(stateFile, 'utf8');
  let calls = 0;
  const originalLog = console.log;
  try {
    console.log = () => {};
    const result = await prepareEvaluationCommand({
      job: 'test:1', 'jd-file': jdFile, config, state: stateFile, json: true,
    }, {
      dataRoot: root, cacheDir: join(root, 'cache'), apiKey: 'test-key',
      fetchImpl: async () => { calls += 1; return response(successBody()); },
    });
    assert.equal(result.signal.status, 'ok');
    assert.equal(calls, 1);
    assert.equal(readFileSync(stateFile, 'utf8'), before);
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Autopilot record-evaluation keeps its original transition when Jev is unavailable', () => {
  const root = fixtureRoot();
  const config = join(root, 'autopilot.yml');
  const stateFile = join(root, 'state.json');
  const tracker = join(root, 'applications.md');
  const report = join(root, 'report.md');
  writeFileSync(config, 'auto_submit:\n  enabled: false\n');
  writeFileSync(tracker, '# Applications Tracker\n');
  writeFileSync(stateFile, JSON.stringify({
    version: 1, mode: 'DISABLED', jobs: {
      'test:1': { company: 'Example', role: 'Coordinator', url: 'https://example.com/jobs/1', state: 'NEEDS_REVIEW' },
    }, runs: {}, activeRunId: null, runLock: null,
  }, null, 2));
  writeFileSync(report, [
    '# Evaluation: Example — Coordinator', '', '**Score:** 84/100', '**Decision:** GREEN', '',
    '## Job Description (archived verbatim)', '', 'Complete coordinator job description. '.repeat(20), '',
  ].join('\n'));
  try {
    const run = spawnSync(process.execPath, [
      join(dirname(fileURLToPath(import.meta.url)), 'autopilot.mjs'), 'record-evaluation',
      '--job', 'test:1', '--score', '84', '--evidence', report,
      '--config', config, '--state', stateFile, '--tracker', tracker,
    ], {
      cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8',
      env: { ...process.env, TYPESAFE_API_KEY: '', CAREER_OPS_ROOT: root },
    });
    assert.equal(run.status, 0, run.stderr);
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.jobs['test:1'].state, 'EVALUATED');
    assert.equal(state.jobs['test:1'].score, 84);
    assert.equal(state.jobs['test:1'].evaluationEvidence, report);
    assert.equal(state.jobs['test:1'].submissionStatus, undefined);
    assert.match(readFileSync(report, 'utf8'), /"status": "jev_unavailable"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all production evaluation paths are wired to the shared adapter or report finalizer', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const openrouter = readFileSync(join(root, 'openrouter-runner.mjs'), 'utf8');
  const batch = readFileSync(join(root, 'batch/batch-runner.sh'), 'utf8');
  const autopilot = readFileSync(join(root, 'autopilot.mjs'), 'utf8');
  const agent = readFileSync(join(root, 'modes/oferta.md'), 'utf8');
  const merge = readFileSync(join(root, 'merge-tracker.mjs'), 'utf8');
  const webRoute = readFileSync(join(root, 'web/src/app/api/run/route.ts'), 'utf8');
  const webPrompt = readFileSync(join(root, 'web/src/lib/run-prompts.mjs'), 'utf8');

  assert.match(openrouter, /collectEvaluationShadow\(/);
  assert.match(batch, /jev-shadow-runner\.mjs[\s\S]*--attach-report/);
  assert.match(autopilot, /prepare-evaluation[\s\S]*ensureJevShadowInReport/);
  assert.match(agent, /before Step 0 or Block A[\s\S]*jev-shadow-runner\.mjs/);
  assert.match(merge, /ensureJevShadowInReport/);
  assert.match(webPrompt, /before Block A[\s\S]*jev-shadow-runner\.mjs/);
  assert.match(webRoute, /jev-shadow-runner\.mjs[\s\S]*--report/);
});
