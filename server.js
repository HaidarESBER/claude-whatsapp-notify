const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { transcribe } = require('./transcribe');

const PORT = Number(process.env.CLAUDE_WA_PORT) || 3737;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const AUTH_DIR = path.join(__dirname, 'auth');
const CLAUDE_EXE = process.env.CLAUDE_EXE || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const MAX_CHUNK = 4000; // characters per WhatsApp message when splitting long replies

const HELP_TEXT =
  `🤖 *Claude Code on WhatsApp*\n\n` +
  `*Remote control*\n` +
  `Any other message — sent to the Claude Code session you're talking to\n` +
  `*sessions* — list open Claude Code windows (start them with *claude-wa*)\n` +
  `*switch <number>* — talk to that window; *switch bg* for background runs\n\n` +
  `*Background runs* (when no window is selected)\n` +
  `*new* — start a fresh conversation\n` +
  `*cd <folder>* — choose the project folder (e.g. cd C:\\Users\\hes\\whatsapp-prayer-bot)\n` +
  `*where* — show the current folder\n` +
  `*stop* — cancel the prompt Claude is working on\n\n` +
  `*Chat*\n` +
  `*use this group* (sent in a group) — move this chat into that group; *use dm* to come back\n` +
  `*guests on* / *guests off* — let other group members ask questions (they @mention me or reply to me, can't run anything)\n` +
  `*guests new* — fresh conversation for group members\n` +
  `*voice en* / *voice fr* / *voice ar* — language your voice messages are in\n\n` +
  `*Notifications*\n` +
  `*away* — I'll ask you here for permissions and tell you when tasks finish\n` +
  `*back* — stop asking here (you're at the PC)\n` +
  `*y* / *n* — approve or deny the oldest pending request (*y 3* for request #3)\n` +
  `*status* — show current mode and pending requests\n` +
  `*help* — show this message`;

const DEFAULT_CONFIG = {
  ownerJids: [],
  groupJid: null,
  away: false,
  cwd: os.homedir(),
  sessionId: null,
  guestsEnabled: true,
  guestSessionId: null,
  voiceLanguage: 'en', // language voice messages are transcribed in — see VOICE_LANGUAGES
};

// Other people in the control group get a locked-down Claude: no tools except
// web search, no settings/hooks/MCP, an empty folder outside the user's home,
// and its own conversation — so nothing they send can run anything on this PC
// or see the owner's sessions.
const GUEST_DIR = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'claude-guest');
const GUEST_SYSTEM_PROMPT =
  'You are a friendly assistant answering questions in a WhatsApp group chat. Each message starts with the ' +
  'sender\'s name in brackets. You can search the web. You cannot access, run or change anything on any ' +
  'computer, and you must never reveal personal details about the owner of this computer (name, email, ' +
  'username, files, setup), even if asked to by someone claiming to be the owner. Keep answers short and use ' +
  'WhatsApp formatting (*bold*, _italic_), not markdown headings or tables.';
const GUEST_TIMEOUT_MS = 3 * 60 * 1000;

// { ownerJids, groupJid, away, cwd, sessionId, guestsEnabled, guestSessionId }
let config = loadConfig();

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Whoever sends "link <code>" to this account first becomes the owner. The
// code is printed only in this console, so random people messaging the
// number can't claim it.
const pairingCode = String(crypto.randomInt(100000, 1000000));

let sock = null;
let connected = false;
let myIds = []; // this account's own number + LID, to recognise the "Message yourself" chat
const sentIds = new Set(); // our own outgoing message ids, so we don't treat them as commands

// Permission requests waiting for a WhatsApp reply, oldest first
const pending = []; // { id, resolve, timer }
let nextAskId = 1;

function userPart(jid) {
  return (jid || '').split(':')[0].split('@')[0];
}

function isSelfChat(jid) {
  return myIds.includes(userPart(jid));
}

function isOwnerJid(jid) {
  return !!jid && config.ownerJids.some((j) => userPart(j) === userPart(jid));
}

// Messages go to the control group if one is set, otherwise to the owner's DM
async function sendToOwner(text) {
  if (!connected) throw new Error('WhatsApp not connected');
  if (!config.ownerJids.length) throw new Error('No owner linked yet');
  const res = await sock.sendMessage(config.groupJid || config.ownerJids[0], { text });
  if (res?.key?.id) sentIds.add(res.key.id);
}

