# Claude Code + Gemini

Use Claude Code with Google Gemini (or any OpenAI-compatible LLM).

## Option 1: OpenClaude (Recommended)

Full Claude Code CLI with all tools, powered by any LLM.

```bash
npm install -g @gitlawb/openclaude

export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=your-gemini-key
export OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
export OPENAI_MODEL=gemini-2.5-flash-lite

openclaude
```

All tools work: bash, file read/write/edit, grep, glob, agents, tasks, MCP.

## Option 2: Telegram Bot (Proxy)

Lightweight proxy that adds a Telegram bot interface.

### Deploy on Railway

1. Fork this repo
2. Create a new Railway project from this repo
3. Set environment variables:
   - `GEMINI_API_KEY` — your Gemini API key
   - `GEMINI_MODEL` — (optional) default: `gemini-2.5-flash-lite`
   - `TELEGRAM_BOT_TOKEN` — from @BotFather
4. Deploy
5. Set webhook:
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-url>.up.railway.app/telegram
   ```

### Features

- Telegram bot with Gemini backend
- Claude Code system prompt (coding-focused)
- File read/write, shell commands, search
- Anthropic-compatible API (`/v1/messages`) for Claude Code CLI
- Per-chat session memory

### Local Usage

```bash
npm install
GEMINI_API_KEY=your-key node proxy.js
```

## Supported Models

Any model accessible via OpenAI-compatible API:
- **Gemini** — via Google's OpenAI endpoint
- **OpenAI** — GPT-4o, GPT-4, etc.
- **DeepSeek** — deepseek-chat, deepseek-coder
- **Ollama** — local models (llama3, etc.)
- **OpenRouter** — 200+ models
- **Groq** — fast inference
- **Mistral** — mistral-large
- **Together AI** — Llama, etc.

## Credits

Based on [openclaude](https://github.com/Gitlawb/openclaude) by Gitlawb.
