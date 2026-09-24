import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildJevShadowInputHash,
  buildJevShadowState,
  collectJevShadow,
  evaluateJevShadow,
  formatJevShadowMarkdown,
  JEV_SHADOW_QUESTIONS,
  JEV_SHADOW_SCHEMAS,
  JEV_SHADOW_SCHEMA_VERSION,
  resetJevCircuitBreakerForTests,
} from './jev-shadow.mjs';

const SALES = {
  non_sales: 0.78,
  sales_adjacent_account_support: 0.08,
  target_driven_bd_lead_gen: 0.04,
  insurance_or_financial_agent_sales: 0.02,
  explicit_commission_based_sales: 0.01,
  sales_role_compensation_unclear: 0.03,
  unclear: 0.04,
};
const REVIEW = {
  safe_to_continue: 0.8,
  human_review_needed: 0.15,
  insufficient_evidence: 0.05,
};

function state() {
  return {
    job: {
      company: 'Example', title: 'Project Coordinator', structured_location: 'Hong Kong',
      source_url: 'https://example.com/job/1',
      jd_text: 'Coordinate projects and support delivery. English required.',
      extraction: { source: 'test', complete: true, truncated: false, liveness: 'active' },
    },
    candidate: {
      verified_summary: {}, verified_experience: {}, verified_skills: {},
      languages: {}, work_authorization: {}, hard_boundaries: {},
    },
    deterministic_checks: { duplicate: false, closed: false, blacklist: false },
  };
}

