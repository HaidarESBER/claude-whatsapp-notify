#!/usr/bin/env node
// Starts Claude Code with the WhatsApp channel. Works from any install location:
// every path is derived from this file's own location, nothing is hardcoded.
// Set CLAUDE_EXE if the `claude` binary isn't on your PATH.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const uploads = path.join(root, 'uploads');
fs.mkdirSync(uploads, { recursive: true });

const mcpConfig = JSON.stringify({
  mcpServers: { whatsapp: { command: process.execPath, args: [path.join(root, 'channel.js')] } },
});

function findClaude() {
  if (process.env.CLAUDE_EXE) return process.env.CLAUDE_EXE;
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(local) ? local : 'claude';
}

const args = [
  '--mcp-config', mcpConfig,
  '--dangerously-load-development-channels', 'server:whatsapp',
  '--chrome',
  '--add-dir', uploads,
  ...process.argv.slice(2),
];

const child = spawn(findClaude(), args, { stdio: 'inherit' });
child.on('error', (e) => {
  console.error(`Couldn't start Claude Code (${e.message}). Set CLAUDE_EXE to the full path of the claude binary.`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
