import fs from 'node:fs';

async function main() {
  const res = await fetch('http://localhost:3000/api/admin/logs?limit=50');
  const data = await res.json();
  const logs = data.value || data;
  const lines = logs.map((l, i) => `${i}: [${l.level.toUpperCase()}] ${l.message}${l.details ? ' | DETAILS: ' + l.details : ''}`);
  fs.writeFileSync('D:\\Job\\In Progress\\Sheet2Social\\debug_logs.txt', lines.join('\n'), 'utf8');
  console.log('Wrote', lines.length, 'log entries to debug_logs.txt');
}
main().catch(e => console.error(e));
