# allure-html-to-pdf

Convert [Allure](https://docs.qameta.io/allure/) HTML reports into structured PDF documents with test titles, steps, and attachments.

## Features

- Extracts data from Allure HTML report automatically
- Generates PDF per test case (landscape format)
- Includes:
    - Test titles
    - Steps with pass/fail status
    - Attachments (e.g., screenshots)
    - Built using Puppeteer and pdf-lib

## Usage

Export a single test suite to PDF:

```js
node export-suite-pdf.js "Login Page - Full Flow"
```

This will:

- Find the matching test case in the Allure HTML report.
- Extract the steps and attachments.
- Generate a structured PDF.
- Save it into the output/ folder.

Make sure your export-suite-pdf.js script is set up to:
- Open the Allure report HTML
- Use Puppeteer to extract the .test-result__content for that test name
- Generate and write the PDF file using pdf-lib

## Example Output

Each test case is exported into a PDF page that includes:

- The test name (e.g., "Login Page - Full Flow")
- A list of test steps
- Any attachments (e.g., screenshots, logs)

## Project Structure

```makefile
.
├── export-suite-pdf.js               # Main logic: parse, capture, and build PDF
├── output/                 # Final generated PDFs
└── README.md
```

License

## MIT License
```swift
Copyright (c) 2025 DanielCM1215

Permission is hereby granted, free of charge, to any person obtaining a copy...
```

## Author

Made by @DanielCM1215
Contributions welcome. Please open issues or PRs.
