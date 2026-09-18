# Foundation test pass — 2026-09-18

Task 9B. A deliberate, written-up test of the whole Foundation against real data, run before the
stack is containerised. Everything below was run against local Postgres, the live QA DRMS instance
and live Vantage Online. No customer names appear; counts, serials and DRMS ids do.

**Verdict: the Foundation works end to end.** Every job succeeds, every page renders, every number
on screen matches a direct SQL count. Three defects were found and fixed during the pass, and four
issues are recorded for later. Nothing found is a reason to hold the next sub-project.

Fleet at the time of the run: 836 DRMS devices (293 Registered, 541 Discovered, 2 Deleted), 1,826
active Vantage equipment, 886 active Vantage customers, 829 active links, 198 devices with counters.

---

## Part A — end-to-end worker run

The worker migrated cleanly on start (migration `0006_equipment_is_colour` applied), logged
`[worker] ready`, and seeded nothing unexpected.

Each job was queued once via pg-boss and waited on. Times are wall-clock from `sync_runs`.

| Job | Status | Time | Stats |
|---|---|---|---|
| `vantage-pull` (forced full) | success | 11.9s | 886 customers, 1,826 equipment, 0 marked deleted |
| `drms-pull` | success | 3.9s | 245 customers, 836 equipment, 3 alerts opened, 0 marked missing |
| `link-run` | success | 0.2s | 829 active links, 0 created, 0 closed, 0 issues opened |
| `drms-alarms` | success | 0.1s | 11 fetched, 10 inserted (toner 4, waste 5, parts 1, jam 1) |
| `drms-snapshot` | success | 0.0s | 0 devices — see finding 2 |
| `vantage-orders` | success | 4.3s | 2 orders, 1 line (incremental) |

Nothing was `failed`, and nothing was `partial`. The full Vantage pull is the one worth calling
out: it marked **zero** rows deleted, which is the deletion guard behaving — it refuses to mark
anything deleted unless the pull returned at least 80% of the currently active rows.

### Idempotency (step 5)

`drms-pull` and `drms-alarms` were run a second time:

| Check | Expected | Result |
|---|---|---|
| Alarm rows before / after | unchanged | 144 → 144 |
| Alarms fetched / inserted on the second run | fetched > 0, inserted 0 | 10 fetched, **0 inserted** |
| `markedMissing` | 0 | 0 |
| `alertsOpened` on the second run | 0 | 0 |

### Verification counts (step 4)

| | |
|---|---|
| DRMS devices by status | Discovered 541, Registered 293, Deleted 2 |
| Colour capability | 815 colour, 21 mono |
| Vantage | 1,826 equipment active (1,826 total), 886 customers active |
| Active links by method | serial 566, ERP id 263 |
| Open link issues | no Vantage match 997, no DRMS match 4, duplicate target 1, broken link 1 |
| Counters | 220 snapshots over 198 devices, 14,230 counter values, 83 counter names (7 categorised) |
| Alarms by category | toner 66, jam 29, waste 26, parts 13, service 9, other 1 |
| Alerts | 37 open, 0 cleared, 0 acknowledged |
| Sales orders | 7,131 orders, 9,248 lines, 166 open, 0 created by MPS |

The jump in ERP-id links (39 → 263) is the registration work: registering a device writes its
Vantage equipment id into DRMS as `EquipmentErpId`, so those devices now match on ERP id rather
than falling back to the serial.

### Schedules and queue options (step 6)

Read back from pg-boss, not from the code:

| Queue | Cron | Timezone | Policy | Retries | Expiry |
|---|---|---|---|---|---|
| `vantage-pull` | `0 2 * * *` | Europe/London | stately | 0 | 3600s |
| `drms-pull` | `15 * * * *` | Europe/London | stately | 0 | 3600s |
| `drms-snapshot` | `30 13 * * *` | Europe/London | stately | 0 | 7200s |
| `drms-alarms` | `*/30 * * * *` | Europe/London | stately | 0 | 1800s |
| `vantage-orders` | `40 2 * * *` | Europe/London | stately | 0 | 3600s |
| `link-run` | (none — queued by the pulls) | — | stately | 0 | 1800s |

All correct, including the per-queue expiry times that replaced pg-boss's 15-minute default, and
`retryLimit: 0`, which is what keeps a DRMS 429 from ever being retried.

**Deviation from the brief:** the worker was left running at the end rather than stopped, because
the dashboard is in daily use on this machine while the remaining sub-projects are built.

---

## Part B — page-by-page UI walkthrough

### Authentication

| Check | Result |
|---|---|
| All 11 routes while signed out | every one 307 → `/login` |
| Wrong password | rejected, and **no session cookie issued** |
| Admin-only routes while signed out | redirect, same as the rest |

Operator lockout (an operator signing in and being refused every admin page, including a forged
action POST) was verified under Task 9 and re-reviewed then; it was not repeated here.

### Fleet overview — every number cross-checked against SQL

