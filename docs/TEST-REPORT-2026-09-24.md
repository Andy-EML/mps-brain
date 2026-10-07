# Replenishment test pass — 2026-09-24

Task 14 (sub-project 3: replenishment), step 1 (full automated test pass) and step 5 (this report
and handoff). Base commit `2b8a041` (`feat/replenishment`, off `feat/foundation-web`). Steps 2–3
(worker end-to-end + UI pass against real data) are **PENDING USER** and step 4 (live ordering) is
**DEFERRED TO ROADMAP** by the user — see below. Nothing in this pass touched a real database,
started a server, or called Vantage/DRMS.

**Verdict: the automated suite is green.** 716 tests across 56 files, `tsc --noEmit` clean in all
7 workspaces, `eslint .` clean, and `next build` for `apps/web` succeeds (17 routes). One flake
noted in the SDD ledger (T11, T17) was reproduced and fixed during this pass (see below).

## Step 1 — `npm test`, `npm run typecheck`, `npm run lint`, `npm run build -w @mps/web`

| Command | Result |
|---|---|
| `npm test` (first run) | **3 failed / 716** — see "PGlite hookTimeout" below |
| `npm test` (after the fix) | **716 passed, 56 files, 0 failed** |
| `npm run typecheck` | clean — `@mps/web`, `@mps/worker`, `@mps/core`, `@mps/db`, `@mps/drms`, `@mps/queue`, `@mps/vantage` all pass `tsc --noEmit` (web also regenerates route types) |
| `npm run lint` | clean — `eslint .`, no output, exit 0 |
| `npm run build -w @mps/web` | succeeds — Next.js 16.3.5 (Turbopack), `next build`, 17 routes (14 dynamic, 2 static, `_not-found`) |

### PGlite "Hook timed out" — reproduced and fixed

The ledger (T11, T17) noted intermittent PGlite `beforeEach` timeouts in the full combined run
that don't happen when the failing file is run alone. The first `npm test` run in this pass hit
exactly that, in three different files, each in its own package:

- `apps/worker/src/jobs/drms-registration-submit.test.ts` — "keeps polling through a failed poll read"
- `packages/db/src/queries/queries.test.ts` — "honours a custom staleness threshold"
- `packages/db/src/queries/replenishment.test.ts` — "resolves an uncertain order either way and retries a failed one"

All three failed in `beforeEach` with `Error: Hook timed out in 10000ms`, calling `createTestDb()`.
This is Vitest's default `hookTimeout` (10s), which is too tight for a PGlite cold start when many
test files each spin up their own instance inside one combined run on this machine — the same cause
recorded in `docs/TEST-REPORT-2026-09-18.md` #4 for the Foundation suite.

