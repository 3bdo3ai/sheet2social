#!/usr/bin/env node

const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const nextBin = require.resolve('next/dist/bin/next');

const shouldDropLine = (line) =>
  line.includes('[baseline-browser-mapping] The data in this module is over two months old.') ||
  line.includes('To ensure accurate Baseline data, please update: `npm i baseline-browser-mapping@latest -D`');

function forwardWithFilter(stream, targetWrite) {
  let buffer = '';

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!shouldDropLine(line)) {
        targetWrite(line + '\n');
      }
    }
  });

  stream.on('end', () => {
    if (buffer && !shouldDropLine(buffer)) {
      targetWrite(buffer);
    }
  });
}

const child = spawn(process.execPath, [nextBin, ...args], {
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
});

forwardWithFilter(child.stdout, (text) => process.stdout.write(text));
forwardWithFilter(child.stderr, (text) => process.stderr.write(text));

child.on('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
