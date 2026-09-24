#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import * as yaml from 'js-yaml';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_REQUESTED_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;
const SERVICE_ERROR_LIMIT = 3;

const SALES_CHOICES = [
  'non_sales',
  'sales_adjacent_account_support',
  'target_driven_bd_lead_gen',
  'insurance_or_financial_agent_sales',
  'explicit_commission_based_sales',
  'sales_role_compensation_unclear',
  'unclear',
];

const REVIEW_CHOICES = [
  'safe_to_continue',
  'human_review_needed',
  'insufficient_evidence',
];

const JEV_SHADOW_QUESTIONS_V1 = Object.freeze({
  sales_nature: {
    type: 'choice',
    instructions: 'Classify how central sales acquisition is to the actual duties and compensation model in `job.jd_text`. Judge the full job description, not the title alone. Customer support, account coordination, and partner operations are not sales unless acquisition, prospecting, quotas, or commission are central.',
    criteria: {
      non_sales: 'No meaningful sales, prospecting, customer acquisition, quota, or commission responsibility.',
      sales_adjacent_account_support: 'Supports customers, accounts, partners, renewals, or commercial teams, but does not primarily own new-business acquisition or prospecting.',
      target_driven_bd_lead_gen: 'Business development, lead generation, cold calling, outbound prospecting, customer acquisition, pipeline ownership, or revenue targets are material duties.',
      commission_or_agent_sales: 'The role is primarily commission-driven, insurance/property/financial agency sales, independent-agent recruitment, or otherwise makes variable-pay selling the core job.',
      unclear: 'The available job description is contradictory or does not contain enough evidence to classify the sales nature reliably.',
    },
  },
  language_barrier: {
    type: 'score',
    instructions: 'Rate whether explicit language requirements in `job.jd_text`, compared only with the verified statements in `candidate.languages`, create a real application barrier. Do not infer, supplement, or upgrade the candidate\'s proficiency. Treat preferred wording differently from mandatory wording.',
    criteria: [
      'No material barrier: no relevant language requirement, or every explicit requirement is clearly supported by the verified candidate facts.',
      'Optional or preferred requirement only: a possible language gap is described as preferred, advantageous, or non-essential.',
      'Material gap or ambiguity: the requirement may affect screening, but its mandatory status or the candidate match is unclear.',
      'Explicit mandatory unmet requirement: the job clearly requires a proficiency level that the verified candidate facts do not support.',
    ],
  },
  semantic_job_fit: {
    type: 'score',
    instructions: 'Rate semantic fit between the core duties and requirements in `job.jd_text` and the verified evidence in `candidate.verified_summary`, `candidate.verified_experience`, `candidate.verified_skills`, `candidate.target_archetypes`, and `candidate.hard_boundaries`. Do not infer missing skills, years, ownership, credentials, or language ability.',
    criteria: [
      'Almost no core overlap.',
      'Weak transferable overlap.',
      'Partial fit with major gaps.',
      'Good core fit.',
      'Strong core and target-archetype fit.',
    ],
  },
  needs_human_review: {
    type: 'choice',
    instructions: 'Using the raw job description, extraction metadata, verified candidate facts, and `deterministic_checks`, decide whether material ambiguity or missing evidence warrants human review before existing career-ops automation continues. This is an observation-only shadow judgment and must not authorize or block an application.',
    criteria: {
      safe_to_continue: 'The evidence needed for the requested judgments is sufficiently clear and internally consistent.',
      human_review_needed: 'There is a material contradiction, ambiguous mandatory requirement, unclear sales/employment model, or other uncertainty that a human should resolve.',
      insufficient_evidence: 'The job description is missing, incomplete, truncated in a material way, or otherwise lacks enough evidence for a reliable judgment.',
    },
  },
});

