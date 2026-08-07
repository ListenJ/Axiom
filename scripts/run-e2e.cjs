const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const e2eDir = path.join(__dirname, '..', 'e2e');
if (!fs.existsSync(e2eDir)) {
  console.error(`E2E directory not found: ${e2eDir}`);
  process.exit(1);
}
const files = fs.readdirSync(e2eDir).filter(f => f.endsWith('.spec.ts')).sort();
// CI 可通过 E2E_SPEC 过滤（如 E2E_SPEC=animation-layout 只跑该文件）
const filter = process.env.E2E_SPEC;
const selected = filter ? files.filter(f => f.includes(filter)) : files;
if (selected.length === 0) {
  console.error(`No E2E spec matches E2E_SPEC=${filter}`);
  process.exit(1);
}

let failed = 0;
for (const file of selected) {
  const fullPath = path.join(e2eDir, file);
  console.log(`\n>>> Testing ${file}`);
  try {
    const binName = process.platform === 'win32' ? 'playwright.exe' : 'playwright';
    const bin = path.join(__dirname, '..', 'node_modules', '.bin', binName);
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
