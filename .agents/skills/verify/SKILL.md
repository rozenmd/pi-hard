---
name: verify
description: Verify changes to Dolly itself with static checks and integration-first behavioral proof. Use when changing this repository or choosing verification coverage; not for workloads Dolly runs.
---

# Verify Dolly changes

## Non-negotiable: fix everything verification flags

**Every problem verification reports must be fixed before you proceed: before committing, pushing, opening or updating a PR, or reporting the work as done.** That covers lint errors, type errors, failing tests, broken builds and missing required evidence such as screenshots.

- **It does not matter who caused it.** Pre-existing failures, failures inherited from `main`, failures from a merge and failures in files your change never touched all count. "Not my error", "unrelated" and "already broken on main" are never reasons to leave something broken. We all work toward the same goal: a green repository.
- **Reporting a failure does not resolve it.** Listing it in a PR description, a summary or a "known issues" note is not a substitute for fixing it.
- **Do not suppress problems to pass.** Disabling lint rules, adding `@ts-ignore` or `as any`, skipping tests or weakening assertions are not fixes unless the check is genuinely wrong. If it is, say why in the change.
- **Stop only when you are truly blocked.** If a fix needs access, credentials, network hosts or a product decision you don't have, stop and tell the user exactly what is blocked and what you need. Do not quietly continue past the failure.
- **Fix it in the current branch.** If the fix is large, ask the user whether it should go in a separate PR first; until they answer, the work is not done.

1. Name the changed behavior, affected callers and observable pass condition. Reproduce a bug through the affected boundary before fixing it; establish a known-good baseline for a refactor.
2. Run `pnpm verify` for formatting, lint and root/infra/web typechecks. It does not run tests, build, deploy or contact live product services. Inspect the diff after any generation commands. `pnpm check` is not the static-only equivalent: it also runs frontend unit tests.
3. Prove changed behavior primarily with integration tests through real boundaries: HTTP handlers, Durable Objects/storage, built Worker routing, containers, Git, turn-end checkpoint recovery and dependency caching. Choose the affected scenarios and relevant failure cases; widen coverage for shared contracts. Add or extend integration coverage when the existing harness does not exercise the change.
4. Use a small number of browser or live end-to-end journeys for critical behavior that needs them. Existing Playwright tests intercept API/WebSocket traffic: they prove browser interactions against fixtures, not real backend operations. Static checks and mocked internal behavior are not integration proof.
5. Record the scenario, commands, observed output and side effects. State which boundaries were real, simulated or mocked. For visible UI changes, capture desktop and phone before/after screenshots or an interaction recording; this is required, not optional, and a broken screenshot tool is a blocker to report, not a step to skip. Preserve evidence and clean up only resources the run created.
6. Report results and gaps in the PR. Failed, skipped, unavailable or unexercised scenarios are unverified, not passes. Fix every failure, including pre-existing and inherited ones (see the non-negotiable rule above). Never claim live-system proof from local or fixture-backed tests.

## Coverage policy

Static checks are the baseline. Roughly 90% of behavioral coverage should come from integration tests, with a small end-to-end layer; this is a design preference, not a test-count quota. Unit tests are not part of this verification workflow. Do not add unit tests or run unit suites merely to satisfy a verification checklist. Existing unit suites and CI remain unchanged.

Verification follows the diff, not a mandatory final full-repository run. Reuse evidence while its inputs remain unchanged. Use the existing harnesses before adding infrastructure; do not replace a real boundary with a mock just to make a test pass.

## Commands and safety

- `pnpm test:integration:worker`: build the test Worker and exercise real bundled HTTP/SSR routing and Worker-side Access enforcement, without Playwright.
- `pnpm test:sandbox`: exercise container, Git, turn-end checkpoint recovery and dependency-cache integration paths; requires Docker.
- `pnpm test:worker`: Worker integration checks followed by fixture-backed browser tests. It is not a live end-to-end suite.
- `pnpm build`: production packaging and deployment dry runs, including ingress and the sandbox image; not a deployment.

Local workerd/Miniflare is not deployed Cloudflare. Live Access edge policy, provider inference and Browser Run connectivity need explicitly authorized live verification. Never deploy, change Access infrastructure, use real subscription inference or mutate live resources merely to complete verification. Use isolated test resources and agreed cleanup.

`test:integration:worker` and `test:worker` leave test build artifacts with a local Access bypass and substituted bindings. Never deploy those artifacts; rebuild the intended production configuration immediately before deployment.

Read [the verification reference](../../../tools/verify/README.md) for coverage boundaries and focused commands. This skill is repository development guidance only: do not install it into Dolly's runtime prompts, tools or workload repositories.
