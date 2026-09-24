# Policy and state reference

`data/autopilot/config.yml` is authoritative for targeting, approved answers, salary bounds, limits, retries, and auto-submit. Candidate facts remain in `config/profile.yml` and `cv.md`; generated CV wording is never a fact source.

## Application-first priority

The persistent default is `APPLICATION_FIRST_INTERVIEW_FIRST`. Complete executable `READY_TO_APPLY` applications before new scan, re-scoring, CV cosmetic changes, or review of older YELLOW items. Keep the existing limit of two confirmed submissions per run. A GREEN job with an existing QA-passed CV proceeds to the real form; do not regenerate it for minor layout preferences. Scan only when no executable application remains. Interview signals pause submissions and take priority for interview preparation.

Use confirmed candidate facts and approved answers for ordinary low-risk choices. Escalate only CAPTCHA/Cloudflare/MFA/login, unknown mandatory objective facts, legal/criminal/compliance declarations, mandatory unknown GPA or grade, mandatory numeric current salary without a verified amount, major long-term financial responsibility, uncertain Submit, or approval quota failure. Never guess or enter HK$0 for current salary. A text field may use `N/A / Not applicable (currently not employed)`. The final GREEN Submit needs no repeat confirmation, is clicked once, and requires explicit success evidence before `APPLIED`.

## Decisions

- GREEN: every answer is explicitly approved, score and limits pass, CV QA passes, and no external blocker exists.
- YELLOW: a listed material blocker or a mandatory answer that cannot be supported by verified facts. Persist `NEEDS_REVIEW` and continue with other jobs.
- RED: duplicate/already applied, closed, below threshold, impossible hard requirement, unsupported core specialization, or false information. Persist `SKIPPED` with evidence.

Do not convert project work into formal employment. Do not strengthen languages, visas, certifications, technical ownership, or years of experience.

## Durable states

The CLI owns these states in `data/autopilot/state.json`:

`DISCOVERED -> EVALUATED -> SHORTLISTED -> READY_TO_APPLY -> APPLICATION_IN_PROGRESS -> APPLIED`

Side exits are `NEEDS_REVIEW`, `BLOCKED_USER_ACTION`, `RETRY`, and `SKIPPED`. `FOLLOW_UP_DUE` and `INTERVIEW_DETECTED` are post-application states.

After a restart, interrupted local generation/QA may retry. `APPLICATION_IN_PROGRESS` never retries automatically because the final submission result may be uncertain.

Each logical run has a stable `runId`, original `startedAt`, fixed per-run cap, confirmed-submission count and submitted Job IDs. Resume never resets them. A persistent run lock prevents overlapping application-producing cycles; a stale lock may be recovered only after the configured conservative timeout and only when no submission result is uncertain.

`NEEDS_REVIEW` items are accumulated and deduplicated by job, reason, questions and evidence. An unchanged item is not notified again on every cycle. Review never blocks later GREEN jobs and is never auto-answered.

## Interview watch

Use only configured adapters. A signal must contain an interview/assessment phrase and correlate to an existing application by company or role. Generic marketing mail does not count. A credible match sets `INTERVIEW_DETECTED`, pauses auto-submit, retains scanning, and queues interview preparation. Do not claim Gmail coverage unless a Gmail adapter is actually configured.