const JEV_SHADOW_QUESTIONS_V2 = Object.freeze({
  sales_nature: {
    type: 'choice',
    instructions: 'Classify the role from explicit evidence in the full `job.jd_text`. Separate duties from employment and compensation evidence. Sales duties alone never prove an insurance/financial-agent arrangement or a pure-commission model. A sales title, company industry, uncapped earning language, bonus, incentive, or unspecified commission is not enough to infer pure commission. Use `unclear` only when the duties themselves cannot be classified; use `sales_role_compensation_unclear` when the role is clearly sales but its pay or contract model is not established.',
    criteria: {
      non_sales: 'No material sales, prospecting, customer acquisition, quota, insurance/financial-product selling, or commission responsibility.',
      sales_adjacent_account_support: 'Supports customers, accounts, partners, renewals, or commercial teams, but does not primarily own new-business acquisition, prospecting, or individual sales targets.',
      target_driven_bd_lead_gen: 'Business development, lead generation, cold calling, outbound prospecting, customer acquisition, pipeline ownership, or revenue targets are material duties; the JD does not establish an agent arrangement or pure-commission pay.',
      insurance_or_financial_agent_sales: 'The JD explicitly describes insurance or financial-product agency/adviser selling, agent recruitment, self-employed/independent-agent status, or an agency contract. Do not choose this from the employer industry alone.',
      explicit_commission_based_sales: 'The JD explicitly states pure commission, commission-only, wholly variable pay, no base salary, or an equivalent unambiguous compensation model.',
      sales_role_compensation_unclear: 'Sales, acquisition, or target ownership is clearly central, but the JD lacks enough explicit pay or contract evidence to decide whether it is salaried, agent-based, or pure commission.',
      unclear: 'The available JD is contradictory or lacks enough evidence to classify whether sales or acquisition is material at all.',
    },
  },
  language_barrier: {
    type: 'score',
    instructions: 'Compare only explicit language wording in `job.jd_text` with verified statements in `candidate.languages`. Parse AND versus OR literally: for an OR requirement, support for any one alternative satisfies that requirement. Distinguish mandatory wording from preferred, advantageous, or optional wording. Do not infer or upgrade proficiency, but do not convert missing proof, a missing certificate, or an unspecified proficiency level into a confirmed failure; those are ambiguity unless verified facts explicitly contradict the mandatory requirement.',
    criteria: [
      'No material barrier: no relevant requirement, every mandatory requirement is supported, or at least one verified language satisfies each explicit OR group (for example Cantonese OR Mandarin).',
      'Optional or preferred requirement only: the only unsupported language is described as preferred, advantageous, a plus, or otherwise non-essential.',
      'Material gap or ambiguity: mandatory status, required level, OR/AND structure, or candidate match is unclear; this includes absence of proof when the verified facts neither establish nor contradict the requirement.',
      'Explicit mandatory unmet requirement: the JD unambiguously mandates a language or level, all allowed alternatives are considered, and verified candidate facts explicitly establish that the candidate does not meet any permitted alternative. Missing evidence alone is not enough for this score.',
    ],
  },
  semantic_job_fit: {
    type: 'score',
    instructions: 'Rate semantic fit between core duties and requirements in `job.jd_text` and only verified evidence in `candidate.verified_summary`, `candidate.verified_experience`, `candidate.verified_skills`, `candidate.target_archetypes`, and `candidate.hard_boundaries`. First distinguish a graduate trainee or junior role from a role that explicitly requires formal professional experience. Do not penalize a graduate/junior candidate merely for lacking full-time formal experience unless the JD makes it mandatory. Verified projects, education, or service may support transferable overlap but must not be relabeled as employment. Never invent years, ownership, credentials, skills, or language ability.',
    criteria: [
      'Almost no core overlap with the duties or target profile.',
      'Weak transferable overlap, or a role requiring formal experience that the verified facts do not establish.',
      'Partial fit with major gaps; some relevant verified evidence exists but one or more central requirements remain unsupported.',
      'Good core fit for the role level, including graduate trainee or junior roles where verified education, projects, skills, or service cover most central duties without inventing formal experience.',
      'Strong core and target-archetype fit: verified evidence directly covers nearly all central duties and level expectations with no major unsupported requirement.',
    ],
  },
  needs_human_review: {
    type: 'choice',
    instructions: 'Judge only whether the shadow evidence is reliable enough to observe, using the raw JD, extraction metadata, verified candidate facts, and `deterministic_checks`. This is not a routing, application, or final eligibility decision. Preserve uncertainty: material ambiguity, close alternatives, or evidence likely to produce low confidence should remain `human_review_needed`; materially incomplete evidence should remain `insufficient_evidence`. Never treat either as a definitive rejection or approval.',
    criteria: {
      safe_to_continue: 'The evidence is complete enough and sufficiently clear for a shadow observation. This does not mean safe to apply and does not authorize any action.',
      human_review_needed: 'The evidence exists but contains a material contradiction, ambiguous mandatory requirement, close classification boundary, unclear sales/employment/pay model, or other uncertainty that warrants human interpretation.',
      insufficient_evidence: 'The JD is missing, incomplete, materially truncated, or otherwise lacks enough evidence to support the requested observations.',
    },
  },
});

