#!/usr/bin/env node

import {
  existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import {
  buildJevShadowInputHash,
  buildJevShadowState,
  evaluateJevShadow,
  formatJevShadowMarkdown,
  JEV_REQUESTED_MODEL,
  JEV_SHADOW_SCHEMA_VERSION,
} from './jev-shadow.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const inFlight = new Map();

function cacheFile(cacheDir, inputHash) {
  return join(cacheDir, `${JEV_SHADOW_SCHEMA_VERSION}-${inputHash.slice('sha256:'.length)}.json`);
}

function readCached(path, inputHash) {
  try {
    const signal = JSON.parse(readFileSync(path, 'utf8'));
    return signal?.status === 'ok'
      && signal.schema_version === JEV_SHADOW_SCHEMA_VERSION
      && signal.input_hash === inputHash ? signal : null;
  } catch {
    return null;
  }
}

function writeCached(path, signal) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(signal, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, path);
  } catch {
    // Cache failure must never interrupt the existing evaluation path.
  }
}

function unavailableSignal(state, inputHash, errorType, startedAt) {
  return {
    schema_version: JEV_SHADOW_SCHEMA_VERSION,
    input_hash: inputHash,
    requested_model: JEV_REQUESTED_MODEL,
    actual_model: null,
    timestamp: new Date(startedAt).toISOString(),
    sales_nature: null,
    language_barrier: null,
    semantic_job_fit: null,
    needs_human_review: null,
    extraction_completeness: {
      source: state.job.extraction.source,
      complete: state.job.extraction.complete,
      truncated: state.job.extraction.truncated,
      liveness: state.job.extraction.liveness,
    },
    api_latency_ms: Math.max(0, Date.now() - startedAt),
    usage: null,
    status: 'jev_unavailable',
    error_type: errorType,
  };
}

async function acquireCacheLock(path, inputHash, options) {
  const lockPath = `${path}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const startedAt = Date.now();
  const waitMs = options.lockWaitMs ?? 32_000;
  const staleMs = options.lockStaleMs ?? 30_000;
  const pollMs = options.lockPollMs ?? 50;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  mkdirSync(dirname(path), { recursive: true });

  while (Date.now() - startedAt <= waitMs) {
    const cached = readCached(path, inputHash);
    if (cached) return { cached };
    try {
      writeFileSync(lockPath, token, { encoding: 'utf8', flag: 'wx' });
      return {
        release() {
          try {
            if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
          } catch {
            // A stale-lock recovery may already have removed it.
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { error: 'cache_lock_error' };
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) unlinkSync(lockPath);
      } catch {
        // The owner may have released the lock between checks.
      }
      await sleep(pollMs);
    }
  }
  return { error: 'cache_lock_timeout' };
}

function markdownSection(markdown, heading) {
  const lines = String(markdown).split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`## ${heading}`));
  if (start < 0) return '';
  const next = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return lines.slice(start + 1, next < 0 ? lines.length : next).join('\n').trim();
}

function reportEnvelope(markdown, metadata = {}) {
  const header = String(markdown).match(/^# Evaluation:\s*(.*?)\s+[—-]\s+(.*?)\s*$/m);
  const url = String(markdown).match(/^\*\*URL:\*\*\s*(\S+)/m)?.[1] ?? null;
  const jdText = markdownSection(markdown, 'Job Description');
  return {
    job: {
      company: metadata.company ?? header?.[1] ?? null,
      title: metadata.title ?? metadata.role ?? header?.[2] ?? null,
      structured_location: metadata.structured_location ?? metadata.location ?? null,
      source_url: metadata.source_url ?? metadata.url ?? url,
      jd_text: jdText,
      extraction: {
        source: metadata.extraction_source ?? 'report_archive',
        complete: jdText.length >= 200,
        truncated: false,
        liveness: metadata.liveness ?? 'unverified',
      },
    },
    deterministic_checks: metadata.deterministic_checks ?? {
      report_exists: true,
      jd_archive_present: Boolean(jdText),
      existing_entrypoint_gates_passed: true,
    },
  };
}

function existingShadow(markdown) {
  const match = String(markdown).match(/^## Jev Signals \(shadow\)\s*\r?\n\s*```json\s*\r?\n([\s\S]*?)\r?\n```/m);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function upsertShadow(markdown, block) {
  const pattern = /^## Jev Signals \(shadow\)\s*\r?\n\s*```json\s*\r?\n[\s\S]*?\r?\n```\s*/m;
  if (pattern.test(markdown)) return markdown.replace(pattern, `${block}\n\n`);
  const jdHeading = /^## Job Description[^\n]*$/m;
  if (jdHeading.test(markdown)) return markdown.replace(jdHeading, `${block}\n\n$&`);
  return `${markdown.trimEnd()}\n\n${block}\n`;
}

function atomicWrite(path, text) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, path);
}

/**
 * Idempotent, observation-only Jev collection. Candidate facts are always
 * loaded by buildJevShadowState() from career-ops canonical sources.
 */
