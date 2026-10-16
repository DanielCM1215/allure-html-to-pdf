// Exports one PDF of evidence per test from the Allure report: output/<JIRA-KEY>.pdf (Zephyr reads the key
// from the file name). Each test becomes an HTML page that Chrome prints, so the layout lives in the CSS below.
//
// Usage: node ci/export-suite-pdf.js [title filter] [--include-retries]
// Env:   CHROME_BIN (CI image), BUILD_NUMBER / BUILD_URL (Jenkins), REPORT_TZ (default Asia/Kuala_Lumpur)
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const reportDir = path.resolve('./allure-report');
const outputDir = path.resolve('./output');
const args = process.argv.slice(2);
const includeRetries = args.includes('--include-retries');
const searchTerm = args.find((arg) => !arg.startsWith('--')) || '';
const timeZone = process.env.REPORT_TZ || 'Asia/Kuala_Lumpur';

const MAX_TEXT_LINES = 40;
const STATUS = {
  passed: { label: 'Passed', colour: '#1a7f37', tint: '#e8f5ec' },
  failed: { label: 'Failed', colour: '#c62828', tint: '#fdecec' },
  broken: { label: 'Broken', colour: '#b26a00', tint: '#fff4e0' },
  skipped: { label: 'Skipped', colour: '#5f6b7a', tint: '#eef1f4' },
  unknown: { label: 'Unknown', colour: '#5f6b7a', tint: '#eef1f4' },
};

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function safeFileName(value, fallback = 'Allure_Test') {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const stripAnsi = (value) => String(value || '').replace(/\u001b\[[0-9;]*m/g, '');

function formatDuration(ms) {
  if (typeof ms !== 'number') return '';
  if (ms < 1000) return `${ms} ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)} s`;
  return `${Math.floor(secs / 60)} m ${Math.round(secs % 60)} s`;
}

function formatTime(ms) {
  if (!ms) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

/** "[DAGEP-34][CC UI] Review Page - Verify ..." -> tags ['DAGEP-34', 'CC UI'] and the rest of the title. */
function splitTitle(title) {
  const tags = [];
  let rest = String(title || '');
  let match;
  while ((match = rest.match(/^\s*\[([^\]]+)\]/))) {
    tags.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  return { tags, text: rest.trim() || title };
}

const jiraKeyOf = (title) => (title || '').match(/[A-Z][A-Z0-9]+-\d{3,6}[A-Z]?/i)?.[0]?.toUpperCase() || '';

// --- reading the Allure report ----------------------------------------------------------------

function listTestCaseFiles() {
  const tcDir = path.join(reportDir, 'data', 'test-cases');
  if (!fs.existsSync(tcDir)) return [];
  return fs.readdirSync(tcDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(tcDir, f));
}

const label = (labels, name) => (Array.isArray(labels) ? labels.find((l) => l.name === name)?.value : '') || '';

function toAttachment(att, testTitle) {
  // failureCapture names them "[FAILED] <test title> - Screenshot": the title is already in the header
  const name = String(att.name || att.source || 'attachment')
    .replace(`[FAILED] ${testTitle} - `, '')
    .replace(/^\[FAILED\] .* - /, '');
  return {
    type: 'attachment',
    name,
    mime: att.type || '',
    failure: String(att.name || '').startsWith('[FAILED]'),
    file: att.source ? path.join(reportDir, 'data', 'attachments', att.source) : '',
  };
}

function toSteps(steps = [], testTitle) {
  return steps.map((step) => ({
    type: 'step',
    name: step.name || '',
    status: step.status || '',
    duration: step.time?.duration,
    message: step.statusMessage || '',
    children: [
      ...toSteps(Array.isArray(step.steps) ? step.steps : [], testTitle),
      ...(Array.isArray(step.attachments) ? step.attachments.map((a) => toAttachment(a, testTitle)) : []),
    ],
  }));
}

/** Journey steps that ran in before-all / before-each hooks, without the empty hook wrappers. */
function setupSteps(beforeStages = [], testTitle) {
  return beforeStages
    .flatMap((stage) => toSteps(stage.steps || [], testTitle))
    .flatMap((hook) => (hook.children.length ? hook.children : []))
    .filter((item) => item.type !== 'step' || item.children.length || item.status !== 'passed');
}

function loadTestCases(filterText) {
  const out = [];
  for (const filePath of listTestCaseFiles()) {
    try {
      const tc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const title = String(tc.name || '').trim();
      if (!title) continue;
      if (filterText && !title.toLowerCase().includes(filterText.toLowerCase())) continue;

      const stage = tc.testStage || {};
      const attachments = (stage.attachments || []).map((a) => toAttachment(a, title));

      out.push({
        uid: tc.uid || path.basename(filePath, '.json'),
        title,
        suite: label(tc.labels, 'suite'),
        status: tc.status || 'unknown',
        duration: tc.time?.duration,
        startTime: typeof tc.time?.start === 'number' ? tc.time.start : 0,
        stopTime: typeof tc.time?.stop === 'number' ? tc.time.stop : 0,
        env: label(tc.labels, 'testEnv'),
        product: label(tc.labels, 'testProduct'),
        entryPoint: label(tc.labels, 'entryPoint'),
        runId: label(tc.labels, 'runId'),
        browser: (tc.parameters || []).find((p) => p.name === 'browser')?.value || '',
        params: (tc.parameters || []).filter((p) => p.name !== 'browser').map((p) => `${p.name}: ${p.value}`),
        retry: !!tc.retry,
        flaky: !!tc.flaky,
        message: stripAnsi(tc.statusMessage),
        trace: stripAnsi(tc.statusTrace),
        setup: setupSteps(tc.beforeStages, title),
        steps: [
          ...toSteps(stage.steps || [], title),
          ...attachments.filter((a) => !a.failure),
        ],
        failureEvidence: attachments.filter((a) => a.failure),
      });
    } catch (_) {
      // skip malformed files
    }
  }

  if (includeRetries) return out;

  const byTitle = new Map();
  for (const testCase of out) {
    const current = byTitle.get(testCase.title);

    if (!current) {
      byTitle.set(testCase.title, testCase);
      continue;
    }

    // Prefer non-retry results, then latest by stop/start time.
    const currentScore = [current.retry ? 0 : 1, current.stopTime || current.startTime || 0];
    const nextScore = [testCase.retry ? 0 : 1, testCase.stopTime || testCase.startTime || 0];
    const shouldReplace =
      nextScore[0] > currentScore[0] ||
      (nextScore[0] === currentScore[0] && nextScore[1] >= currentScore[1]);

    if (shouldReplace) {
      byTitle.set(testCase.title, testCase);
    }
  }

  return [...byTitle.values()];
}

// --- HTML ---------------------------------------------------------------------------------------

const CSS = `
  @page { size: A4; margin: 16mm 14mm 18mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 10pt/1.45 -apple-system, "Segoe UI", "Liberation Sans", Arial, sans-serif; color: #1f2933; }
  code, pre, .mono { font-family: Menlo, "Liberation Mono", Consolas, monospace; }
  h2 { font-size: 11pt; margin: 18px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #d9dee4;
       text-transform: uppercase; letter-spacing: .04em; color: #52606d; }
  .header { border-left: 6px solid var(--status); background: var(--tint); padding: 12px 16px; border-radius: 4px; }
  .header .top { display: flex; justify-content: space-between; align-items: center; }
  .badge { display: inline-block; color: #fff; background: var(--status); font-weight: 700; font-size: 9pt;
           padding: 2px 10px; border-radius: 10px; text-transform: uppercase; letter-spacing: .05em; }
  .key { font-size: 15pt; font-weight: 700; }
  .title { font-size: 13pt; font-weight: 600; margin: 8px 0 4px; }
  .tags span { display: inline-block; font-size: 8pt; color: #52606d; background: #fff; border: 1px solid #d9dee4;
               border-radius: 3px; padding: 0 6px; margin-right: 4px; }
  .suite { color: #52606d; font-size: 9pt; margin-top: 6px; }
  .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 16px; margin: 12px 0 0; padding: 10px 16px;
           border: 1px solid #d9dee4; border-radius: 4px; }
  .facts div { font-size: 9pt; } .facts b { display: block; font-size: 7.5pt; color: #7b8794; font-weight: 600;
           text-transform: uppercase; letter-spacing: .05em; }
  .facts a { color: #1f5fbf; text-decoration: none; word-break: break-all; }
  .failure { border: 1px solid #f1b5b5; background: #fdf3f3; border-radius: 4px; padding: 10px 12px; }
  .failure pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 8pt; }
  .step { margin: 0 0 10px; break-inside: avoid-page; }
  .step-head { display: flex; gap: 8px; align-items: baseline; }
  .step-head .no { color: #7b8794; font-weight: 600; min-width: 18px; }
  .step-head .name { flex: 1; font-weight: 600; }
  .step-head .time { color: #7b8794; font-size: 8.5pt; white-space: nowrap; }
  .icon { font-weight: 700; } .icon.passed { color: #1a7f37; } .icon.failed { color: #c62828; }
  .icon.broken { color: #b26a00; } .icon.skipped, .icon.unknown { color: #5f6b7a; }
  .children { margin-left: 26px; }
  .step-msg { color: #c62828; font-size: 8.5pt; margin: 2px 0 0 26px; white-space: pre-wrap; }
  figure { margin: 8px 0 12px; break-inside: avoid; }
  figure img { display: block; max-width: 100%; max-height: 95mm; border: 1px solid #d9dee4; border-radius: 3px; }
  figcaption { font-size: 8pt; color: #52606d; margin-top: 3px; }
  .text { margin: 6px 0 10px; break-inside: avoid-page; }
  .text .cap { font-size: 8pt; color: #52606d; margin-bottom: 2px; }
  .text pre { margin: 0; background: #f5f7fa; border: 1px solid #e4e7eb; border-radius: 3px; padding: 6px 8px;
              font-size: 7.5pt; white-space: pre-wrap; word-break: break-all; }
  .more { color: #7b8794; font-style: italic; }
  .journey { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .journey figure { margin: 0; }
  .journey img { max-height: 55mm; width: 100%; object-fit: cover; object-position: top; }
  .journey figcaption { display: flex; gap: 4px; }
  .journey-list { font-size: 9pt; margin: 0 0 8px; }
  .trace pre { font-size: 7pt; color: #52606d; white-space: pre-wrap; word-break: break-all; }
  .failure .minus { color: #1a7f37; } .failure .plus { color: #c62828; }
  table.calls { width: 100%; border-collapse: collapse; font-size: 8pt; }
  table.calls th { text-align: left; color: #7b8794; font-weight: 600; border-bottom: 1px solid #d9dee4; padding: 3px 6px; }
  table.calls td { border-bottom: 1px solid #eef1f4; padding: 3px 6px; word-break: break-all; }
  table.calls tr.bad td { color: #c62828; font-weight: 600; }
  .muted { color: #7b8794; }
`;

const icon = (status) => `<span class="icon ${esc(status || 'unknown')}">${
  { passed: '✓', failed: '✗', broken: '!', skipped: '–' }[status] || '?'}</span>`;

const fileUrl = (file) => `file://${file.split(path.sep).map(encodeURIComponent).join('/')}`;

/** failureCapture's "Last N API calls": one row per call, response bodies only for calls that failed. */
function renderApiCalls(name, calls) {
  const rows = calls.map((call, i) => {
    const status = call.response?.status ?? '';
    const bad = !(status >= 200 && status < 400);
    const url = String(call.url || '').replace(/^https?:\/\/[^/]+/, '');
    return `<tr class="${bad ? 'bad' : ''}"><td>${i + 1}</td><td>${esc(call.method)}</td><td class="mono">${esc(url)}</td>
      <td>${esc(status)} ${esc(call.response?.statusText || '')}</td></tr>`;
  }).join('');
  const failedBodies = calls
    .map((call, i) => ({ call, i }))
    .filter(({ call }) => !(call.response?.status >= 200 && call.response?.status < 400))
    .map(({ call, i }) => renderText(`Call ${i + 1} response`, JSON.stringify(call.response?.body ?? null, null, 2), 15))
    .join('');
  return `<div class="text"><div class="cap">${esc(name)}</div><table class="calls"><thead><tr><th>#</th><th>Method</th>
    <th>Path</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>${failedBodies}`;
}

function renderText(name, content, maxLines = MAX_TEXT_LINES) {
  const lines = String(content).split('\n');
  const shown = lines.slice(0, maxLines).join('\n');
  const more = lines.length > maxLines
    ? `\n<span class="more">… ${lines.length - maxLines} more lines in the Allure report</span>` : '';
  return `<div class="text"><div class="cap">${esc(name)}</div><pre>${esc(shown)}${more}</pre></div>`;
}

/** Jest diffs: colour the expected (-) and received (+) lines. */
const colourDiff = (text) => text.split('\n').map((line) => {
  if (/^\s*-/.test(line)) return `<span class="minus">${esc(line)}</span>`;
  if (/^\s*\+/.test(line)) return `<span class="plus">${esc(line)}</span>`;
  return esc(line);
}).join('\n');

function renderAttachment(att, stepName = '') {
  if (!att.file || !fs.existsSync(att.file)) {
    return `<div class="text"><span class="muted">Attachment not found: ${esc(att.name)}</span></div>`;
  }
  if (att.mime.startsWith('image/')) {
    // a caption that only repeats the step name ("Step: basic" -> "basic") adds nothing
    const caption = att.name === stepName ? '' : `<figcaption>${esc(att.name)}</figcaption>`;
    return `<figure><img src="${fileUrl(att.file)}">${caption}</figure>`;
  }
  let content = fs.readFileSync(att.file, 'utf8');
  if (att.mime === 'application/json') {
    try {
      const data = JSON.parse(content);
      if (Array.isArray(data) && data.length && data.every((c) => c && c.method && c.url)) {
        return renderApiCalls(att.name, data);
      }
      content = JSON.stringify(data, null, 2);
    } catch (_) { /* keep as is */ }
  }
  return renderText(att.name, content);
}

const stepLabel = (name) => String(name || '').replace(/^Step:\s*/, '');

function renderItems(items, numbered = false, parentName = '') {
  let n = 0;
  return items.map((item) => {
    if (item.type === 'attachment') return renderAttachment(item, parentName);
    n += 1;
    const children = item.children.length
      ? `<div class="children">${renderItems(item.children, false, stepLabel(item.name))}</div>` : '';
    const message = item.message && item.status !== 'passed'
      ? `<div class="step-msg">${esc(stripAnsi(item.message).split('\n').slice(0, 6).join('\n'))}</div>` : '';
    return `<div class="step"><div class="step-head">${numbered ? `<span class="no">${n}</span>` : ''}${icon(item.status)}
      <span class="name">${esc(stepLabel(item.name))}</span><span class="time">${esc(formatDuration(item.duration))}</span></div>
      ${message}${children}</div>`;
  }).join('\n');
}

/** Setup journey: one line of step names, then the screenshots as a grid of thumbnails. */
function renderSetup(setup) {
  const steps = setup.filter((s) => s.type === 'step');
  const shots = steps.flatMap((s) => s.children
    .filter((c) => c.type === 'attachment' && c.mime.startsWith('image/') && c.file && fs.existsSync(c.file))
    .map((c) => ({ ...c, step: s })));
  const others = steps.flatMap((s) => s.children.filter((c) => c.type === 'attachment' && !c.mime.startsWith('image/')));
  const list = steps.map((s) => `${icon(s.status)} ${esc(stepLabel(s.name))}`).join(' &nbsp;·&nbsp; ');
  const failed = steps.filter((s) => s.status !== 'passed' && s.message);
  return `<h2>Setup journey</h2>
    <p class="journey-list">${list}</p>
    ${failed.map((s) => `<div class="step-msg">${esc(s.name)}: ${esc(stripAnsi(s.message).split('\n')[0])}</div>`).join('')}
    <div class="journey">${shots.map((c) => `<figure><img src="${fileUrl(c.file)}">
      <figcaption>${icon(c.step.status)} ${esc(stepLabel(c.step.name))}</figcaption></figure>`).join('')}</div>
    ${others.map(renderAttachment).join('')}`;
}

function renderHtml(tc) {
  const st = STATUS[tc.status] || STATUS.unknown;
  const { tags, text } = splitTitle(tc.title);
  const key = jiraKeyOf(tc.title) || tags[0] || '';
  const buildUrl = process.env.BUILD_URL;
  const build = process.env.BUILD_NUMBER || (tc.runId || '').replace(/^build-/, '');
  const facts = [
    ['Environment', tc.env && tc.env.toUpperCase()],
    ['Product', tc.product],
    ['Entry point', tc.entryPoint],
    ['Browser', tc.browser.replace(/^chrome-/, 'Chrome ')],
    ['Run at', formatTime(tc.startTime)],
    ['Duration', formatDuration(tc.duration)],
    process.env.BUILD_NUMBER || /^build-/.test(tc.runId || '')
      ? ['Build', buildUrl ? `<a href="${esc(buildUrl)}">#${esc(build)}</a>` : `#${esc(build)}`]
      : ['Run', esc(tc.runId)],
    ['Result', tc.flaky ? 'Passed on retry (flaky)' : tc.retry ? 'Retry' : ''],
    ...tc.params.map((p) => ['Parameter', p]),
  ].filter(([, v]) => v);

  const failed = tc.status !== 'passed' && tc.status !== 'skipped' && tc.message;
  // the message is already shown above: keep only the call sites
  const stack = (tc.trace.match(/^\s+at .*$/gm) || []).map((l) => l.trim()).slice(0, 12).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(key || text)}</title>
  <style>${CSS} :root { --status: ${st.colour}; --tint: ${st.tint}; }</style></head><body>
  <div class="header">
    <div class="top"><span class="badge">${st.label}</span><span class="key">${esc(key)}</span></div>
    <div class="title">${esc(text)}</div>
    <div class="tags">${tags.filter((t) => t !== key).map((t) => `<span>${esc(t)}</span>`).join('')}</div>
    ${tc.suite ? `<div class="suite">${esc(tc.suite)}</div>` : ''}
  </div>
  <div class="facts">${facts.map(([k, v]) => `<div><b>${esc(k)}</b>${['Build', 'Run'].includes(k) ? v : esc(v)}</div>`).join('')}</div>
  ${failed ? `<h2>Why it ${tc.status === 'broken' ? 'broke' : 'failed'}</h2>
    <div class="failure"><pre>${colourDiff(tc.message.split('\n').slice(0, 40).join('\n'))}</pre></div>
    ${tc.failureEvidence.map(renderAttachment).join('')}` : ''}
  ${tc.setup.length ? renderSetup(tc.setup) : ''}
  <h2>Test steps</h2>
  ${tc.steps.length ? renderItems(tc.steps, true) : '<p class="muted">No steps were recorded for this test.</p>'}
  ${stack ? `<div class="trace"><h2>Where</h2><pre>${esc(stack)}</pre></div>` : ''}
  </body></html>`;
}

function footerTemplate(tc) {
  const key = jiraKeyOf(tc.title) || splitTitle(tc.title).tags[0] || '';
  const env = tc.env ? ` · ${esc(tc.env.toUpperCase())}` : '';
  return `<div style="width:100%; font: 7pt Arial, sans-serif; color:#7b8794; padding: 0 14mm; display:flex;
    justify-content:space-between;"><span>${esc(key)}${env} · ${esc(formatTime(tc.startTime))}</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
}

// --- main ---------------------------------------------------------------------------------------

function outputPathFor(testCase) {
  const baseName = jiraKeyOf(testCase.title) || safeFileName(testCase.title, 'TestCase');
  let outputPath = path.join(outputDir, `${baseName}.pdf`);
  let idx = 2;
  while (fs.existsSync(outputPath)) {
    outputPath = path.join(outputDir, `${baseName}-${idx}.pdf`);
    idx += 1;
  }
  return outputPath;
}

async function renderPdfForCase(browser, testCase) {
  // Written next to the report so the page may load the attachments as file:// images
  const htmlPath = path.join(reportDir, `.pdf-${testCase.uid}.html`);
  fs.writeFileSync(htmlPath, renderHtml(testCase));
  const page = await browser.newPage();
  try {
    await page.goto(fileUrl(htmlPath), { waitUntil: 'load' });
    // Journey thumbnails are small on paper: re-encode them so each PDF does not carry ten full-size PNGs
    await page.evaluate(() => {
      for (const img of document.querySelectorAll('.journey img')) {
        const scale = Math.min(1, 480 / img.naturalWidth);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        try { img.src = canvas.toDataURL('image/jpeg', 0.8); } catch (_) { /* tainted canvas: keep the original */ }
      }
    });
    await page.waitForNetworkIdle({ idleTime: 100 }).catch(() => {});
    const outputPath = outputPathFor(testCase);
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footerTemplate(testCase),
      margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
    });
    log(`PDF saved: ${outputPath}`);
  } finally {
    await page.close();
    fs.rmSync(htmlPath, { force: true });
  }
}

