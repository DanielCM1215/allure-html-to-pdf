# export-suite-pdf.js: personal notes

Turns the **Allure report** into **one PDF of evidence per test**, named after the test's Jira key
(`output/DAGEP-1985.pdf`), so Zephyr can attach it to the right Test execution.

```
allure-results/  --(allure generate)-->  allure-report/  --(this script)-->  output/<JIRA-KEY>.pdf  --(zephyrClient.js)-->  Zephyr
```

## Run it

```sh
npx allure generate allure-results --clean -o allure-report   # needs an HTML report first
node ci/export-suite-pdf.js                                   # every test in the report
node ci/export-suite-pdf.js DAGEP-1985                        # only titles containing this text (case-insensitive)
node ci/export-suite-pdf.js "Review Page" --include-retries    # keep every retry attempt as its own PDF
npm run export:pdf                                            # same as the first command
```

| Env | What it does |
|---|---|
| `CHROME_BIN` | Chrome for Puppeteer (set in the CI image; empty locally = Puppeteer's own Chrome) |
| `BUILD_NUMBER`, `BUILD_URL` | Jenkins: shows "Build #N" with a link in the facts box |
| `REPORT_TZ` | Time zone of "Run at" and the footer (default `Asia/Kuala_Lumpur`) |

Exit code is `1` if there's no `allure-report/index.html`, nothing matches the filter, or any single PDF failed.

## Who calls it

- **Jenkins**, stage `Export PDFs` ([Jenkinsfile:324](../Jenkinsfile#L324)): runs inside the test image, filter =
  the `JIRA_FILTER` parameter, copies `output/` back. Failure marks the build **unstable**, not failed. Skipped for
  `RUN_TYPE=smoke`.
- **[run-changed-tests-and-publish.js](run-changed-tests-and-publish.js)**: generate report, export, then push each
  PDF to Zephyr with `zephyrClient.js`.

## What it reads

From `allure-report/data/test-cases/*.json` (one per test result):

| PDF part | Comes from |
|---|---|
| Status, title, duration, start/stop | `status`, `name`, `time` |
| Environment / Product / Entry point / Run | labels `testEnv`, `testProduct`, `entryPoint`, `runId` (set by wdio.conf.js) |
| Browser, Parameters | `parameters` (`browser` separated out) |
| "Why it failed" + diff | `statusMessage` (ANSI stripped, `-` lines green, `+` lines red, max 40 lines) |
| Failure screenshots / API calls | `testStage.attachments` whose name starts `[FAILED]` (from failureCapture) |
| Setup journey | `beforeStages` = before/beforeEach hooks; shown as a step-name line + 4-column thumbnail grid |
| Test steps | `testStage.steps` (nested), with their attachments inline |
| Where | `statusTrace`, only the `at ...` lines, first 12 |

Attachments are files in `allure-report/data/attachments/`.

## How attachments render

- **Image** → `<figure>`; caption dropped if it just repeats the step name.
- **JSON array of `{method, url, response}`** → table of calls (non-2xx/3xx rows red) + response body of the failed
  ones (15 lines). This is failureCapture's "Last N API calls" and `apiInterceptor.attachApiCall`.
- **Other JSON** → pretty-printed text.
- **Text** → `<pre>`, cut at 40 lines with "… N more lines in the Allure report".
- **Missing file** → "Attachment not found: <name>".

## Rules worth remembering

- **File name = first Jira key in the title** (`/[A-Z][A-Z0-9]+-\d{3,6}[A-Z]?/`). The first key wins, so
  `[DAGEP-1985][DAGEP-1032]` → `DAGEP-1985.pdf`. Placeholder `[DAGEP-XXXX]` has no digits → falls back to the
  sanitised full title.
- **`output/` is NOT cleaned.** If `DAGEP-1985.pdf` already exists, the new one becomes `DAGEP-1985-2.pdf`, `-3`...
  Clear `output/` before a local run, or Zephyr gets an old PDF.
- **Retries:** by default one PDF per title: the non-retry result wins, then the latest stop time.
  `--include-retries` keeps them all (they'll get `-2`, `-3` suffixes).
- **Filter** is a plain case-insensitive substring of the title, not a regex.
- Setup hooks that passed with no screenshots/children are dropped (keeps the empty wrapper hooks out).
- Journey thumbnails are re-encoded to JPEG (≤480 px wide, quality 0.8) in the page before printing, so PDFs stay
  small. Full-size screenshots in the test steps are untouched.
- Temporary HTML is written as `allure-report/.pdf-<uid>.html` (so `file://` images load) and deleted afterwards.

## The end-of-run warning

After exporting it lists **passed** tests whose only image is wdio.conf.js's automatic
`End of test (automatic ...)` screenshot. Those tests need an `evidenceStep` / `captureScreenshot` of their own
(see the PDF evidence rule). Doesn't change the exit code.

## Changing the look

All layout is the `CSS` string near the top; page size/margins are in both `@page` and `page.pdf({ margin })`
(keep them in sync). Status colours are in `STATUS`. Footer = key · ENV · run time · page X of Y
(`footerTemplate`, inline styles only: Chrome's footer can't see the page CSS).

Quick visual check after a change:

```sh
rm -rf output && node ci/export-suite-pdf.js DAGEP-1985 && open output/DAGEP-1985.pdf
```
