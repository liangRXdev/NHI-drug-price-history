# NHI Drug Price History — Taiwan NHI Drug Reimbursement Price History

**English** | [繁體中文](README.zh-TW.md)

Shows the complete Taiwan National Health Insurance (NHI) reimbursement price history for each NHI drug code, from 1995-03-01 (the start of NHI) to today, including prices that have been announced but are not yet in effect.

> This site shows NHI reimbursement prices announced by the National Health Insurance Administration (NHIA). They do not represent hospitals' actual purchase prices, retail prices, or patients' out-of-pocket costs.

- Specification (data model and rules): [`spec.md`](spec.md)
- Feature specs: [`spec-upcoming.md`](spec-upcoming.md) (upcoming-changes center), [`spec-compare.md`](spec-compare.md) (multi-code comparison)
- Acceptance criteria (A1–E7): [`.ai-review/plan.md`](.ai-review/plan.md)
- Data source: NHIA "NHI drug item query file" (`A21030000I-E41001-001`); checked weekly, officially updated monthly

## Status

- [x] Phase 1 data layer: ETL, index/history shards, guards, unit tests, CI workflow
- [x] Phase 1 golden manual check: 11 codes / 114 rows checked against the NHIA query site, all matching (2026-09-11); frozen as `tests/fixtures/golden_*.json`
- [x] Phase 2 frontend dashboard: search, summary, hand-drawn SVG step chart, history table, `?code=` deep link, staleness warning, four-state loading and race handling (acceptance record: [`.ai-review/phase2-acceptance.md`](.ai-review/phase2-acceptance.md); `/codex-review` verdict: [`.ai-review/verdict.md`](.ai-review/verdict.md))
  - C2 screenshots passed pharmacist visual review; two E7 items missed target, accepted as-is for the MVP (2026-09-12)
- [x] Live: https://liangrxdev.github.io/NHI-drug-price-history/
- [x] Phase 3: `TFDA-drug-info-search` NHI code table gained a "NHI price history → View ↗" column (2026-09-12, `62de833`, end-to-end verified live)
- [x] Phase 5 multi-code comparison (`spec-compare.md`): comparison basket / multi-series chart / status timeline bands / summary table /
      merged event table / CSV / failure matrix (acceptance record: [`.ai-review/compare-acceptance.md`](.ai-review/compare-acceptance.md);
      6 pharmacist visual checks passed; M17 performance threshold revised from measurements, see spec §8.1)
- [x] Phase 4 upcoming-changes center (`spec-upcoming.md`): `data/upcoming.json`, `?view=upcoming` list, event tags, filter/sort/group, CSV export (acceptance record: [`.ai-review/upcoming-acceptance.md`](.ai-review/upcoming-acceptance.md); pharmacist visual check passed; U14 performance threshold revised from measurements, see spec §8.2)

## Data Semantics (summary)

| Source price | Status | UI |
|---|---|---|
| Positive number | `priced` | Amount |
| `0` / `0.00` | `terminated` | NHI price NT$0 (reimbursement terminated); if never priced before, shown as "no prior priced record" |
| `-` / `－` / `—` | `suspended` | Reimbursement suspended (source marks `-`) |
| Blank | `missing` | No price data in source |
| Other | `malformed` | Malformed data (raw value shown) |

An end date of `9991231` means open-ended. The current price is determined by the frontend from the browser date; detail pages derive it from the full history.

### `data/upcoming.json` (upcoming list)

All records **not yet in effect** as of build date `D` (`from > D`), one row per record; multiple upcoming rows for the same code are not merged.

- Descriptive fields (name / ingredient / strength / dosage form / ATC / supplier) come from the row valid on `D`, not from the upcoming row itself; codes that only have future rows get `null`
- `previousPrice` has event semantics (`null` for termination / suspension continuation per `spec.md` §5.4); `pricedBefore` has state semantics (last priced amount before that row). Both coexist and neither replaces the other
- **The "data build date" (`buildDate`) and the "last checked date" (`status.json`) are different dates**, and a gap of several weeks is normal: `buildDate` only advances when the source changes, the build date crosses an upcoming effective date, or generation rules migrate
- Published or withheld together with `drug_index.json`; any generation or validation failure → exit 1 and nothing is published

## Upcoming-Changes Center (`?view=upcoming`)

A list of announced but not-yet-effective price changes, grouped by effective date, filterable by event type / ATC / effective date / keyword, with CSV export.
Filter state lives only in the URL (shareable, survives reload), not in localStorage.

Known limitations:

1. Only covers records in the NHIA CSV that are **announced and not yet effective**; announcements not yet written into that file will not appear.
2. Data is checked weekly and updated monthly upstream, so the list lags briefly around effective dates. Rows already in effect are marked "in effect (site data not yet rebuilt)" and kept in the list.
3. Multiple upcoming rows for the same code are **all listed**; they are not merged and the site does not decide which one is "final".
4. Descriptive fields on upcoming rows come from the row valid on the build date (not the upcoming row itself); if the name also changes on the effective date, the site lags by one build cycle.
5. **The "data build date" and the "last checked date" are different dates**; a gap of several weeks is normal (see above).
6. **Column types in the CSV are inferred by the spreadsheet software**, which the site cannot control: opening it directly in Excel may show `0.00` as `0` or turn codes into scientific notation. If you need raw values, import via "Data → From Text/CSV" and set those columns to Text. The file bytes themselves are always faithful (UTF-8 with BOM, RFC 4180).

