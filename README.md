# export-suite-pdf.js

Turns an **Allure HTML report** into **one PDF of evidence per test**, named after the Jira key in the test title
(`output/ABC-123.pdf`). Useful for attaching evidence to test-management tools (Zephyr, Xray, ...) that match a
file to a test by its name.

```
allure-results/  --(allure generate)-->  allure-report/  --(export-suite-pdf.js)-->  output/<JIRA-KEY>.pdf
```

Each test is rendered as an HTML page and printed to A4 by headless Chrome (Puppeteer), so the whole layout is CSS.

## Requirements

- Node.js 16+
- `puppeteer` (`npm install puppeteer`)
- An Allure HTML report in `./allure-report` (generated with `allure generate allure-results -o allure-report`)

The script resolves `./allure-report` and `./output` from the **current working directory**.

## Usage

```sh
node export-suite-pdf.js                              # every test in the report
node export-suite-pdf.js ABC-123                      # only titles containing this text (case-insensitive)
node export-suite-pdf.js "Login page" --include-retries   # keep every retry attempt as its own PDF
```

| Argument | Meaning |
|---|---|
| first non-`--` argument | Title filter: plain case-insensitive substring, not a regex |
| `--include-retries` | One PDF per attempt instead of one per test |

| Env variable | Meaning |
|---|---|
| `CHROME_BIN` | Chrome/Chromium to use (empty = Puppeteer's bundled Chrome) |
| `BUILD_NUMBER`, `BUILD_URL` | CI build: shown as "Build #N" with a link |
| `REPORT_TZ` | Time zone for times in the PDF (default `Asia/Kuala_Lumpur`) |

**Exit code 1** when: no `allure-report/index.html`, no test matches the filter, or any single PDF fails.

## What goes into each PDF

Read from `allure-report/data/test-cases/*.json`; attachments from `allure-report/data/attachments/`.

| Section | Source in the Allure JSON |
|---|---|
| Header: status badge, Jira key, title, tags, suite | `status`, `name`, label `suite` |
| Facts box | labels `testEnv`, `testProduct`, `entryPoint`, `runId`; `parameters`; `time`; `retry` / `flaky` |
| Why it failed | `statusMessage` (ANSI stripped, diff lines coloured, first 40 lines) + failure attachments |
| Setup journey | `beforeStages` (before / beforeEach hooks): step names on one line, screenshots as a 4-column grid |
| Test steps | `testStage.steps`, numbered, nested, attachments inline |
| Where | `statusTrace`, only the `at ...` lines, first 12 |
| Footer | key · environment · run time · page X of Y |

The custom labels (`testEnv`, `testProduct`, `entryPoint`, `runId`) are optional: a fact with no value is left out.

## Conventions it expects

- **Title tags:** `[ABC-123][Area] Page - Verify ...` → the leading `[...]` blocks become tags, the rest is the title.
- **File name = first Jira-style key** in the title (`/[A-Z][A-Z0-9]+-\d{3,6}[A-Z]?/`). `[ABC-123][ABC-456]` →
  `ABC-123.pdf`. No key (e.g. `[ABC-XXXX]`) → the sanitised full title is used.
- **Failure attachments** are those whose name starts with `[FAILED] `; a `[FAILED] <title> - ` prefix is stripped
  from the caption. They go under "Why it failed" instead of the steps.
- **API call logs:** a JSON attachment that is an array of `{ method, url, response: { status, statusText, body } }`
  is drawn as a table (non-2xx/3xx rows red) plus the response body (15 lines) of each bad call.
- **Fallback screenshot:** an image attachment named `End of test (automatic...` is treated as "not the test's own
  evidence" (see the warning below).

## How attachments render

| Attachment | Rendered as |
|---|---|
| Image | Figure; caption dropped if it only repeats the step name |
| API call array (JSON) | Calls table + failed response bodies |
| Other JSON | Pretty-printed, max 40 lines |
| Text | `<pre>`, max 40 lines, then "… N more lines in the Allure report" |
| File missing | "Attachment not found: <name>" |

## Behaviour worth knowing

- **`output/` is never cleaned.** If `ABC-123.pdf` exists, the new file becomes `ABC-123-2.pdf`, `-3`, ... Empty
  `output/` before a run or an uploader may pick up an old PDF.
- **Retries:** by default one result per title: a non-retry result beats a retry, then the latest stop time wins.
  With `--include-retries` every attempt gets a PDF (with `-2`, `-3` suffixes).
- Setup hooks that passed and recorded nothing are dropped, so empty hook wrappers don't clutter the page.
- Setup-journey thumbnails are re-encoded to JPEG (max 480 px wide, quality 0.8) before printing to keep PDFs small;
  screenshots in the test steps stay full size.
- A temporary `allure-report/.pdf-<uid>.html` is written next to the report (so `file://` images load) and deleted
  after each PDF.
- Chrome is launched with `--no-sandbox --allow-file-access-from-files` (needed in containers and for local images).

## End-of-run warning

After exporting, the script lists **passed** tests whose only screenshot is the automatic `End of test (automatic...`
one, i.e. tests that record no evidence of their own. It is a warning only; the exit code is not affected.

## Changing the look

- Layout: the `CSS` string near the top.
- Page size and margins: in both `@page` (CSS) and `page.pdf({ margin })`; keep them in sync.
- Status colours: the `STATUS` map.
- Footer: `footerTemplate()`. Use inline styles only; Chrome's footer cannot see the page CSS.

Quick check after a change:

```sh
rm -rf output && node export-suite-pdf.js ABC-123 && open output/ABC-123.pdf
```
