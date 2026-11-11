<h1 align="center">claude-whatsapp-notify</h1>

<p align="center">
  <b>Control <a href="https://claude.com/claude-code">Claude Code</a> from WhatsApp.</b><br>
  Approve commands, send prompts and voice notes, and chat with your open sessions from your phone.
</p>

<p align="center">
  <a href="https://github.com/HaidarESBER/claude-whatsapp-notify/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/HaidarESBER/claude-whatsapp-notify/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node.js 18+" src="https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white">
  <img alt="License: ISC" src="https://img.shields.io/badge/license-ISC-blue">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey">
  <img alt="Local first" src="https://img.shields.io/badge/runs-100%25%20local-6366f1">
</p>

<p align="center">
  <img src="docs/chat-mockup.svg" alt="Illustrative WhatsApp conversation: an approval request, a voice note and a guest question" width="300">
</p>

Get notified when Claude needs you, approve or deny commands from your phone, send prompts (text, images, files, voice notes) straight into your open Claude Code sessions, and let friends in a group chat ask questions without being able to run anything on your PC.

Everything runs locally on your machine. The outside connections are WhatsApp (via [Baileys](https://github.com/WhiskeySockets/Baileys)), Anthropic (via Claude Code) and a one-time Whisper model download from Hugging Face.

> ⚠️ Baileys is an **unofficial** WhatsApp client. WhatsApp's terms don't allow unofficial clients, so use a secondary number for the bot — it could get banned.

## Features

- 🔔 **Notifications** — permission prompts, idle sessions, and "task finished" summaries (with Claude's last reply)
- 🔐 **Remote approvals** — reply `y` / `n` to approve or deny a tool call
- 🖥️ **Live sessions** — start Claude Code with `claude-wa` and talk to that exact window from WhatsApp, with its folder, history and context; switch between several windows
- 🧠 **Background runs** — when no window is connected, each message runs `claude -p` and continues the same conversation
- 🖼️ **Images & files** — send a screenshot or PDF and Claude reads it
- 🎙️ **Voice messages** — transcribed locally with Whisper (no extra service), then sent to Claude
- 🌐 **Claude in Chrome** — owner-only browser automation
- 👥 **Group chat with guests** — other members get a locked-down Claude (web search only, no tools that touch your PC, separate conversation); the bot only answers when @mentioned or replied to

## How it works

<p align="center">
  <img src="docs/architecture.svg" alt="Architecture: phone, WhatsApp, server.js, hook.js, channel.js, owner and guest Claude runs" width="900">
</p>

### Approval flow

<p align="center">
  <img src="docs/approval-flow.svg" alt="Sequence diagram of a remote approval: Claude Code, hook.js, server.js, you" width="900">
</p>

| File | Role |
|---|---|
| `server.js` | WhatsApp connection, command handling, local HTTP API, background and guest runs |
| `hook.js` | Forwards Claude Code hook events to the server; exits silently if it isn't running |
| `channel.js` | [Claude Code channel](https://code.claude.com/docs/en/channels-reference) that pipes WhatsApp messages into a live session and relays permission prompts |
| `transcribe.js` | Local voice-note transcription (ffmpeg + Whisper via transformers.js) |
| `bin/claude-wa*` | Launch Claude Code with the WhatsApp channel (paths are derived from the install location) |

## Setup

Requires Node.js 18+ and Claude Code. Clone the repo anywhere; below, `<install-dir>` is wherever you cloned it. If the `claude` binary isn't on your `PATH` (or in `~/.local/bin`), set `CLAUDE_EXE` to its full path.

1. **Install and start the server**
   ```
   npm install
   npm start
   ```
   Scan the QR code with the bot's WhatsApp (Settings → Linked devices). The console prints a code — send `link <code>` to the bot from your personal WhatsApp.

2. **Add the hooks** to `~/.claude/settings.json`:
   ```json
   "hooks": {
     "Notification": [{ "hooks": [{ "type": "command", "command": "node \"<install-dir>/hook.js\" notification", "timeout": 15 }] }],
     "Stop": [{ "hooks": [{ "type": "command", "command": "node \"<install-dir>/hook.js\" stop", "timeout": 15 }] }],
     "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "node \"<install-dir>/hook.js\" permission", "timeout": 600 }] }]
   }
   ```

3. **Live sessions (optional)** — add `<install-dir>/bin` to your `PATH` (don't copy the scripts out of it; they locate the project relative to themselves), then start Claude Code with `claude-wa` (`claude-wa.cmd` on Windows, `bin/claude-wa` on macOS/Linux/Git Bash). Choose *"I am using this for local development"* at the channel warning. To avoid a prompt for every reply, add `mcp__whatsapp__reply` to your allowed tools via `/permissions`.

## WhatsApp commands

| Command | Does |
|---|---|
| *(any other message)* | Prompt for the selected session (or a background run) |
| `sessions` / `switch <n>` / `switch bg` | List and pick live Claude Code windows |
| `new` · `cd <folder>` · `where` · `stop` | Background runs: fresh conversation, change folder, show folder, cancel |
| `away` / `back` | Ask on WhatsApp before tools run / go back to the terminal |
| `y` / `n` (`y 3`) | Approve or deny the oldest (or a specific) pending request |
| `use this group` / `use dm` | Move the bot into a group chat / back to the private chat |
| `guests on` / `guests off` / `guests new` | Let group members ask questions / stop them / reset their conversation |
| `voice en` / `voice fr` / `voice ar` | Language for voice-note transcription |
| `status` · `help` | Current mode and pending requests · command list |

## Privacy & security

- Only the linked owner can send prompts, approve tools, or use Claude in Chrome. Guest messages go to a Claude with no command, file or browser tools, running in an empty folder with no settings, hooks or MCP servers loaded.
- Claude Code adds the account email to every session's context. Guests are instructed never to reveal personal details, but that's an instruction, not a hard guarantee.
- Group messages that don't @mention or reply to the bot are dropped locally and never sent to Claude.
- Not committed: `auth/` (WhatsApp login), `config.json` (linked numbers, settings), `uploads/` (received files), `.api-token` (local API secret).

### How the local API is protected

The notifier's HTTP API listens on `127.0.0.1` only, and on top of that:

- **Every request needs a secret.** On first start the server writes a random 256-bit token to `.api-token` (gitignored). `hook.js` and `channel.js` read it from there and send it as a bearer token. A request without it gets a `401`.
- **Web pages can't reach it.** Requests must carry a `127.0.0.1` or `localhost` `Host` header (blocks DNS rebinding) and `Content-Type: application/json` (browsers can't send that cross-origin without a preflight).
- **Pairing is rate limited.** The `link <code>` code expires after 10 minutes and rotates after 5 wrong guesses; it is compared in constant time.
- **Approvals can't hide their tail.** A request longer than 3,000 characters is never offered for approval on WhatsApp: you're told to answer in the terminal, and runs started from WhatsApp (which have no terminal) are denied.
- **`y` / `n` must name a request when several are waiting**, so you can't approve one that arrived a second ago by accident.
- **Guest voice notes** are decoded by ffmpeg from stdin only, with just the `pipe` protocol allowed and a 2-minute cap. Received files are deleted after 7 days, and the real downloaded size is checked, not the size the sender claims.

Restart the notifier (`npm start`) after updating so the API starts requiring the token.

### Known limitations

This is a personal tool and hasn't had an external security audit.

- **Anything running as you can read `.api-token`.** The token stops other users, web pages and sandboxed processes, but malware running under your account could read it too. Don't use this on a machine you don't trust.
- **In group mode, everything goes to the group.** Approval prompts, replies and "finished" summaries are visible to every member. Guests can't approve anything, but they can read it.
- **Approval previews show the tool's target, not everything.** For a file write you see the path, not the file's contents.
- **Guest isolation** relies on the Claude Code flags in `server.js` (`--restricted`, `--tools WebSearch`, empty settings). Check them against your Claude Code version.
- **Baileys is unofficial.** WhatsApp can ban the number you use for the bot.

## Tests

```
npm test
```

29 tests run on Node's built-in test runner, with no WhatsApp account needed. They start the real notifier in a temporary directory and check:

- **The local API:** 401 without or with a wrong token, 403 for a foreign `Host` header, 415 for browser-style requests, and the over-long approval rules.
- **`hook.js`:** it sends the bearer token, flags commands over 3,000 characters as truncated, turns the notifier's answer into allow or deny, and stays quiet when the notifier is down.
- **Pairing:** the code expires, rotates after 5 wrong guesses, and rejects malformed input.

CI runs them on Node 20 and 22.

## License

[ISC](LICENSE) © Haidar Esber