## Performance Thresholds and the Data-Layer Ceiling

The performance thresholds in `spec-upcoming.md` §8.2 and `spec-compare.md` §8.1 were revised on 2026-09-16 based on measurements
(upcoming center 200 → 600 ms / 50 → 120 ms; comparison scenario A 600 → 2,400 ms).
**This accepts the status quo; it does not claim optimization**: green means "comparable to the 2026-09-16 measurement",
not that the original design target was met. Both specs record the original target, measured values and attribution.

The shared bottleneck is the data layer, not rendering: the first-screen `drug_index.json` is 3.28 MB gzip (existing E7 issue),
a single shard is 1.2–1.5 MB raw, and the comparison page loads four at once. Making it genuinely faster requires changing the sharding or boot strategy,
which touches the existing shard contract and should be proposed and handled separately.

## Multi-Code Comparison (`?codes=`)

View the price history of 2–4 NHI codes together: multi-series trend chart, one status timeline band per code, shared crosshair,
summary table, merged event timeline and CSV export. The comparison basket lives in sessionStorage; state is serialized into the URL for sharing.

Known limitations:

1. What to compare is **entirely up to the user**; the site does not judge or suggest equivalence or substitutability, and does not do cross-product price comparison.
2. The baseline for relative-change mode is fixed at each code's **earliest uniquely determinable priced record** and does not follow the display range;
   narrowing the range only crops the window — values are still indexed "relative to the earliest price".
3. In absolute-amount mode, products at very different price levels look visually flattened — an inevitable result of a shared linear axis, not a data issue.
4. Maximum **4 codes** (4 lines is the practical limit for colorblind-safe distinction).
5. **A cold-opened `?codes=` deep link still waits for the homepage index to load** (`drug_index.json`, 3.28 MB gzip),
   about 7 s measured; boot dependencies are unchanged this cycle, so it is recorded without a threshold (see `.ai-review/compare-acceptance.md`).
6. CSV column types are inferred by the spreadsheet software, as described for the upcoming center.

## Build

Requires [uv](https://docs.astral.sh/uv/).

```bash
uv sync
uv run pytest -q                                   # unit tests (unchecked goldens show as skip)
uv run python build_price_history.py               # download from the official endpoint and build data/
uv run python build_price_history.py --source-file .cache/nhi_raw_2026-09-11.csv --no-metadata
```

Frontend (no build step; `index.html` + `app.js` + `engine.js` + `styles.css`; tests need Node 22+):

```bash
npm ci
npm test                                           # engine.js pure logic + golden cross-check
npx playwright install chromium                    # first time
npm run e2e                                        # DOM / viewport / races (route mock)
node scripts/measure_e7.mjs                        # E7 performance measurement + C2 screenshots (not CI)
node scripts/measure_upcoming.mjs                  # U14 upcoming-center performance (not CI)
node scripts/upcoming_review.mjs                   # upcoming-center pharmacist review: 8766 real list, 8767 synthetic counterexamples
node scripts/measure_compare.mjs                   # M17 multi-code comparison performance (not CI)
node scripts/compare_review.mjs                    # comparison pharmacist review: 8768 four real codes, 8769 synthetic overlap scenario
node scripts/smoke_live.mjs                        # post-deploy live smoke check (deep link, search, data version, SW)
uv run python scripts/export_golden_frontend.py    # regenerate JS golden fixtures after ETL rule changes
```

- Any guard failure → exit 1; neither `data/` nor `status.json` is written
- When data is unchanged only `data/status.json` is updated (drives the frontend staleness warning)
- The semantic-anomaly guard (anomalous price rows or > 1% of codes disappearing) can be manually overridden in GitHub Actions via **Run workflow → allow_anomaly**; scheduled runs may never override it

## Golden Manual Check (Phase 1 exit criterion)

1. Open `docs/golden_check_2026-09-11.xlsx` and fill in only the yellow cells
2. Check each row against the NHIA drug query site: ✓ / ✗ / not checkable (state the alternative method if not checkable)
3. Fill in the site row count on the "code summary" sheet and the checker and date on the "notes" sheet
4. Freeze: `uv run python scripts/golden_sheet.py --freeze docs/golden_check_2026-09-11.xlsx`
   - Only codes fully checked with no ✗ are converted to `tests/fixtures/golden_<code>.json`
   - Existing golden files are never overwritten
5. The corresponding skips in `uv run pytest -q` become passes

The frozen snapshot `tests/fixtures/source_snapshot_2026-09-11.csv` is extracted byte-for-byte from the full CSV by `scripts/extract_snapshot.py`; the source sha256 is recorded in the matching `.meta.json`.

## Deployment

- GitHub Pages: Settings → Pages → Deploy from branch → `main` / `(root)`
- `build-data.yml`: checks every Monday 02:00 (Taiwan time); `contents: write`; all actions pinned to commit SHA
  - info.nhi.gov.tw occasionally returns `RemoteDisconnected` (three failures in a row on 2026-09-12, succeeded on rerun 20 minutes later; same seen in the TFDA project on 2026-08-30). Nothing is written on failure; the next scheduled run or a manual Run workflow fixes it
- `test.yml`: runs tests on PR and push (read-only)

## License

Code in this project is under the [MIT License](LICENSE). Copyright and terms of use for NHIA open data follow the original source and are not covered by this license.