| On screen | SQL | |
|---|---|---|
| 836 devices | 541 + 293 + 2 | ✅ |
| Needs toner 132 (82 critical, 50 low) | 132 | ✅ |
| No meter reading 37 | 37 stale | ✅ |
| Open link issues 1,003 | 997 + 4 + 1 + 1 | ✅ |
| 762 cartridges across 195 devices | 762 / 195 | ✅ |
| 560 healthy + 95 low + 107 critical | = 762, the bar adds up | ✅ |

The preview table leads with the worst devices, which is the right order for a toner table.

### Devices

| Check | Result |
|---|---|
| Search by serial `ADXW021003203` | 1 device, subtitle "1 device matching …" |
| Search with no matches | "0 devices matching", empty state "No devices match …" |
| `needs-toner` filter | 132 devices, matching the overview tile exactly |
| Out-of-range page (`page=999`) | redirected to the real last page (3) |

### Device detail

| Case | Result |
|---|---|
| Mono with counters (`bizhub 4701i`) | one Black tile, **no CMY**; Meters show Black + Scan only, no dead Colour column |
| Colour with counters | four tiles, three meters |
| Registered, no counters yet | "DRMS has not returned a counter set for this device yet", meters em-dashed with an explanation |
| Alarms across 4 categories | grouped by category with codes and dates |
| No meter reading | red banner with Acknowledge, and the age of the last reading |

### Actions

| Action | Result |
|---|---|
| Acknowledge an alert | Open 37 → 36, Acknowledged 0 → 1; `acknowledged_by` and `acknowledged_at` written. **Reverted afterwards** — nobody actually reviewed that alert. |
| Ignore an issue | 6 → 5 open, All 1,003 → 1,002, Broken link tab disappears |
| Reopen it from the Ignored tab | back to 6 open, All 1,003 — database restored exactly as found |
| "Run now" on `link-run` from Admin | queued, ran in 290ms, success, stats visible in Recent runs |

The link picker's search, and linking a device by hand, were **not** exercised: there is currently
no genuinely correct pairing available to make (every Registered device is already linked, and
there are no `customer_mismatch` issues), and the brief's alternative — deliberately making a wrong
link and undoing it — was judged not worth the risk against live data on the same day the fleet was
registered. Recorded as untested.

### Console

No errors on any page. The only console output across the overview, devices, issues, alerts and
admin pages was React DevTools' banner and Next's HMR notice.

---

## Defects found and fixed during the pass

**1. Admin → Jobs advertised schedules that no longer existed.** The six job cards carried their
schedules as hardcoded strings while the worker reads them from environment variables, so they had
drifted badly:

| Job | Page said | Actually |
|---|---|---|
| DRMS pull | Daily at 02:15 | hourly, at 15 past |
| DRMS alarms | Hourly | every 30 minutes |
| DRMS counter snapshot | Daily at 06:00 | 13:30 — the time deliberately chosen because CSRC collects across Europe in the morning |

An admin reading that page would have been told the wrong thing about when their data refreshes.
Fixed: the page now reads the crons pg-boss actually registered and renders them through a
`cronLabel` formatter (17 tests), falling back to the card's own text only for `link-run`, which has
no cron. The static fallbacks were corrected to the worker's real defaults at the same time.

**2. The counter snapshot skips devices registered after that day's run.** `drms-snapshot` stamps
`last_snapshot_fetch_at` on every device it asks about — including Discovered devices that return
nothing — so a device registered *after* a day's run is treated as "already fetched" and waits until
the next day. Found live: today's 95 newly registered devices were skipped. Cleared the stamp for
them by hand and re-ran; all 95 were fetched and all returned empty, because DRMS had not yet
collected counters for devices registered the same day. It self-corrects daily, so this is a
**recorded fix, not applied**: the job should only stamp a device whose fetch actually returned a
response. Small, and belongs with the next piece of snapshot work.

**3. Two stale doc comments and a subject-verb slip** in the collection-outage code, from the
proportional-rule change earlier the same day. Fixed in `82caadc`.

## Recorded, not fixed

1. **The DRMS token never expires.** The admin page reads "Valid until 14 Jan 2100", so the 14-day
   expiry warning can never fire. Harmless on QA; worth re-checking against whatever token
   production is issued, because the warning is the only thing that would catch a real expiry.
2. **Only 7 of 83 counter names are categorised.** Fine for now — the three meters and four toner
   levels are the ones the app uses — but sub-projects 2 and 3 will want more of them classified.
3. **997 "no DRMS match" issues** are Vantage equipment that simply isn't monitored. The queue
   already hides them behind their own tab with a note, which is the right call, but the number will
   keep growing and may deserve a "not monitored" state of its own rather than an open issue.
4. **`vitest`'s 10s `hookTimeout`** is too tight for a PGlite cold start on this machine; DB test
   files occasionally flake and pass with `--hookTimeout=60000`. Pre-existing and unrelated to any
   task in this plan.

## Not tested here

- Linking a device by hand and the link picker's search (see above).
- Operator lockout (covered by Task 9).
- Anything to do with deployment: Docker, Portainer, and running the worker and web as separate
  containers. That is Task 10, deliberately left until last.
