/**
 * Export Allure Test Suite to PDF
 * 
 * Description:
 *  - Launches a local server to serve the Allure report.
 *  - Uses Puppeteer to navigate the report, click into each test case, and extract:
 *      - Steps and timing
 *      - Attachments (e.g. screenshots)
 *      - Error messages (if any)
 *  - Generates a landscape PDF summarizing the above data per test case.
 *
 * Usage:
 *  node export-suite-pdf.js "Suite Name"
 *
 * Output:
 *  - Allure_Suite_<Suite_Name>.pdf in the current directory
 *
 * Dependencies:
 *  - Puppeteer
 *  - pdf-lib
 *  - serve-handler
 *
 * Author: Daniel Chan
 * Last Updated: 2025-07-16
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const serveHandler = require('serve-handler');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const outputDir = path.resolve('output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sanitizeText(text) {
  return text
    .replace(/\u2705/g, '[PASSED]')  // ✅
    .replace(/\u274C/g, '[FAILED]')  // ❌
    .replace(/[^     .replace(/[^\x20-~    .replace(/[^\x20-\x7E]/g, '');    // Remove non-printable ASCII
}

function wrapText(text, font, fontSize, maxWidth) {
  const words = sanitizeText(text).split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (testWidth < maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

const suiteName = process.argv[2];
if (!suiteName) {
  console.error('❌ Please provide a suite name.\nUsage: node export-suite-pdf.js "My Suite Name"');
  process.exit(1);
}

(async () => {
  const reportDir = path.resolve('./allure-report');
  const port = 53071;

  if (!fs.existsSync(path.join(reportDir, 'index.html'))) {
    console.error(`❌ Allure report not found in ${reportDir}`);
    process.exit(1);
  }

  const server = http.createServer((req, res) =>
    serveHandler(req, res, { public: reportDir })
  );
  await new Promise(resolve => server.listen(port, resolve));
  log(`🚀 Local server started at http://localhost:${port}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const landscapeWidth = 1200;
  const landscapeHeight = 595;

  try {
    const reportUrl = `http://localhost:${port}`;
    log('🌐 Opening Allure report...');
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 0 });

    log('⏳ Waiting for Allure to fully load...');
    await page.waitForFunction(() => {
      return !document.querySelector('.spinner') &&
             !document.body.innerText.includes('Loading...');
    }, { timeout: 60000 });

    log('✅ Allure loaded. Clicking "Suites" tab...');
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.menu__item')]
        .find(el => el.textContent.includes('Suites'));
      if (tab) tab.click();
    });

    await delay(1500);
    log('🔍 Waiting for suite list...');
    await page.waitForSelector('.table__row', { timeout: 60000 });

    log(`🔘 Looking for suite: "${suiteName}"`);
    const suiteClicked = await page.evaluate((suiteName) => {
      const rows = Array.from(document.querySelectorAll('.table__row'));
      const match = rows.find(row =>
        row.querySelector('.table__col')?.innerText.includes(suiteName)
      );
      if (match) {
        match.scrollIntoView();
        match.click();
        return true;
      }
      return false;
    }, suiteName);

    if (!suiteClicked) {
      await page.screenshot({ path: 'debug_suite_not_found.png', fullPage: true });
      const html = await page.content();
      fs.writeFileSync('debug_suite_not_found.html', html);
      console.error(`❌ Suite "${suiteName}" not found.`);
      return;
    }

    log('✅ Suite clicked. Waiting for test cases to appear...');
    await page.waitForSelector('a.node.node__leaf', { timeout: 30000 });
    await delay(1500);

    const testCaseCount = await page.evaluate(() => {
      const expandedSuite = document.querySelector('.node.node__expanded');
      if (!expandedSuite) return 0;
      return expandedSuite.querySelectorAll('.node__children > a.node__leaf').length;
    });

    log(`🧪 Found ${testCaseCount} test cases in the expanded suite.`);

    const extractTestDetails = async () => {
      return await page.evaluate(() => {
        const extractText = (el) => el?.innerText?.trim() || '';

        const title = extractText(document.querySelector('.pane__title'));

        const steps = Array.from(document.querySelectorAll('.step')).map(step => {
          const name = extractText(step.querySelector('.step__name'));
          const time = extractText(step.querySelector('.step-stats__info_time'));
          return { name, time };
        });

        const attachments = Array.from(document.querySelectorAll('.attachment-row')).map(row => {
          const name = extractText(row.querySelector('.attachment-row__name'));
          const size = extractText(row.querySelector('.link'));
          const download = row.querySelector('.link')?.getAttribute('data-download');
          return { name, size, download };
        });

        const error = extractText(document.querySelector('.status-details__message')) ||
                      extractText(document.querySelector('.status-details__trace'));

        return { title, steps, attachments, error };
      });
    };

    for (let i = 0; i < testCaseCount; i++) {
      log(`🔘 Processing test case #${i + 1}...`);

      try {
        const testHandle = await page.evaluateHandle((index) => {
          const expandedSuite = document.querySelector('.node.node__expanded');
          if (!expandedSuite) return null;
          const testCases = expandedSuite.querySelectorAll('.node__children > a.node__leaf');
          return testCases[index] || null;
        }, i);

        if (!testHandle) {
          log(`⚠️ Test case #${i + 1} not found or detached.`);
          continue;
        }

        await testHandle.evaluate(el => el.scrollIntoView());
        await delay(300);
        await testHandle.click();
        await delay(1000);

        await page.waitForSelector('.test-result__content', { timeout: 10000 });

        await page.evaluate(() => {
          document.querySelectorAll('.accordion__toggle').forEach(el => {
            if (el.getAttribute('aria-expanded') === 'false') el.click();
          });
        });

        await delay(1000);

        const nodeName = await testHandle.evaluate(el => {
        const nameEl = el.querySelector('.node__name');
          return nameEl ? nameEl.innerText.trim() : 'Unnamed Test';
        });

        const data = await extractTestDetails();
        data.nodeName = nodeName;

        let pagePdf = pdfDoc.addPage([landscapeWidth, landscapeHeight]);
        let y = landscapeHeight - 30;

        const drawText = (text, fontSize = 12, spacing = 20) => {
          const maxWidth = landscapeWidth - 100;
          const lines = wrapText(text, font, fontSize, maxWidth);
          for (const line of lines) {
            if (y < 40) {
              pagePdf = pdfDoc.addPage([landscapeWidth, landscapeHeight]);
              y = landscapeHeight - 30;
            }
            pagePdf.drawText(line, { x: 50, y, size: fontSize, font });
            y -= spacing;
          }
        };

        drawText(`Test Case #${i + 1}: ${data.nodeName}`, 14, 22);
        y -= 10;

        if (data.steps?.length) {
          drawText('Steps:', 12);
          data.steps.forEach((step, idx) => {
            drawText(`  ${idx + 1}. ${step.name} (${step.time})`);
          });
          y -= 10;
        }

        if (data.attachments?.length) {
          drawText('Attachments:', 12);
          for (const attachment of data.attachments) {
            drawText(`  - ${attachment.name} (${attachment.size})`);
            const filePath = path.join(reportDir, attachment.download);
            if (fs.existsSync(filePath)) {
              const imageBytes = fs.readFileSync(filePath);
              const image = await pdfDoc.embedPng(imageBytes);
              const imgDims = image.scale(0.4);
              if (y - imgDims.height < 40) {
                pagePdf = pdfDoc.addPage([landscapeWidth, landscapeHeight]);
                y = landscapeHeight - 30;
              }
              pagePdf.drawImage(image, { x: 50, y: y - imgDims.height, width: imgDims.width, height: imgDims.height });
              y -= imgDims.height + 10;
            }
          }
        }

        if (data.error) {
          drawText('Error:', 12);
          drawText(data.error, 10, 15);
        }

      } catch (err) {
        log(`⚠️ Error clicking test case #${i + 1}: ${err.message}`);
      }
    }

    for (const page of pdfDoc.getPages()) {
      page.drawText(
        'Generated by Allure PDF Exporter — github.com/DanielCM1215/allure-html-to-pdf',
        {
          x: 50,
          y: 20, // near bottom
          size: 8,
          font: await pdfDoc.embedFont(StandardFonts.Helvetica),
          color: rgb(0.5, 0.5, 0.5),
          opacity: 0.4,
        }
      );
    }
    const suiteTitle = process.argv[2];
    const fileName = `Allure_Suite_${suiteTitle.replace(/\s+/g, '_')}.pdf`;
    const outputPath = path.join(outputDir, fileName);
    fs.writeFileSync(outputPath, await pdfDoc.save());
    console.log(`✅ PDF saved to: ${outputPath}`);
  } catch (err) {
    console.error('❌ Error occurred:', err);
    await page.screenshot({ path: 'debug_error.png', fullPage: true });
  } finally {
    await browser.close();
    server.close(() => log('🛑 Local server stopped.'));
  }
})();