function successBody() {
  return {
    model: 'jev-1.13.0',
    answers: {
      sales_nature: { type: 'choice', choice: 'non_sales', probabilities: SALES, confidence: 0.75 },
      language_barrier: {
        type: 'score', score: 0.2,
        legend: { 0: 'No barrier', 1: 'Optional', 2: 'Material', 3: 'Mandatory unmet' },
        probabilities: { 0: 0.8, 1: 0.2, 2: 0, 3: 0 }, confidence: 0.8,
      },
      semantic_job_fit: {
        type: 'score', score: 3.1,
        legend: { 0: 'None', 1: 'Weak', 2: 'Partial', 3: 'Good', 4: 'Strong' },
        probabilities: { 0: 0, 1: 0.05, 2: 0.1, 3: 0.55, 4: 0.3 }, confidence: 0.7,
      },
      needs_human_review: { type: 'choice', choice: 'safe_to_continue', probabilities: REVIEW, confidence: 0.7 },
    },
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

function response(status, body, headers = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => normalized[name.toLowerCase()] ?? null },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

test.beforeEach(() => resetJevCircuitBreakerForTests());

test('State builder loads every candidate field from canonical sources', () => {
  const built = buildJevShadowState(state());
  for (const field of [
    'verified_summary', 'verified_experience', 'verified_skills', 'target_archetypes',
    'languages', 'work_authorization', 'hard_boundaries',
  ]) assert.ok(Object.hasOwn(built.candidate, field), field);
  assert.equal(built.candidate.languages.source, 'cv.md#Languages and Certificates');
  assert.equal(built.candidate.work_authorization.source, 'config/profile.yml#location');
});

test('normal success returns all shadow fields', async () => {
  const result = await evaluateJevShadow(state(), {
    apiKey: 'test-key', fetchImpl: async () => response(200, successBody()),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.actual_model, 'jev-1.13.0');
  assert.equal(result.sales_nature.choice, 'non_sales');
  assert.equal(result.language_barrier.score, 0.2);
  assert.equal(result.semantic_job_fit.score, 3.1);
  assert.equal(result.needs_human_review.choice, 'safe_to_continue');
  assert.equal(result.schema_version, 'jev-shadow-v2');
  assert.match(result.input_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 20 });
  assert.match(formatJevShadowMarkdown(result), /^## Jev Signals \(shadow\)/);
});

test('v1 schema is preserved while v2 is the active schema', () => {
  assert.equal(JEV_SHADOW_SCHEMA_VERSION, 'jev-shadow-v2');
  assert.equal(JEV_SHADOW_QUESTIONS, JEV_SHADOW_SCHEMAS['jev-shadow-v2']);
  assert.ok(Object.hasOwn(JEV_SHADOW_SCHEMAS['jev-shadow-v1'].sales_nature.criteria, 'commission_or_agent_sales'));
  assert.ok(Object.hasOwn(JEV_SHADOW_SCHEMAS['jev-shadow-v2'].sales_nature.criteria, 'explicit_commission_based_sales'));
  assert.ok(Object.hasOwn(JEV_SHADOW_SCHEMAS['jev-shadow-v2'].sales_nature.criteria, 'sales_role_compensation_unclear'));
});

test('input hash covers the exact schema-bearing request payload', () => {
  const first = buildJevShadowInputHash(state());
  const changed = state();
  changed.job.jd_text += ' Changed.';
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(first, buildJevShadowInputHash(changed));
});

test('language schema preserves OR alternatives, preference, and missing-proof ambiguity', async () => {
  const instructions = `${JEV_SHADOW_QUESTIONS.language_barrier.instructions} ${JEV_SHADOW_QUESTIONS.language_barrier.criteria.join(' ')}`;
  assert.match(instructions, /AND versus OR literally/);
  assert.match(instructions, /preferred/);
  assert.match(instructions, /Missing evidence alone is not enough/);

  const expectedScores = [0, 1, 2];
  for (const score of expectedScores) {
    const body = successBody();
    body.answers.language_barrier.score = score;
    body.answers.language_barrier.probabilities = { 0: score === 0 ? 1 : 0, 1: score === 1 ? 1 : 0, 2: score === 2 ? 1 : 0, 3: 0 };
    const result = await evaluateJevShadow(state(), { apiKey: 'test-key', fetchImpl: async () => response(200, body) });
    assert.equal(result.language_barrier.score, score);
  }
});

test('sales schema keeps duties, agent status, explicit commission, and missing pay evidence separate', async () => {
  const instructions = `${JEV_SHADOW_QUESTIONS.sales_nature.instructions} ${Object.values(JEV_SHADOW_QUESTIONS.sales_nature.criteria).join(' ')}`;
  assert.match(instructions, /Sales duties alone never prove/);
  for (const choice of ['target_driven_bd_lead_gen', 'insurance_or_financial_agent_sales', 'explicit_commission_based_sales', 'sales_role_compensation_unclear']) {
    const body = successBody();
    body.answers.sales_nature.choice = choice;
    body.answers.sales_nature.probabilities = Object.fromEntries(Object.keys(SALES).map(key => [key, key === choice ? 1 : 0]));
    const result = await evaluateJevShadow(state(), { apiKey: 'test-key', fetchImpl: async () => response(200, body) });
    assert.equal(result.sales_nature.choice, choice);
  }
});

test('semantic fit schema distinguishes graduate or junior evidence from required formal experience', async () => {
  const instructions = `${JEV_SHADOW_QUESTIONS.semantic_job_fit.instructions} ${JEV_SHADOW_QUESTIONS.semantic_job_fit.criteria.join(' ')}`;
  assert.match(instructions, /graduate trainee or junior role/);
  assert.match(instructions, /must not be relabeled as employment/);
  for (const score of [1, 3]) {
    const body = successBody();
    body.answers.semantic_job_fit.score = score;
    body.answers.semantic_job_fit.probabilities = { 0: 0, 1: score === 1 ? 1 : 0, 2: 0, 3: score === 3 ? 1 : 0, 4: 0 };
    const result = await evaluateJevShadow(state(), { apiKey: 'test-key', fetchImpl: async () => response(200, body) });
    assert.equal(result.semantic_job_fit.score, score);
  }
});

test('low-confidence review remains an observation instead of a routing decision', async () => {
  const body = successBody();
  body.answers.needs_human_review = {
    type: 'choice', choice: 'human_review_needed',
    probabilities: { safe_to_continue: 0.45, human_review_needed: 0.5, insufficient_evidence: 0.05 },
    confidence: 0.05,
  };
  const result = await evaluateJevShadow(state(), { apiKey: 'test-key', fetchImpl: async () => response(200, body) });
  assert.equal(result.needs_human_review.choice, 'human_review_needed');
  assert.equal(result.needs_human_review.confidence, 0.05);
  assert.match(JEV_SHADOW_QUESTIONS.needs_human_review.instructions, /not a routing/);
});

test('API timeout becomes jev_unavailable', async () => {
  const result = await evaluateJevShadow(state(), {
    apiKey: 'test-key', timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  assert.equal(result.status, 'jev_unavailable');
  assert.equal(result.error_type, 'timeout');
});

for (const status of [429, 529]) {
  test(`${status} retries at most once and honors Retry-After`, async () => {
    let calls = 0;
    const waits = [];
    const result = await evaluateJevShadow(state(), {
      apiKey: 'test-key', sleep: async ms => waits.push(ms),
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? response(status, {}, { 'Retry-After': '1' }) : response(200, successBody());
      },
    });
    assert.equal(result.status, 'ok');
    assert.equal(calls, 2);
    assert.deepEqual(waits, [1_000]);
  });
}

for (const status of [401, 422]) {
  test(`${status} is not retried`, async () => {
    let calls = 0;
    const result = await evaluateJevShadow(state(), {
      apiKey: 'test-key',
      fetchImpl: async () => { calls += 1; return response(status, {}); },
    });
    assert.equal(result.status, 'jev_unavailable');
    assert.equal(result.error_type, `http_${status}`);
    assert.equal(calls, 1);
  });
}

test('invalid JSON becomes jev_unavailable', async () => {
  const result = await evaluateJevShadow(state(), {
    apiKey: 'test-key', fetchImpl: async () => response(200, '{'),
  });
  assert.equal(result.status, 'jev_unavailable');
  assert.equal(result.error_type, 'invalid_json');
});

test('missing answer fields become jev_unavailable', async () => {
  const body = successBody();
  delete body.answers.semantic_job_fit;
  const result = await evaluateJevShadow(state(), {
    apiKey: 'test-key', fetchImpl: async () => response(200, body),
  });
  assert.equal(result.status, 'jev_unavailable');
  assert.equal(result.error_type, 'invalid_response');
});

test('illegal choice becomes jev_unavailable', async () => {
  const body = successBody();
  body.answers.sales_nature.choice = 'sales';
  const result = await evaluateJevShadow(state(), {
    apiKey: 'test-key', fetchImpl: async () => response(200, body),
  });
  assert.equal(result.status, 'jev_unavailable');
  assert.equal(result.error_type, 'invalid_response');
});

test('invalid probabilities become jev_unavailable', async () => {
  const body = successBody();
  body.answers.needs_human_review.probabilities.safe_to_continue = 2;
  const result = await evaluateJevShadow(state(), {
    apiKey: 'test-key', fetchImpl: async () => response(200, body),
  });
  assert.equal(result.status, 'jev_unavailable');
  assert.equal(result.error_type, 'invalid_response');
});

test('Jev failure returns data instead of interrupting the existing flow', async () => {
  const events = [];
  const result = await collectJevShadow(state(), {
    apiKey: 'test-key', fetchImpl: async () => response(401, {}),
  });
  events.push('existing-evaluation-continued');
  assert.equal(result.status, 'jev_unavailable');
  assert.deepEqual(events, ['existing-evaluation-continued']);
});