export async function collectEvaluationShadow(envelope, options = {}) {
  const startedAt = Date.now();
  const dataRoot = options.dataRoot ?? getCareerOpsRoot();
  const cacheDir = options.cacheDir ?? join(dataRoot, 'data', 'jev-shadow-cache');
  const state = buildJevShadowState(envelope, { dataRoot });
  const inputHash = buildJevShadowInputHash(state);
  if (!state.job.extraction.complete || state.job.extraction.truncated || !state.job.jd_text.trim()) {
    return {
      signal: unavailableSignal(state, inputHash, 'incomplete_jd', startedAt),
      reused: false,
      source: 'validation',
    };
  }
  const path = cacheFile(cacheDir, inputHash);
  const cached = existsSync(path) ? readCached(path, inputHash) : null;
  if (cached) return { signal: cached, reused: true, source: 'disk' };

  if (inFlight.has(inputHash)) {
    const result = await inFlight.get(inputHash);
    return { ...result, reused: true, source: 'in_flight' };
  }

  const lockedRequest = (async () => {
    const lock = await acquireCacheLock(path, inputHash, options);
    if (lock.cached) return { signal: lock.cached, reused: true, source: 'disk' };
    if (!lock.release) {
      return {
        signal: unavailableSignal(state, inputHash, lock.error, startedAt),
        reused: false,
        source: 'lock',
      };
    }
    try {
      const signal = await evaluateJevShadow(state, options);
      if (signal.status === 'ok') writeCached(path, signal);
      return { signal, reused: false, source: 'api' };
    } finally {
      lock.release();
    }
  })();
  inFlight.set(inputHash, lockedRequest);
  try {
    return await lockedRequest;
  } finally {
    inFlight.delete(inputHash);
  }
}

export async function ensureJevShadowInReport(reportPath, metadata = {}, options = {}) {
  const path = resolve(reportPath);
  const markdown = readFileSync(path, 'utf8');
  const present = existingShadow(markdown);
  if (present?.status === 'ok' && present.schema_version === JEV_SHADOW_SCHEMA_VERSION) {
    return { signal: present, reused: true, source: 'report' };
  }
  const envelope = reportEnvelope(markdown, metadata);
  const result = await collectEvaluationShadow(envelope, options);
  atomicWrite(path, upsertShadow(markdown, formatJevShadowMarkdown(result.signal)));
  return result;
}

export function attachJevShadowToReport(reportPath, signal) {
  const path = resolve(reportPath);
  const markdown = readFileSync(path, 'utf8');
  atomicWrite(path, upsertShadow(markdown, formatJevShadowMarkdown(signal)));
  return signal;
}

export const JEV_SHADOW_RUNNER_META = Object.freeze({
  schema_version: JEV_SHADOW_SCHEMA_VERSION,
  requested_model: JEV_REQUESTED_MODEL,
});

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--markdown') args.markdown = true;
    else if (arg.startsWith('--')) args[arg.slice(2)] = argv[++i] ?? '';
  }
  return args;
}

function bool(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || String(value).toLowerCase() === 'true';
}

async function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  let result;
  if (args['attach-report'] && args['signal-file']) {
    const raw = readFileSync(resolve(args['signal-file']), 'utf8');
    const signal = raw.trimStart().startsWith('{') ? JSON.parse(raw) : existingShadow(raw);
    if (!signal) throw new Error('signal file does not contain Jev shadow JSON');
    attachJevShadowToReport(args['attach-report'], signal);
    result = { signal };
  } else if (args.report) {
    result = await ensureJevShadowInReport(args.report, {}, {});
  } else {
    const envelope = args.input
      ? JSON.parse(readFileSync(resolve(args.input), 'utf8'))
      : {
          job: {
            company: args.company || null,
            title: args.title || null,
            structured_location: args.location || null,
            source_url: args.url || null,
            jd_text: args['jd-file'] ? readFileSync(resolve(args['jd-file']), 'utf8') : '',
            extraction: {
              source: args.source || 'evaluation_wrapper',
              complete: bool(args.complete),
              truncated: bool(args.truncated),
              liveness: args.liveness || 'unverified',
            },
          },
          deterministic_checks: { existing_entrypoint_gates_passed: true },
        };
    result = await collectEvaluationShadow(envelope);
  }
  const text = args.markdown
    ? `${formatJevShadowMarkdown(result.signal)}\n`
    : `${JSON.stringify(result.signal, null, 2)}\n`;
  if (args.output) atomicWrite(resolve(args.output), text);
  else process.stdout.write(text);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    // Shadow collection is never allowed to fail the caller's evaluation.
    const signal = {
      schema_version: JEV_SHADOW_SCHEMA_VERSION,
      input_hash: null,
      requested_model: JEV_REQUESTED_MODEL,
      actual_model: null,
      timestamp: new Date().toISOString(),
      sales_nature: null,
      language_barrier: null,
      semantic_job_fit: null,
      needs_human_review: null,
      extraction_completeness: null,
      api_latency_ms: 0,
      usage: null,
      status: 'jev_unavailable',
      error_type: 'integration_error',
    };
    const args = parseCliArgs(process.argv.slice(2));
    const text = args.markdown
      ? `${formatJevShadowMarkdown(signal)}\n`
      : `${JSON.stringify(signal, null, 2)}\n`;
    try {
      if (args.output) atomicWrite(resolve(args.output), text);
      else process.stdout.write(text);
    } catch {
      process.stdout.write(text);
    }
    if (process.env.JEV_SHADOW_DEBUG === '1') process.stderr.write(`${error.message}\n`);
  });
}
