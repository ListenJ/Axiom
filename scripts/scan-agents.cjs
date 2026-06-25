const fs = require('fs');
const path = require('path');
const files = [];
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const stat = fs.statSync(p);
    if (stat.isDirectory() && !f.startsWith('.') && f !== 'examples' && f !== 'scripts') {
      walk(p);
    } else if (stat.isFile() && f.endsWith('.md') && !['README.md','CONTRIBUTING.md','CONTRIBUTING_zh-CN.md','PULL_REQUEST_TEMPLATE.md'].includes(f)) {
      files.push(p);
    }
  }
}
walk(process.argv[2] || '.');
const agents = [];
for (const f of files) {
  const content = fs.readFileSync(f, 'utf-8');
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (m) {
    const fm = m[1];
    const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() || '';
    const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
    const emoji = fm.match(/^emoji:\s*(.+)$/m)?.[1]?.trim() || '';
    const vibe = fm.match(/^vibe:\s*(.+)$/m)?.[1]?.trim() || '';
    const tools = fm.match(/^tools:\s*(.+)$/m)?.[1]?.trim() || '';
    const category = path.dirname(f).replace(/^\.\\/, '').replace(/^\.\//, '');
    agents.push({ file: f.replace(/\\/g, '/'), category, name, description: desc, emoji, vibe, tools });
  }
}
console.log(JSON.stringify(agents, null, 2));
