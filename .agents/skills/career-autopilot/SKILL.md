---
name: career-autopilot
description: Run the persistent Career-Ops Hong Kong discovery-to-application queue, including policy gates, CV QA, connected-Chrome Computer Use, follow-ups, and interview-triggered pausing. Use for recurring or resumable autopilot runs, not a one-off job evaluation.
---

# Career Autopilot

## APPLICATION-FIRST / INTERVIEW-FIRST (persistent default)

The primary outcome is a confirmed real application and the first interview invitation. Process executable `READY_TO_APPLY` jobs before scans, repeat scoring, CV cosmetic edits, old `NEEDS_REVIEW`, doctor/tests/update checks, or maintenance. Reuse a QA-passed CV unless it is missing or clearly invalid. The CLI skips scans when an executable READY job exists and returns application actions first. Only scan and evaluate when no executable application remains. A credible interview signal pauses submissions and takes priority for interview preparation.

For a specific READY job with no `runLock`, use `node autopilot.mjs resume-job --job <key> --json`; otherwise use `node autopilot.mjs run --json`. Process at most two confirmed submissions per logical run, within the existing daily and company caps. Do not reread memory or old rollouts, run doctor/tests/update checks, upgrade the system, or repeat a full evaluation of a GREEN/READY job. Start Computer Use only for actual application work.

Answer ordinary low-risk form choices autonomously from verified facts and approved answers. Ask or block only for CAPTCHA/Cloudflare/MFA/login; an unknown mandatory objective candidate fact; legal/criminal/compliance declarations; mandatory unknown GPA or grade; mandatory numeric current salary without a verified amount; major long-term financial responsibility; uncertain Submit result; or an approval quota that prevents execution. An optional or non-material unknown does not stop another GREEN application. A text current-salary field may use `N/A / Not applicable (currently not employed)`; never put HK$0 or expected salary into a numeric current-salary field. Do not turn project work into formal employment.

For GREEN with a matching final review, the single final Submit click is already authorized. Click at most once. Record `APPLIED` only on explicit success evidence. If the outcome is uncertain, do not retry. Always release the run lock with `finish-run` when the cycle ends.


Resolve `PROJECT_ROOT` by walking up from this file to the nearest directory containing `AGENTS.md` and `modes/`. Run all commands there.

For scheduled or ephemeral runs, persisted project files are authoritative. Do not read Codex `MEMORY.md`, rollout history, or old conversation history unless an explicit recovery task requires them.

## Start or resume

1. Enter `PROJECT_ROOT`.
2. Read only `data/autopilot/config.yml` and `data/autopilot/state.json`.
3. Run `node autopilot.mjs run --json` and inspect the returned actions. Under APPLICATION-FIRST, the CLI defers scanning and new evaluation while an executable READY job exists. The CLI owns durable run identity, concurrency locks, deduplication, limits, retries, event logs, follow-up due dates, and interview pausing. If it returns `locked: true`, exit without starting browser work.
4. Lazy-load context for each returned action:
   - Evaluation: read [references/policy.md](references/policy.md), then only the candidate facts and evaluation files required for that job.
   - CV generation or QA: read `cv.md`, `config/profile.yml`, and only the relevant mode files.
   - Application: only when the durable job state reaches `READY_TO_APPLY`, read [references/browser.md](references/browser.md) and the Computer Use instructions, then initialize Computer Use. If no action requires browser work, do not initialize Computer Use.
5. Process every returned item independently. Before each application-producing action, run `node autopilot.mjs cycle-check`; if `budget_reached` is true, stop the cycle without starting another job. One failure must not stop later jobs. After all returned actions are handled, run `node autopilot.mjs finish-run`.

Use the existing career-ops flows instead of rebuilding them:

- Discovery: `scan.mjs` and `data/pipeline.md`.
- JD and fit: `fetch-jd.mjs`/`browser-extract.mjs`; after deterministic gates and before A-G, run `node autopilot.mjs prepare-evaluation --job <key> --jd-file <complete-jd-file>` and preserve its shadow block outside Machine Summary. Then run the existing A-G mode and record with `node autopilot.mjs record-evaluation --job <key> --score <0..100> --evidence <report>`. Shadow failure never blocks evaluation; `record-evaluation` supplies the code-level report fallback.
- CV: existing `pdf`/`text` workflow, `verify-cv-facts.mjs`, `verify-ats.mjs`, and PDF checks. Use a deterministic new filename containing the provider Job ID; never overwrite a submitted artifact. Record with `node autopilot.mjs record-cv --job <key> --source <path> --pdf <path> --qa pass`.
- Application answers: use approved answers and verified candidate sources. Resolve ordinary low-risk choices autonomously; only material mandatory unknowns and the listed stop conditions become `NEEDS_REVIEW`. Continue other jobs. Use `node autopilot.mjs review` for the deduplicated review queue.
- After a browser attempt, record exactly one outcome with `submission-result`. Only `confirmed` with visible success evidence may become `APPLIED`.

## Submission gate

Submit only when all are true:

- durable state is `READY_TO_APPLY`;
- fit score is at least the configured threshold;
- decision is GREEN and every form answer is approved;
- CV factual, ATS, and PDF QA passed;
- auto-submit mode is `ENABLED`;
- daily and same-company limits remain;
- no CAPTCHA, Cloudflare, login challenge, material global JobsDB Profile edit, or uncertain prior Submit result exists.

Immediately before the final click, record browser certainty and the matching final review with `begin-application --browser-certain true --final-review-matches true`. Once every GREEN gate passes, the single final Submit click is already authorized; do not ask for another confirmation. Click exactly once and require explicit success evidence.

If any condition fails, do not click Submit. Set `NEEDS_REVIEW` or `BLOCKED_USER_ACTION` and continue. For Cloudflare use reason code `CLOUDFLARE_VERIFICATION`; for Chrome file-upload `Not allowed`, use `CHROME_FILE_UPLOAD_PERMISSION`. Persist the step, safe application URL, CV and completed answers with `block-application`; do not regenerate the CV or consume allowance. After the user resolves it, run `resume-application` and resume the same logical run/checkpoint.

After visible submission confirmation, record the result, update the existing tracker through its canonical tools, persist `## Application Answers`, and seed the follow-up. Then run `node autopilot.mjs tracker-recorded --job <key> --tracker-row <number>` so the durable tracker action is not replayed. Never infer success from a click or retry an uncertain final click.

## Stop conditions

Stop new submissions when the CLI mode is `PAUSED`, an interview is detected, credentials are required, or the connected browser cannot be trusted. Scan only when no executable application remains. CAPTCHA, Cloudflare, and login challenges require the user; never bypass them.

For a read-only simulation, run `node autopilot.mjs run --dry-run --no-scan --json`.