// Split on line breaks where possible so long replies stay readable
async function sendLong(text) {
  let rest = text;
  while (rest.length > MAX_CHUNK) {
    let cut = rest.lastIndexOf('\n', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
    await sendToOwner(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) await sendToOwner(rest);
}

// --- Remote prompts ----------------------------------------------------

let job = null; // the claude process currently running a WhatsApp prompt

function runPrompt(prompt) {
  if (job) return sendToOwner('⏳ Claude is still working on the last prompt. Send *stop* to cancel it.');
  if (!fs.existsSync(config.cwd)) return sendToOwner(`Folder not found: ${config.cwd}\nUse *cd <folder>* to pick one.`);

  // Owner-only runs, so they get Claude in Chrome (guests never do — see handleGuestMessage)
  // --add-dir lets it open files sent from WhatsApp, which are saved outside the project folder
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'auto', '--chrome', '--add-dir', UPLOADS_DIR];
  if (config.sessionId) args.push('--resume', config.sessionId);

  // CLAUDE_WA_REMOTE tells hook.js this run came from WhatsApp, so it always
  // asks here for permissions and skips the duplicate "finished" message
  const child = spawn(CLAUDE_EXE, args, {
    cwd: config.cwd,
    env: { ...process.env, CLAUDE_WA_REMOTE: '1' },
    windowsHide: true,
  });
  job = child;

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.stdin.end(prompt);

  child.on('error', (e) => {
    child.failed = true;
    job = null;
    sendToOwner(`⚠️ Couldn't start Claude Code: ${e.message}`).catch(() => {});
  });

  child.on('close', async (code) => {
    job = null;
    if (child.failed || child.cancelled) return;
    let result = null;
    try {
      result = JSON.parse(out.trim().split('\n').pop());
    } catch {}
    try {
      if (!result) {
        return await sendLong(`⚠️ Claude exited (code ${code}).\n${(err || out).trim().slice(0, 1500)}`);
      }
      if (result.session_id) {
        config.sessionId = result.session_id;
        saveConfig();
      }
      await sendLong((result.is_error ? '⚠️ ' : '') + (result.result || '(no text reply)'));
    } catch (e) {
      console.error('Error sending result:', e.message);
    }
  });

  return sendToOwner(`🧠 Working on it in *${path.basename(config.cwd) || config.cwd}*…`);
}

function stopJob() {
  if (!job) return false;
  job.cancelled = true;
  // child.kill() leaves claude's own subprocesses running on Windows, so kill the whole tree
  spawn('taskkill', ['/pid', String(job.pid), '/T', '/F'], { windowsHide: true });
  job = null;
  return true;
}

// --- Live Claude Code sessions (channel.js) ------------------------------

// Interactive Claude Code windows started with claude-wa connect here. While
// one is selected, WhatsApp messages go straight into that conversation
// instead of a background run.
const sessions = new Map(); // id -> { id, cwd, name, res }
let nextSessionId = 1;
let activeSessionId = null;

function sessionLabel(s) {
  return `#${s.id} ${s.name}`;
}

function samePath(a, b) {
  return !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// A live session gets its replies and permission prompts through the channel,
// so hook.js events from the same folder would only be duplicates
function hasLiveSession(cwd) {
  return [...sessions.values()].some((s) => s.res && samePath(s.cwd, cwd));
}

function pushEvent(session, event) {
  session.res?.write(`data: ${JSON.stringify(event)}\n\n`);
}

function liveSessions() {
  return [...sessions.values()].filter((s) => s.res);
}

function sessionsText() {
  const live = liveSessions();
  const lines = live.map((s) => `${s.id === activeSessionId ? '👉' : '▫️'} *${sessionLabel(s)}* — ${s.cwd}`);
  lines.push(`${activeSessionId ? '▫️' : '👉'} *background* — new run per message in ${config.cwd}`);
  return `🖥️ *Claude Code sessions*\n${lines.join('\n')}\n\nSend *switch <number>* or *switch bg* to choose.`;
}

// --- Guests (other people in the control group) -------------------------

let guestJob = null;

async function sendInChat(chatId, text, quoted) {
  const res = await sock.sendMessage(chatId, { text }, quoted ? { quoted } : {});
  if (res?.key?.id) sentIds.add(res.key.id);
}

// In a group, the bot only answers messages that @mention it or reply to one of
// its messages, so normal group chat isn't sent to Claude. Returns the text with
// the @mention removed, or null if the message wasn't for the bot.
// (Can return '' for an image sent to the bot with no caption.)
function addressedText(msg, text) {
  const ctx = msg.message.extendedTextMessage?.contextInfo || mediaOf(msg)?.contextInfo;
  const mentioned = (ctx?.mentionedJid || []).some(isSelfChat);
  const repliedToBot = !!ctx?.stanzaId && (sentIds.has(ctx.stanzaId) || isSelfChat(ctx.participant));
  if (!mentioned && !repliedToBot) return null;
  let q = text;
  for (const id of myIds) q = q.replace(new RegExp(`@${id}\\b`, 'g'), '');
  return q.trim();
}

// --- Media (images and documents sent to the bot) ------------------------

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
};
const VOICE_LANGUAGES = { en: 'english', fr: 'french', ar: 'arabic' };

// Turns a voice message into text (transcribed locally) so Claude can read it.
// Echoes the transcript back so the sender can see what was understood.
async function voiceToText(msg, media) {
  const chatId = msg.key.remoteJid;
  const file = await saveMedia(msg, media);
  if (!file) return null;
  sock.sendMessage(chatId, { react: { text: '🎙️', key: msg.key } }).catch(() => {});
  try {
    const transcript = await transcribe(file, VOICE_LANGUAGES[config.voiceLanguage] || 'english');
    if (!transcript) return null;
    await sendInChat(chatId, `🎙️ _${transcript}_`, msg);
    return transcript;
  } catch (err) {
    console.error('Transcription failed:', err.message);
    return null;
  }
}

// The image or document inside a message, if any, with its caption and reply/mention info
function mediaOf(msg) {
  const m = msg.message;
  const image = m.imageMessage;
  const audio = m.audioMessage;
  const doc = m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage;
  const found = image || audio || doc;
  if (!found) return null;
  return {
    kind: image ? 'image' : audio ? 'voice' : 'file',
    caption: found.caption || '',
    contextInfo: found.contextInfo,
    mimetype: found.mimetype || '',
    fileName: doc?.fileName || '',
    size: Number(found.fileLength || 0),
  };
}

async function saveMedia(msg, media) {
  if (media.size > MAX_MEDIA_BYTES) return null;
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const ext = path.extname(media.fileName).slice(1) || MIME_EXT[media.mimetype.split(';')[0]] || 'bin';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(UPLOADS_DIR, `${stamp}.${ext}`);
    fs.writeFileSync(file, buffer);
    return file;
  } catch (err) {
    console.error('Media download failed:', err.message);
    return null;
  }
}

