const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const e2eDir = path.join(__dirname, '..', 'e2e');
const files = fs.readdirSync(e2eDir).filter(f => f.endsWith('.spec.ts')).sort();

let failed = 0;
for (const file of files) {
  const fullPath = path.join(e2eDir, file);
  console.log(`\n>>> Testing ${file}`);
  try {
    const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'playwright.exe');
    const relPath = 'e2e/' + file;
    execSync(
      `"${bin}" test "${relPath}" --project=chromium --workers=1 --timeout=30000 --reporter=line`,
      { stdio: 'inherit', cwd: path.join(__dirname, '..') }
    );
  } catch (e) {
    failed++;
    console.error(`FAILED: ${file}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test file(s) failed.`);
  process.exit(1);
}
console.log('\nAll E2E tests passed!');