**Fix:** added `hookTimeout: 60_000` to `vitest.config.ts` (`testTimeout` was already raised to 30s;
`hookTimeout` had never been set, so it was still Vitest's 10s default). Re-ran `npm test` from a
clean process: **716/716 passed, 56/56 files**, including the three files above, in 289.4s. This
only widens the ceiling for setup/teardown hooks — a genuinely hung hook still fails the suite.

```diff
     include: ['packages/*/src/**/*.test.ts', 'apps/worker/src/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
     testTimeout: 30_000,
+    hookTimeout: 60_000,
```

## Step 2 — Worker end-to-end against local Postgres: **DONE 2026-09-25**

Branch worker run from the worktree; it migrated the local DB on boot (0008 applied, 9 migrations).
`drms-alarms` and `vantage-orders` queued by hand (`sync_runs` 486–487, both success), then
`replenish-evaluate` (488, success; two triggers folded into one by the stately queue): devices 833,
proposed 251, superseded 39, suppressed 230. All four sanity checks PASS — 377 pending proposals on
275 devices, no CMY on mono devices, none alongside an open order. The SQL and results are in
`docs/TEST-REPORT-2026-09-25-replenish-sanity.md`.

Finding carried forward: a pending **alarm-triggered** proposal never supersedes itself when its
alarm ages out of the 7-day window (only threshold proposals recover, `replenish-evaluate.ts`
around line 133). Five from 2026-09-21 sit in the queue for that reason.

## Step 3 — UI pass: **DONE 2026-09-25 to 2026-10-07, with the user**

The user worked through `/orders` on real data from the branch web app. Changes it produced, all on
this branch: accordion review list (`0ed1a0d`), every toner level on the review chips (`56ba575`),
device back-navigation and recent sales orders on review (`cc01c25`), "Run all" on the Jobs page
(`e09fdf9`), and the mono toner classification fix found along the way (`35403c7`, with the
one-off `reclassify-order-lines.ts --apply` run by the user: 58 lines unknown → black).

## Step 4 — Live ordering: **DEFERRED TO ROADMAP by the user**

The user deferred live Vantage ordering (spec Task 1 step 7, plan Task 8, and this step) to the
roadmap (ledger, 2026-09-21 ~15:45: "DEFER live ordering to the roadmap — do NOT do T1 step 7 or T8
now. T14 runs without live enablement."). Nothing in `feat/replenishment` calls
`createConsumableOrder` automatically: it exists only on the Vantage client and is called only by
the plan-mandated `probe-consumable-order.ts` script, which nothing runs by itself. The
`vantage-order-submit` worker job and the `VANTAGE_ORDERS_ENABLED` kill switch described in the spec
are **not built yet** — that is exactly what Task 8 will add. `CLAUDE.md` has been updated with the
rule for when that lands (see below).

**Before live ordering is ever enabled:** clear or confirm any stale `queued`/`approved` orders
first (approvals made while the switch was off would otherwise all send at once the moment it's
turned on), check whether the live `.env`'s `ORDERS_CRON` still says the old nightly schedule
(`40 2 * * *`) rather than the current hourly default (`20 * * * *`, `.env.example`), and make sure
nobody runs a hand registration batch (`run-batch.sh`) while the app's registration sender has
approved rows waiting — both are recorded in `docs/HANDOFF.md`.

## Recorded, not fixed

Everything below was already recorded on the SDD ledger (`.superpowers/sdd/2026-09-21-replenishment/progress.md`)
or in the final whole-branch review (`final-review.md`) and ruled **OK-TO-DEFER** — summarised here,
not re-litigated. Two Important findings from the final review (registration-sender overlap past a
6h job expiry; the registration scan not stopping on a real Vantage 429) were **not** deferred —
they were fixed in the final fix wave (commit `2b8a041`) before this pass started.

**By area:**

- **DRMS registration (T1, T16):** `post()`/`get()` duplicate their header/401 structure
  (deliberate, for readability); a scan can refresh the awaiting payload between view and approval
  (the submit pre-check re-reads DRMS live, so this is safe); `drmsStatusAfter` display format is
  inconsistent; DRMS-rule failures are invisible in the UI (a product question for the user); the
  `CUST` prefix isn't enforced (matches the reference script); `changedSinceApproval` compares
  `Serial`/`CsrcId` with `===` while `ErpId` is normalised (fails closed, which is safe);
  `isLiveClash` only walks 4 `.cause` levels (enough for the DB error wrapping actually seen).
- **Replenishment engine (T2–T7):** a per-device upsert/insert loop instead of a bulk statement (at
  current fleet scale, fine); `audit(tx as unknown as Db)` double cast (typing only); no-op
  ternaries and an unused parameter in `evaluateDevice`/`alarmColour`; the `unlinked` stat
  re-derives engine logic outside `evaluateDevice`; a retry clash-check race backstopped by a unique
  index; rejecting a failed proposal overwrites `decidedBy`/`decidedAt` (the audit log keeps the
  history); `resolveOrder` checks the reference before the not-found case; a couple of test-coverage
  gaps (in-transaction race, device/customer `thresholdSource` in the queue).
- **Web UI (T9–T13, T15, T17):** cosmetic-only items — a pending-label wording edge case, an
  untested trivial label map, Enter-in-an-empty-quantity-box (server-validated, friendly error), no
  component tests (repo convention), `formatDate` prints "Sept", a stale `reviewError` on reopen, no
  upper bound on one `inArray` id list (fleet is far below the practical limit), settings-dialog UX
  polish (add-dialog hints, 1-char search message, soft-deleted-customer override), `%`/`_` not
  escaped in one search box (matches `/devices`), a sidebar group-by query re-run per request
  (indexed), and two card-display duplications (customer name repeated when `displayName` falls
  back; a sidebar label only shown as a tooltip).
- **Roadmap-only:** a 2xx Vantage response with a non-JSON body becomes `ParseError` rather than
  uncertain — relevant once the submit job (Task 8) exists; `probe-consumable-order.ts` doesn't
  validate its `qty` argument — fix when Task 8 is picked up.
- **Operational, not code:** DRMS batch-13 (outside this branch) has 2 stragglers needing KM or a
  CSV fix — tracked in memory, not this repo.

None of the above changed behaviour that Step 1's suite exercises, and none blocks steps 2–3.

## Not tested here

- Everything in steps 2–4 above (worker-against-real-data, UI-against-real-data, live ordering).
- Anything requiring `.env`, a live DB migration, a running server, or a live Vantage/DRMS call —
  out of scope for this pass by the controller's instructions.
