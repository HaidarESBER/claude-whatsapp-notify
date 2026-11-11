// Claude Code channel: connects a live interactive Claude Code session to the
// WhatsApp notifier (server.js), so WhatsApp messages land in this session and
// Claude can answer back with the `reply` tool. Permission prompts are relayed
// to WhatsApp too. Claude Code spawns this over stdio — see claude-wa.cmd.
// stdout belongs to the MCP protocol, so log with console.error only.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const http = require('http');
const fs = require('fs');
const path = require('path');

// The notifier writes a secret here on first start; every API request must send it
function apiToken() {
  try {
    return fs.readFileSync(process.env.CLAUDE_WA_TOKEN_FILE || path.join(__dirname, '.api-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const PORT = Number(process.env.CLAUDE_WA_PORT) || 3737;

let sessionId = null; // id the notifier gave this session; kept across reconnects

const mcp = new Server(
  { name: 'whatsapp', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions:
      'Messages from the user\'s WhatsApp arrive as <channel source="whatsapp">. When one arrives, the user ' +
      'is away from the terminal and only sees what you send with the reply tool. Handle the request like any ' +
      'other message in this conversation, then always send your answer with reply. For long tasks, send a ' +
      'short progress update with reply first. Use WhatsApp formatting (*bold*, _italic_, ```code```), not ' +
      'markdown headings or tables. Messages typed in the terminal are answered in the terminal as usual.',
  },
);

function post(route, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port: PORT, path: route, method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken()}` },
      },
      (res) => {
        let out = '';
        res.on('data', (d) => (out += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(out || '{}'));
          } catch {
            resolve({});
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message to the user on WhatsApp',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The message to send' } },
        required: ['text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'reply') throw new Error(`unknown tool: ${req.params.name}`);
  const res = await post('/channel/reply', { id: sessionId, text: String(req.params.arguments?.text || '') }).catch(() => null);
  return { content: [{ type: 'text', text: res?.sent ? 'sent' : 'not sent: the WhatsApp notifier is not running' }] };
});

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  await post('/channel/permission', { id: sessionId, ...params }).catch(() => {});
});

async function handleEvent(event) {
  if (event.type === 'message') {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: event.text, meta: { sender: 'whatsapp' } },
    });
  } else if (event.type === 'verdict') {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: event.request_id, behavior: event.behavior },
    });
  }
}

// Register with the notifier, then hold a Server-Sent Events stream open for
// incoming WhatsApp messages. Retries forever so starting the notifier later works.
async function connect() {
  try {
    const res = await post('/channel/register', { cwd: process.cwd(), preferredId: sessionId });
    sessionId = res.id;
  } catch {
    return setTimeout(connect, 5000);
  }

  const req = http.get({
    host: '127.0.0.1', port: PORT, path: `/channel/events?id=${sessionId}`,
    headers: { Authorization: `Bearer ${apiToken()}` },
  }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return setTimeout(connect, 5000); // not authorized yet, or the notifier restarted
    }
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf
          .slice(0, i)
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n');
        buf = buf.slice(i + 2);
        if (data) handleEvent(JSON.parse(data)).catch((e) => console.error('channel event failed:', e.message));
      }
    });
    res.on('end', () => setTimeout(connect, 3000));
  });
  req.on('error', () => setTimeout(connect, 5000));
}

mcp.connect(new StdioServerTransport()).then(connect);