export const JEV_SHADOW_SCHEMA_VERSION = 'jev-shadow-v2';
export const JEV_SHADOW_SCHEMAS = Object.freeze({
  'jev-shadow-v1': JEV_SHADOW_QUESTIONS_V1,
  'jev-shadow-v2': JEV_SHADOW_QUESTIONS_V2,
});
export const JEV_SHADOW_QUESTIONS = JEV_SHADOW_SCHEMAS[JEV_SHADOW_SCHEMA_VERSION];

const circuit = { open: false, consecutiveServiceErrors: 0 };

export function resetJevCircuitBreakerForTests() {
  circuit.open = false;
  circuit.consecutiveServiceErrors = 0;
}

function readText(root, relativePath) {
  try {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
  } catch {
    return '';
  }
}

function extractMarkdownSection(markdown, heading) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex(line => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function bulletStatements(section) {
  return String(section || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim());
}

export function loadVerifiedCandidateState(dataRoot = getCareerOpsRoot()) {
  const cv = readText(dataRoot, 'cv.md');
  const profileText = readText(dataRoot, 'config/profile.yml');
  const profileMode = readText(dataRoot, 'modes/_profile.md');
  let profile = {};
  try {
    profile = yaml.load(profileText) || {};
  } catch {
    profile = {};
  }

  const location = profile.location && typeof profile.location === 'object' ? profile.location : {};
  const languageSection = extractMarkdownSection(cv, 'Languages and Certificates');

  return {
    verified_summary: {
      source: 'cv.md#Summary',
      text: extractMarkdownSection(cv, 'Summary'),
    },
    verified_experience: {
      sources: {
        product_projects: 'cv.md#Product Projects',
        employment_and_service: 'cv.md#Experience',
        additional_projects: 'cv.md#Additional Projects',
        education: 'cv.md#Education',
      },
      product_projects: extractMarkdownSection(cv, 'Product Projects'),
      employment_and_service: extractMarkdownSection(cv, 'Experience'),
      additional_projects: extractMarkdownSection(cv, 'Additional Projects'),
      education: extractMarkdownSection(cv, 'Education'),
    },
    verified_skills: {
      source: 'cv.md#Core Competencies',
      statements: bulletStatements(extractMarkdownSection(cv, 'Core Competencies')),
    },
    target_archetypes: {
      source: 'config/profile.yml#target_roles',
      primary: Array.isArray(profile.target_roles?.primary) ? profile.target_roles.primary : [],
      archetypes: Array.isArray(profile.target_roles?.archetypes) ? profile.target_roles.archetypes : [],
    },
    languages: {
      source: 'cv.md#Languages and Certificates',
      statements: bulletStatements(languageSection),
    },
    work_authorization: {
      source: 'config/profile.yml#location',
      visa_status: location.visa_status ?? null,
      authorized_in: Array.isArray(location.authorized_in) ? location.authorized_in : [],
      needs_sponsorship: typeof location.needs_sponsorship === 'boolean' ? location.needs_sponsorship : null,
    },
    hard_boundaries: {
      sources: ['cv.md#Positioning Boundaries', 'modes/_profile.md#Evaluation Priorities'],
      positioning_boundaries: extractMarkdownSection(cv, 'Positioning Boundaries'),
      evaluation_priorities: extractMarkdownSection(profileMode, 'Evaluation Priorities'),
    },
  };
}

function nullableString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function buildJevShadowState(envelope, { dataRoot = getCareerOpsRoot() } = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('invalid_state');
  const inputJob = envelope.job && typeof envelope.job === 'object' ? envelope.job : {};
  const extraction = inputJob.extraction && typeof inputJob.extraction === 'object' ? inputJob.extraction : {};
  const jdText = typeof inputJob.jd_text === 'string' ? inputJob.jd_text.trim() : '';
  if (!jdText || typeof extraction.complete !== 'boolean' || typeof extraction.truncated !== 'boolean') {
    throw new Error('invalid_state');
  }

  return {
    job: {
      company: nullableString(inputJob.company),
      title: nullableString(inputJob.title),
      structured_location: nullableString(inputJob.structured_location),
      source_url: nullableString(inputJob.source_url),
      jd_text: jdText,
      extraction: {
        source: nullableString(extraction.source),
        complete: extraction.complete,
        truncated: extraction.truncated,
        liveness: nullableString(extraction.liveness),
      },
    },
    candidate: loadVerifiedCandidateState(dataRoot),
    deterministic_checks:
      envelope.deterministic_checks && typeof envelope.deterministic_checks === 'object' && !Array.isArray(envelope.deterministic_checks)
        ? envelope.deterministic_checks
        : {},
  };
}

function isProbability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateProbabilityMap(probabilities, expectedKeys) {
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) return false;
  const actualKeys = Object.keys(probabilities).sort();
  const wantedKeys = [...expectedKeys].sort();
  if (actualKeys.length !== wantedKeys.length || actualKeys.some((key, index) => key !== wantedKeys[index])) return false;
  const values = actualKeys.map(key => probabilities[key]);
  if (!values.every(isProbability)) return false;
  return Math.abs(values.reduce((total, value) => total + value, 0) - 1) <= 0.02;
}

