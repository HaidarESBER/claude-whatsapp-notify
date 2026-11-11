// Claude Code hook: forwards events to the local WhatsApp notifier (server.js).
// Usage: node hook.js <notification|stop|permission>   (hook JSON on stdin)
// If the notifier isn't running, this exits silently so Claude Code carries on.
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CLAUDE_WA_PORT) || 3737;
const event = process.argv[2];

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

// The notifier writes a secret here on first start; every API request must send it
function apiToken() {
  try {
    return fs.readFileSync(path.join(__dirname, '.api-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function post(route, body, timeoutMs) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json();
  } catch {
    return null;
  }
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// Last thing Claude said, so the "done" message says what was done
function lastAssistantText(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      const text = Array.isArray(content)
        ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
        : typeof content === 'string' ? content : '';
      if (text.trim()) return text.trim();
    }
  } catch {}
  return '';
}

// Longest request shown for approval. A longer one is flagged instead of silently cut off,
// because what's hidden at the end could be the dangerous part.
const MAX_PREVIEW = 3000;

function describeTool(name, input = {}) {
  let body;
  if (input.command) body = `${name}: \`${input.command}\``;
  else if (input.file_path) body = `${name}: ${input.file_path}`;
  else if (input.url) body = `${name}: ${input.url}`;
  else body = `${name}: ${JSON.stringify(input)}`;
  const tooLong = body.length > MAX_PREVIEW;
  return { text: tooLong ? body.slice(0, MAX_PREVIEW) : body, tooLong };
}

// Set by server.js for prompts sent from WhatsApp: the server sends the reply
// itself, and there's no terminal to fall back to, so always ask on WhatsApp
const fromWhatsApp = process.env.CLAUDE_WA_REMOTE === '1';

async function main() {
  const input = readStdin();
  const project = path.basename(input.cwd || process.cwd());

  if (fromWhatsApp && event !== 'permission') return;

  if (event === 'notification') {
    // When away, permission prompts are handled by the "permission" hook instead
    await post('/notify', {
      text: `🔔 *${project}* — ${input.message || 'Claude Code needs your attention'}`,
      skipWhenAway: input.notification_type === 'permission_prompt',
      cwd: input.cwd,
    }, 10000);
  } else if (event === 'stop') {
    if (input.stop_hook_active) return;
    const summary = lastAssistantText(input.transcript_path);
    await post('/notify', {
      text: `✅ *${project}* — Claude finished.${summary ? '\n\n' + truncate(summary, 4000) : ''}`,
      onlyWhenAway: true,
      cwd: input.cwd,
    }, 10000);
  } else if (event === 'permission') {
    const tool = describeTool(input.tool_name, input.tool_input);
    const res = await post('/ask', {
      text: `*${project}* wants to run\n${tool.text}`,
      truncated: tool.tooLong,
      timeoutMs: 540000,
      force: fromWhatsApp,
      cwd: input.cwd,
    }, 560000);
    if (res?.answer === 'allow' || res?.answer === 'deny') {
      const decision = res.answer === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Denied from WhatsApp' };
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
      }));
    }
    // No answer (not away, timed out, notifier down): print nothing → normal terminal prompt
  }
}

main().finally(() => process.exit(0));
