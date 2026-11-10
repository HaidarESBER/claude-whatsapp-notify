@echo off
rem Claude Code with the WhatsApp channel (C:\Users\hes\claude-whatsapp-notify)
claude --mcp-config "C:\Users\hes\claude-whatsapp-notify\mcp.json" --dangerously-load-development-channels server:whatsapp --chrome --add-dir "C:\Users\hes\claude-whatsapp-notify\uploads" %*