function validateChoice(answer, choices) {
  return answer?.type === 'choice'
    && choices.includes(answer.choice)
    && validateProbabilityMap(answer.probabilities, choices)
    && isProbability(answer.confidence);
}

function validateScore(answer, levelCount) {
  const levels = Array.from({ length: levelCount }, (_, index) => String(index));
  return answer?.type === 'score'
    && Number.isFinite(answer.score)
    && answer.score >= 0
    && answer.score <= levelCount - 1
    && validateProbabilityMap(answer.probabilities, levels)
    && isProbability(answer.confidence)
    && answer.legend
    && typeof answer.legend === 'object'
    && levels.every(level => typeof answer.legend[level] === 'string');
}

function validateApiResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.model !== 'string' || !value.model.trim()) return false;
  const answers = value.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  return validateChoice(answers.sales_nature, SALES_CHOICES)
    && validateScore(answers.language_barrier, 4)
    && validateScore(answers.semantic_job_fit, 5)
    && validateChoice(answers.needs_human_review, REVIEW_CHOICES);
}

function extractionSnapshot(state) {
  const extraction = state?.job?.extraction || {};
  return {
    source: extraction.source ?? null,
    complete: extraction.complete ?? null,
    truncated: extraction.truncated ?? null,
    liveness: extraction.liveness ?? null,
  };
}

function requestPayload(state) {
  return { state, model: JEV_REQUESTED_MODEL, questions: JEV_SHADOW_QUESTIONS };
}

export function buildJevShadowInputHash(state) {
  return `sha256:${createHash('sha256').update(JSON.stringify(requestPayload(state))).digest('hex')}`;
}

function baseSignal(state, startedAt, now) {
  return {
    schema_version: JEV_SHADOW_SCHEMA_VERSION,
    input_hash: state ? buildJevShadowInputHash(state) : null,
    requested_model: JEV_REQUESTED_MODEL,
    actual_model: null,
    timestamp: new Date(startedAt).toISOString(),
    sales_nature: null,
    language_barrier: null,
    semantic_job_fit: null,
    needs_human_review: null,
    extraction_completeness: extractionSnapshot(state),
    api_latency_ms: Math.max(0, now() - startedAt),
    usage: null,
    status: 'jev_unavailable',
    error_type: null,
  };
}

function unavailable(state, startedAt, now, errorType) {
  return { ...baseSignal(state, startedAt, now), error_type: errorType };
}

function headerValue(response, name) {
  return response?.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null;
}

function retryAfterMs(value, nowMs) {
  if (!value) return 500;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : 500;
}