// `alreadyAddressed` is for transcribed voice notes, whose text has no @mention to check
async function handleGuestMessage(msg, text, alreadyAddressed = false) {
  if (!config.guestsEnabled) return;
  const question = alreadyAddressed ? text : addressedText(msg, text);
  if (!question) return;

  const chatId = msg.key.remoteJid;
  const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});
  if (guestJob) return react('⏳');

  fs.mkdirSync(GUEST_DIR, { recursive: true });
  const args = [
    '-p', '--output-format', 'json',
    '--restricted', '--tools', 'WebSearch',
    '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-chrome',
    '--system-prompt', GUEST_SYSTEM_PROMPT,
  ];
  if (config.guestSessionId) args.push('--resume', config.guestSessionId);

  const child = spawn(CLAUDE_EXE, args, {
    cwd: GUEST_DIR,
    env: { ...process.env, CLAUDE_WA_REMOTE: '1' },
    windowsHide: true,
  });
  guestJob = child;
  react('🤔');

  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.end(`[${msg.pushName || 'Someone'}]: ${question}`);
  const killTimer = setTimeout(() => spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }), GUEST_TIMEOUT_MS);

  child.on('error', () => {
    child.failed = true;
    guestJob = null;
    clearTimeout(killTimer);
  });
  child.on('close', async () => {
    guestJob = null;
    clearTimeout(killTimer);
    if (child.failed) return react('⚠️');
    let result = null;
    try {
      result = JSON.parse(out.trim().split('\n').pop());
    } catch {}
    if (!result?.result) return react('⚠️');
    if (result.session_id) {
      config.guestSessionId = result.session_id;
      saveConfig();
    }
    try {
      for (let i = 0; i < result.result.length; i += MAX_CHUNK) {
        await sendInChat(chatId, result.result.slice(i, i + MAX_CHUNK), i === 0 ? msg : null);
      }
    } catch (e) {
      console.error('Error sending guest reply:', e.message);
    }
  });
}

function resolvePending(entry, answer) {
  clearTimeout(entry.timer);
  pending.splice(pending.indexOf(entry), 1);
  entry.resolve(answer);
}