(async () => {
  if (!fs.existsSync(path.join(reportDir, 'index.html'))) {
    console.error(`Allure report not found in ${reportDir}`);
    process.exit(1);
  }

  const testCases = loadTestCases(searchTerm);

  if (testCases.length === 0) {
    console.error(searchTerm
      ? `No test cases found matching "${searchTerm}"`
      : 'No test cases found in allure-report/data/test-cases');
    process.exit(1);
  }

  log(`Exporting ${testCases.length} test case(s) to PDF...`);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_BIN || undefined,
    args: ['--no-sandbox', '--allow-file-access-from-files'],
  });
  let failures = 0;
  try {
    for (const testCase of testCases) {
      try {
        await renderPdfForCase(browser, testCase);
      } catch (err) {
        failures += 1;
        console.error(`PDF failed for "${testCase.title}": ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  // Tests whose only screenshot is wdio.conf.js's fallback: their evidence needs evidenceStep / captureScreenshot
  const hasOwnShot = (items) => items.some((item) => (item.type === 'attachment'
    ? item.mime.startsWith('image/') && !item.name.startsWith('End of test (automatic')
    : hasOwnShot(item.children)));
  const fallbackOnly = testCases.filter((tc) => tc.status === 'passed' && !hasOwnShot(tc.steps));
  if (fallbackOnly.length) {
    log(`${fallbackOnly.length} passed test(s) have no screenshot of their own (only the automatic end-of-test one):`);
    fallbackOnly.forEach((tc) => console.log(`  - ${tc.title}`));
  }
  if (failures) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