async function requestOnce(state, { apiKey, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload(state)),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        errorType: `http_${response.status}`,
        status: response.status,
        retryAfter: headerValue(response, 'retry-after'),
      };
    }

    const text = await response.text();
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, errorType: 'invalid_json' };
    }
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return { ok: false, errorType: 'timeout' };
    }
    return { ok: false, errorType: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

function recordFailure(errorType) {
  if (errorType === 'missing_api_key' || errorType === 'http_401' || errorType === 'http_422') {
    circuit.open = true;
    return;
  }
  if (/^(timeout|network_error|invalid_json|invalid_response|http_(429|529|5\d\d))$/.test(errorType)) {
    circuit.consecutiveServiceErrors += 1;
    if (circuit.consecutiveServiceErrors >= SERVICE_ERROR_LIMIT) circuit.open = true;
  }
}

export async function evaluateJevShadow(state, options = {}) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  if (circuit.open) return unavailable(state, startedAt, now, 'circuit_open');

  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    recordFailure('missing_api_key');
    return unavailable(state, startedAt, now, 'missing_api_key');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));

  let response = await requestOnce(state, { apiKey, fetchImpl, timeoutMs });
  if (!response.ok && (response.status === 429 || response.status === 529)) {
    const waitMs = retryAfterMs(response.retryAfter, now());
    if (waitMs <= maxRetryAfterMs) {
      await sleep(waitMs);
      response = await requestOnce(state, { apiKey, fetchImpl, timeoutMs });
    }
  }

  if (!response.ok) {
    recordFailure(response.errorType);
    return unavailable(state, startedAt, now, response.errorType);
  }
  if (!validateApiResponse(response.data)) {
    recordFailure('invalid_response');
    return unavailable(state, startedAt, now, 'invalid_response');
  }

  circuit.consecutiveServiceErrors = 0;
  const answers = response.data.answers;
  return {
    schema_version: JEV_SHADOW_SCHEMA_VERSION,
    input_hash: buildJevShadowInputHash(state),
    requested_model: JEV_REQUESTED_MODEL,
    actual_model: response.data.model,
    timestamp: new Date(startedAt).toISOString(),
    sales_nature: {
      choice: answers.sales_nature.choice,
      probabilities: answers.sales_nature.probabilities,
      confidence: answers.sales_nature.confidence,
    },
    language_barrier: {
      score: answers.language_barrier.score,
      probabilities: answers.language_barrier.probabilities,
      confidence: answers.language_barrier.confidence,
    },
    semantic_job_fit: {
      score: answers.semantic_job_fit.score,
      probabilities: answers.semantic_job_fit.probabilities,
      confidence: answers.semantic_job_fit.confidence,
    },
    needs_human_review: {
      choice: answers.needs_human_review.choice,
      probabilities: answers.needs_human_review.probabilities,
      confidence: answers.needs_human_review.confidence,
    },
    extraction_completeness: extractionSnapshot(state),
    api_latency_ms: Math.max(0, now() - startedAt),
    usage: response.data.usage && Number.isFinite(response.data.usage.input_tokens) && Number.isFinite(response.data.usage.output_tokens)
      ? { input_tokens: response.data.usage.input_tokens, output_tokens: response.data.usage.output_tokens }
      : null,
    status: 'ok',
    error_type: null,
  };
}

export async function collectJevShadow(envelope, options = {}) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let state = null;
  try {
    state = buildJevShadowState(envelope, options.dataRoot ? { dataRoot: options.dataRoot } : undefined);
    return await evaluateJevShadow(state, options);
  } catch {
    return unavailable(state, startedAt, now, 'invalid_state');
  }
}

export function formatJevShadowMarkdown(signal) {
  return `## Jev Signals (shadow)\n\n\`\`\`json\n${JSON.stringify(signal, null, 2)}\n\`\`\``;
}

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function parseCliArgs(argv) {
  const result = { input: null, markdown: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--input') result.input = argv[++i] ?? null;
    else if (argv[i] === '--markdown') result.markdown = true;
  }
  return result;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  let signal;
  try {
    const raw = args.input ? fs.readFileSync(args.input, 'utf8') : await readStdin();
    signal = await collectJevShadow(JSON.parse(raw));
  } catch {
    const now = Date.now;
    const startedAt = now();
    signal = unavailable(null, startedAt, now, 'invalid_state');
  }
  console.log(args.markdown ? formatJevShadowMarkdown(signal) : JSON.stringify(signal, null, 2));
}

if (isMainModule(import.meta.url)) await main();