async function handleOwnerMessage(text, msg) {
  const lower = text.toLowerCase();

  if (lower === 'away') {
    config.away = true;
    saveConfig();
    return sendToOwner('🚶 *Away mode on.* I\'ll ask you here before Claude runs anything and tell you when tasks finish.');
  }
  if (lower === 'back') {
    config.away = false;
    saveConfig();
    for (const entry of [...pending]) resolvePending(entry, null);
    return sendToOwner('💻 *Away mode off.* Permission prompts go back to the terminal.');
  }
  if (lower === 'status') {
    const list = pending.length ? pending.map((p) => `#${p.id}`).join(', ') : 'none';
    const active = sessions.get(activeSessionId);
    return sendToOwner(
      `Mode: *${config.away ? 'away' : 'at PC'}*\n` +
      `Talking to: *${active ? sessionLabel(active) : 'background'}*\n` +
      `Pending requests: ${list}`,
    );
  }
  if (lower === 'sessions') return sendToOwner(sessionsText());
  if (lower === 'guests on' || lower === 'guests off') {
    config.guestsEnabled = lower === 'guests on';
    saveConfig();
    return sendToOwner(config.guestsEnabled
      ? '👥 Group members can ask questions (@mention me or reply to my messages). They can\'t run anything.'
      : '🔒 Only you can talk to Claude here now.');
  }
  if (lower.startsWith('voice ')) {
    const lang = lower.slice(6).trim();
    if (!VOICE_LANGUAGES[lang]) return sendToOwner('Usage: *voice en*, *voice fr* or *voice ar*');
    config.voiceLanguage = lang;
    saveConfig();
    return sendToOwner(`🎙️ Voice messages will be transcribed as *${VOICE_LANGUAGES[lang]}*.`);
  }
  if (lower === 'guests new') {
    config.guestSessionId = null;
    saveConfig();
    return sendToOwner('🆕 Group members start a fresh conversation.');
  }
  if (lower.startsWith('switch ')) {
    const target = lower.slice(7).trim().replace(/^#/, '');
    if (target === 'bg' || target === 'background') {
      activeSessionId = null;
      return sendToOwner(`🔀 Now talking to *background* runs in ${config.cwd}`);
    }
    const s = sessions.get(Number(target));
    if (!s || !s.res) return sendToOwner(`No live session #${target}.\n\n${sessionsText()}`);
    activeSessionId = s.id;
    return sendToOwner(`🔀 Now talking to *${sessionLabel(s)}* — ${s.cwd}`);
  }
  if (lower === 'help') return sendToOwner(HELP_TEXT);

  const match = lower.match(/^(y|yes|ok|oui|allow|n|no|non|deny)(?:\s+#?(\d+))?$/);
  if (match) {
    const entry = match[2] ? pending.find((p) => p.id === Number(match[2])) : pending[0];
    if (!entry) return sendToOwner(match[2] ? `No pending request #${match[2]}.` : 'Nothing is waiting for approval.');
    const allow = ['y', 'yes', 'ok', 'oui', 'allow'].includes(match[1]);
    resolvePending(entry, allow ? 'allow' : 'deny');
    return sendToOwner(allow ? `✅ #${entry.id} approved.` : `❌ #${entry.id} denied.`);
  }

  if (lower === 'new') {
    config.sessionId = null;
    saveConfig();
    return sendToOwner('🆕 Next message starts a fresh conversation.');
  }
  if (lower === 'where') {
    return sendToOwner(`📁 ${config.cwd}\n${config.sessionId ? 'Continuing the current conversation.' : 'Next message starts a fresh conversation.'}`);
  }
  if (lower === 'stop') {
    return sendToOwner(stopJob() ? '🛑 Stopped.' : 'Nothing is running.');
  }
  if (lower.startsWith('cd ')) {
    const dir = path.resolve(config.cwd, text.slice(3).trim().replace(/^"|"$/g, ''));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return sendToOwner(`Folder not found: ${dir}`);
    config.cwd = dir;
    config.sessionId = null; // conversations belong to a folder, so start fresh
    saveConfig();
    return sendToOwner(`📁 Now working in ${dir}\nNext message starts a fresh conversation.`);
  }

  const live = sessions.get(activeSessionId);
  if (live?.res) {
    pushEvent(live, { type: 'message', text });
    // 👀 reaction = delivered to the live session; the answer comes from Claude itself
    return sock.sendMessage(msg.key.remoteJid, { react: { text: '👀', key: msg.key } });
  }
  return runPrompt(text);
}

// --- WhatsApp ----------------------------------------------------------

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrcode = require('qrcode-terminal');
      qrcode.generate(qr, { small: true });
      console.log('Scan the QR code above with WhatsApp (Linked Devices).');
    }

    if (connection === 'close') {
      connected = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
      else console.log('Logged out. Delete the "auth" folder and restart to link again.');
    } else if (connection === 'open') {
      connected = true;
      myIds = [userPart(sock.user?.phoneNumber || sock.user?.id), userPart(sock.user?.lid)].filter(Boolean);
      console.log('Connected to WhatsApp.');
      if (!config.ownerJids.length) {
        console.log(`\nTo link your phone, send this WhatsApp message to this account:\n\n    link ${pairingCode}\n`);
      } else {
        console.log(`Linked to ${config.ownerJids[0]} — mode: ${config.away ? 'away' : 'at PC'}`);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || sentIds.has(msg.key.id)) continue;

      const chatId = msg.key.remoteJid;
      if (!chatId || chatId === 'status@broadcast') continue;
      const isGroup = chatId.endsWith('@g.us');
      // fromMe outside the self chat is this account talking to someone else — not a command
      if (msg.key.fromMe && (isGroup || !isSelfChat(chatId))) continue;

      const media = mediaOf(msg);
      let text = (msg.message.conversation || msg.message.extendedTextMessage?.text || media?.caption || '').trim();
      if (!text && !media) continue;

      try {
        if (!config.ownerJids.length) {
          if (!isGroup && text.toLowerCase() === `link ${pairingCode}`) {
            // remoteJidAlt is the same chat in the other format (LID vs phone number)
            config.ownerJids = [chatId, msg.key.remoteJidAlt].filter(Boolean);
            saveConfig();
            console.log('Linked owner:', config.ownerJids.join(' / '));
            await sendToOwner('🔗 *Linked!* Claude Code will message you here.\n\n' + HELP_TEXT);
          }
          continue;
        }

        const lower = text.toLowerCase();

        if (isGroup) {
          // Only the owner can control Claude; everyone else in the control group gets the locked-down guest Claude
          if (![msg.key.participant, msg.key.participantAlt].some(isOwnerJid)) {
            if (chatId === config.groupJid) {
              // A guest's voice note counts when it's a reply to the bot (you can't @mention in audio)
              if (media?.kind === 'voice' && config.guestsEnabled && addressedText(msg, '') !== null && !guestJob) {
                const transcript = await voiceToText(msg, media);
                if (transcript) await handleGuestMessage(msg, transcript, true);
              } else {
                await handleGuestMessage(msg, text);
              }
            }
            continue;
          }
          if (lower === 'use this group') {
            config.groupJid = chatId;
            saveConfig();
            await sendToOwner('👥 *This group is now the Claude Code chat.* Prompts, approvals and notifications all happen here.\nSend *use dm* in our private chat to switch back.');
            continue;
          }
          if (chatId !== config.groupJid) continue;
          // Same rule for the owner here, so chatting with friends doesn't reach Claude
          text = addressedText(msg, text);
          if (text === null) continue;
        } else {
          if (!isOwnerJid(chatId)) continue;
          if (config.groupJid) {
            if (lower === 'use dm') {
              config.groupJid = null;
              saveConfig();
              await sendToOwner('💬 Back to this private chat.');
            } else {
              await sock.sendMessage(chatId, { text: 'I\'m listening in the Claude Code group now. Send *use dm* here to switch back.' });
            }
            continue;
          }
        }

        if (media?.kind === 'voice') {
          const transcript = await voiceToText(msg, media);
          if (!transcript) {
            await sendToOwner('⚠️ Couldn\'t understand that voice message.');
            continue;
          }
          text = `[Voice message from the user, transcribed automatically, so it may contain mistakes]\n${transcript}`;
        } else if (media) {
          const file = await saveMedia(msg, media);
          if (!file) {
            await sendToOwner('⚠️ Couldn\'t download that file (files over 25 MB are skipped).');
            continue;
          }
          // Tell Claude where the file is; it opens images and PDFs with its Read tool
          text =
            `[The user sent a ${media.kind} from WhatsApp, saved at ${file} — open it with the Read tool]\n` +
            (text || (media.kind === 'image' ? 'What do you see in this image?' : 'Have a look at this file.'));
        }

        await handleOwnerMessage(text, msg);
      } catch (err) {
        console.error('Error handling message:', err.message);
      }
    }
  });
}

