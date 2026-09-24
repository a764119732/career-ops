# Connected Chrome application workflow

Computer Use is an agent boundary, not a Node service. Run it only inside a Codex task.

1. Initialize Computer Use and obtain current state. Select the connected Chrome browser dynamically; never hardcode a browser ID.
2. Locate or open the exact job/application URL and verify company, role, and Job ID.
3. Follow Apply redirects, then inspect the actual form host and every field.
4. Avoid material edits to global JobsDB Profile data. Existing saved profile data may be read; material changes are `NEEDS_REVIEW`.
5. Upload the exact CV path recorded for this Job ID.
6. Resolve each field against `data/autopilot/config.yml`. A single unknown or YELLOW field prevents automatic submission but does not block other jobs.
7. Re-read all populated values, uploaded filename, salary, work rights, experience, and notice period.
8. Immediately before the final click, re-read the form and confirm the browser state is certain. Run `node autopilot.mjs begin-application --job <key> --browser-certain true --final-review-matches true`. For a GREEN job this is the final authorization: do not ask for another human confirmation. Click Submit exactly once.
9. Require a visible success page/message/status tied to this application; record it with submission-result confirmed. Record the exact confirmation text.
10. If the click result is missing, stale, timed out, or ambiguous, record `uncertain`; never click Submit again.

Classify CAPTCHA, Cloudflare, login, MFA, or access challenges as `BLOCKED_USER_ACTION`. Do not bypass them. Classify temporary navigation/provider failures as transient and use the bounded retry configured in YAML.

For Cloudflare, run `block-application --reason-code CLOUDFLARE_VERIFICATION --step <step> --application-url <safe-url>`. For file upload `Not allowed`, run the same command with `CHROME_FILE_UPLOAD_PERMISSION`. Preserve the recorded CV and completed answers. Do not change Chrome settings; tell the user to resolve the challenge or enable the ChatGPT extension's **Allow access to file URLs** permission. Then run `resume-application --job <key>` and continue from the returned checkpoint. If Submit may already have been clicked, record `uncertain` instead; never use the block/resume path to authorize a second click.