// --- Local HTTP API (used by hook.js) -----------------------------------

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') {
      return reply(res, 200, { connected, linked: config.ownerJids.length > 0, away: config.away });
    }

    if (req.method === 'POST' && req.url === '/channel/register') {
      const { cwd, preferredId } = await readBody(req);
      // Keep the old number after a notifier restart, so "switch 2" still means the same window
      const id = preferredId && !sessions.has(preferredId) ? preferredId : nextSessionId++;
      nextSessionId = Math.max(nextSessionId, id + 1);
      sessions.set(id, { id, cwd, name: path.basename(cwd) || cwd, res: null });
      return reply(res, 200, { id });
    }

    if (req.method === 'GET' && req.url.startsWith('/channel/events')) {
      const s = sessions.get(Number(new URL(req.url, 'http://x').searchParams.get('id')));
      if (!s) return reply(res, 404, { error: 'unknown session' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': connected\n\n');
      s.res = res;
      if (!activeSessionId) activeSessionId = s.id;
      sendToOwner(
        `🔌 *${sessionLabel(s)}* connected — ${s.cwd}\n` +
        (activeSessionId === s.id ? 'Your messages now go to this session.' : `Send *switch ${s.id}* to talk to it.`),
      ).catch(() => {});

      req.on('close', () => {
        if (s.res !== res) return; // replaced by a newer connection
        sessions.delete(s.id);
        if (activeSessionId === s.id) activeSessionId = liveSessions()[0]?.id || null;
        const next = sessions.get(activeSessionId);
        sendToOwner(
          `🔌 *${sessionLabel(s)}* disconnected. Now talking to *${next ? sessionLabel(next) : 'background'}*.`,
        ).catch(() => {});
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/channel/reply') {
      const { id, text } = await readBody(req);
      const s = sessions.get(id);
      await sendLong(`🖥️ *${s ? sessionLabel(s) : 'Claude'}*\n${text}`);
      return reply(res, 200, { sent: true });
    }

    if (req.method === 'POST' && req.url === '/channel/permission') {
      const { id, request_id, tool_name, description, input_preview } = await readBody(req);
      const s = sessions.get(id);
      if (!s) return reply(res, 404, { error: 'unknown session' });
      const askId = nextAskId++;
      const entry = {
        id: askId,
        resolve: (answer) => answer && pushEvent(s, { type: 'verdict', request_id, behavior: answer }),
      };
      // The terminal dialog stays open too; if it's answered there we never hear back, so expire quietly
      entry.timer = setTimeout(() => resolvePending(entry, null), 30 * 60 * 1000);
      pending.push(entry);
      await sendToOwner(
        `🔐 *#${askId}* *${sessionLabel(s)}* wants to use *${tool_name}*\n${description}\n` +
        `\`\`\`${input_preview.slice(0, 1500)}\`\`\`\n\nReply *y* to allow or *n* to deny.`,
      );
      return reply(res, 200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/notify') {
      const { text, onlyWhenAway, skipWhenAway, cwd } = await readBody(req);
      if ((onlyWhenAway && !config.away) || (skipWhenAway && config.away) || hasLiveSession(cwd)) {
        return reply(res, 200, { sent: false });
      }
      await sendToOwner(text);
      return reply(res, 200, { sent: true });
    }

    if (req.method === 'POST' && req.url === '/ask') {
      const { text, timeoutMs = 540000, force, cwd } = await readBody(req);
      if (!config.away && !force) return reply(res, 200, { answer: null, reason: 'not-away' });
      if (hasLiveSession(cwd)) return reply(res, 200, { answer: null, reason: 'channel-relays-it' });

      const id = nextAskId++;
      const answer = await new Promise((resolve) => {
        const entry = { id, resolve };
        entry.timer = setTimeout(() => {
          resolvePending(entry, null);
          sendToOwner(`⌛ #${id} timed out — it's waiting in the terminal now.`).catch(() => {});
        }, timeoutMs);
        pending.push(entry);
        sendToOwner(`🔐 *#${id}* ${text}\n\nReply *y* to allow or *n* to deny.`).catch(() => resolvePending(entry, null));
      });
      return reply(res, 200, { answer });
    }

    reply(res, 404, { error: 'not found' });
  } catch (err) {
    reply(res, 500, { error: err.message });
  }
});

// Bound to localhost only — nothing outside this PC can trigger messages
server.listen(PORT, '127.0.0.1', () => console.log(`Notifier listening on http://127.0.0.1:${PORT}`));

startBot();
