const { createServer } = require('http');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const PORT = parseInt(process.env.PORT || process.env.PROXY_PORT || '3456', 10);
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WORKDIR = process.env.WORKDIR || '/tmp/claude-workspace';

if (!GEMINI_KEY) { console.error('Set GEMINI_API_KEY'); process.exit(1); }
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
if (!fs.existsSync(WORKDIR)) fs.mkdirSync(WORKDIR, { recursive: true });

// ─── Tools ──────────────────────────────────────────────────────────────────

function readFile(filePath) {
  const resolved = path.resolve(WORKDIR, filePath);
  if (!fs.existsSync(resolved)) return 'Error: File not found: ' + filePath;
  const stat = fs.statSync(resolved);
  if (stat.size > 100000) return 'Error: File too large (' + stat.size + ' bytes)';
  return fs.readFileSync(resolved, 'utf-8');
}

function writeFile(filePath, content) {
  const resolved = path.resolve(WORKDIR, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf-8');
  return 'Written: ' + filePath;
}

function listFiles(dir) {
  dir = dir || '.';
  const resolved = path.resolve(WORKDIR, dir);
  if (!fs.existsSync(resolved)) return 'Error: Directory not found: ' + dir;
  return fs.readdirSync(resolved, { withFileTypes: true }).map(function(e) { return (e.isDirectory() ? '📁' : '📄') + ' ' + e.name; }).join('\n');
}

function runCommand(cmd) {
  try {
    return execSync(cmd, { cwd: WORKDIR, encoding: 'utf-8', timeout: 30000, maxBuffer: 1024 * 1024 }) || '(no output)';
  } catch (err) { return 'Error: ' + err.message + '\n' + (err.stderr || ''); }
}

function searchFiles(pattern, dir) {
  dir = dir || '.';
  try {
    return execSync('grep -r -n "' + pattern + '" ' + dir + ' --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.json" --include="*.md" 2>/dev/null | head -50', { cwd: WORKDIR, encoding: 'utf-8', timeout: 10000 }) || 'No matches found.';
  } catch (e) { return 'No matches found.'; }
}

function executeTool(name, args) {
  switch (name) {
    case 'read_file': return readFile(args.path);
    case 'write_file': return writeFile(args.path, args.content);
    case 'list_files': return listFiles(args.dir);
    case 'run_command': return runCommand(args.cmd);
    case 'search_files': return searchFiles(args.pattern, args.dir);
    default: return 'Unknown tool: ' + name;
  }
}

var toolDefs = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write/create a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'list_files', description: 'List files in a directory', parameters: { type: 'object', properties: { dir: { type: 'string' } } } },
  { name: 'run_command', description: 'Run a shell command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { name: 'search_files', description: 'Search for text in files', parameters: { type: 'object', properties: { pattern: { type: 'string' }, dir: { type: 'string' } }, required: ['pattern'] } },
];

// ─── Telegram ───────────────────────────────────────────────────────────────

function sendTelegram(chatId, text) {
  var chunks = [];
  for (var i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  return Promise.all(chunks.map(function(chunk) {
    var data = JSON.stringify({ chat_id: chatId, text: chunk });
    var options = { hostname: 'api.telegram.org', path: '/bot' + TELEGRAM_TOKEN + '/sendMessage', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
    return new Promise(function(resolve, reject) {
      var req = https.request(options, function(res) { var body = ''; res.on('data', function(c) { body += c; }); res.on('end', function() { resolve(body); }); });
      req.on('error', reject); req.write(data); req.end();
    });
  }));
}

// ─── Gemini chat with tools ─────────────────────────────────────────────────

var SYSTEM_PROMPT = 'You are Claude Code, Anthropic\'s official CLI. You are a coding assistant.\n\nYou have tools:\n- read_file(path): Read a file\n- write_file(path, content): Write a file\n- list_files(dir): List files\n- run_command(cmd): Run shell command\n- search_files(pattern, dir): Search files\n\nWorking directory: ' + WORKDIR + '\n\nBe concise. Use tools when needed. Write code when asked. Run commands when asked.';

var sessions = {};

async function handleChat(chatId, userMessage) {
  if (!sessions[chatId]) {
    var model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: toolDefs }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0 }
    });
    sessions[chatId] = model.startChat({ history: [] });
  }

  try {
    var result = await sessions[chatId].sendMessage(userMessage);
    var maxIter = 10;

    while (maxIter-- > 0) {
      var response = result.response;
      var candidate = response.candidates?.[0];
      if (!candidate) break;

      var parts = candidate.content?.parts || [];
      var hasTool = false;
      var textResp = '';

      for (var j = 0; j < parts.length; j++) {
        var p = parts[j];
        if (p.text) textResp += p.text;
        if (p.functionCall) {
          hasTool = true;
          var toolResult = executeTool(p.functionCall.name, p.functionCall.args);
          console.log('Tool:', p.functionCall.name);
          await sendTelegram(chatId, '🔧 ' + p.functionCall.name + ' → ' + toolResult.slice(0, 300) + (toolResult.length > 300 ? '...' : ''));
          result = await sessions[chatId].sendMessage([{ functionResponse: { name: p.functionCall.name, response: { result: toolResult } } }]);
        }
      }

      if (textResp) await sendTelegram(chatId, textResp);
      if (!hasTool) break;
    }
  } catch (err) {
    console.error('Error:', err.message);
    await sendTelegram(chatId, 'Error: ' + err.message);
    delete sessions[chatId];
  }
}

// ─── Anthropic API (Claude Code) ────────────────────────────────────────────

function cleanSchema(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(cleanSchema);
  var result = {};
  var skip = new Set(['$schema', 'additionalProperties', 'propertyNames', 'exclusiveMinimum', 'exclusiveMaximum', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'const', '$id', '$ref', 'definitions']);
  for (var k in obj) { if (!skip.has(k)) result[k] = cleanSchema(obj[k]); }
  return result;
}

function toGeminiMessages(messages) {
  var result = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === 'user') {
      var parts = [];
      var content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
      for (var j = 0; j < content.length; j++) {
        var block = content[j];
        if (block.type === 'text') parts.push({ text: block.text });
        else if (block.type === 'tool_result') {
          var txt = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map(function(c) { return c.text || ''; }).join('\n') : '';
          parts.push({ functionResponse: { name: block.tool_use_id, response: { result: txt } } });
        }
      }
      if (parts.length) result.push({ role: 'user', parts: parts });
    } else if (msg.role === 'assistant') {
      var parts = [];
      var content = Array.isArray(msg.content) ? msg.content : [];
      for (var j = 0; j < content.length; j++) {
        if (content[j].type === 'text') parts.push({ text: content[j].text });
        else if (content[j].type === 'tool_use') parts.push({ functionCall: { name: content[j].name, args: content[j].input || {} } });
      }
      if (parts.length) result.push({ role: 'model', parts: parts });
    }
  }
  return result;
}

function sr(r) { return r === 'STOP' ? 'end_turn' : r === 'MAX_TOKENS' ? 'max_tokens' : (r === 'TOOL_CALLS' || r === 'FUNCTION_CALL') ? 'tool_use' : 'end_turn'; }

// ─── HTTP Server ────────────────────────────────────────────────────────────

var server = createServer(async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version, anthropic-beta');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  var url = (req.url || '').split('?')[0];

  if (url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model: GEMINI_MODEL, telegram: !!TELEGRAM_TOKEN, workdir: WORKDIR }));
    return;
  }

  if (url === '/telegram' && req.method === 'POST') {
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', async function() {
      try {
        var update = JSON.parse(body);
        if (update.message && update.message.text) {
          console.log('Telegram:', update.message.chat.id, update.message.text.slice(0, 50));
          handleChat(update.message.chat.id, update.message.text).catch(function(e) { console.error(e); });
        }
        res.writeHead(200); res.end('OK');
      } catch (e) { res.writeHead(500); res.end('Error'); }
    });
    return;
  }

  if (url === '/v1/messages' && req.method === 'POST') {
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', async function() {
      try {
        var parsed = JSON.parse(body);
        var sys = typeof parsed.system === 'string' ? parsed.system : Array.isArray(parsed.system) ? parsed.system.map(function(b) { return b.text || ''; }).join('\n') : undefined;
        var m = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: sys, tools: [{ functionDeclarations: toolDefs.map(function(t) { return { name: t.name, description: t.description, parameters: cleanSchema(t.parameters) }; }) }], generationConfig: { maxOutputTokens: parsed.max_tokens || 8192, temperature: parsed.temperature || 0 } });
        var gm = toGeminiMessages(parsed.messages);
        var hist = gm.length > 1 ? gm.slice(0, -1) : [];
        var last = gm[gm.length - 1];
        var chat = m.startChat({ history: hist.length ? hist : undefined });

        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          var mid = 'msg_' + Date.now();
          res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: mid, type: 'message', role: 'assistant', model: parsed.model || 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }) + '\n\n');
          var bi = -1, ct = null;
          var stream = await chat.sendMessageStream(last.parts.map(function(p) { return p.text ? { text: p.text } : p.functionResponse ? { functionResponse: p.functionResponse } : { text: '' }; }));
          for await (var chunk of stream.stream) {
            var c = chunk.candidates?.[0];
            for (var p of c?.content?.parts || []) {
              if (p.text) {
                if (ct !== 'text') { if (ct) res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: bi }) + '\n\n'); bi++; res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: bi, content_block: { type: 'text', text: '' } }) + '\n\n'); ct = 'text'; }
                res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: bi, delta: { type: 'text_delta', text: p.text } }) + '\n\n');
              }
              if (p.functionCall) {
                if (ct === 'text') res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: bi }) + '\n\n');
                bi++;
                res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: bi, content_block: { type: 'tool_use', id: 'toolu_' + Date.now() + '_' + bi, name: p.functionCall.name, input: {} } }) + '\n\n');
                ct = 'tool_use';
                res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: bi, delta: { type: 'input_json_delta', partial_json: JSON.stringify(p.functionCall.args) } }) + '\n\n');
                res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: bi }) + '\n\n');
                ct = null;
              }
            }
            if (c?.finishReason) {
              if (ct) res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: bi }) + '\n\n');
              res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: sr(c.finishReason), stop_sequence: null }, usage: { output_tokens: chunk.usageMetadata?.candidatesTokenCount || 0 } }) + '\n\n');
              res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
            }
          }
          res.end();
          return;
        }

        var result = await chat.sendMessage(last.parts.map(function(p) { return p.text ? { text: p.text } : p.functionResponse ? { functionResponse: p.functionResponse } : { text: '' }; }));
        var resp = result.response;
        var cand = resp.candidates?.[0];
        var parts = cand?.content?.parts || [];
        var content = [];
        for (var p of parts) {
          if (p.text) content.push({ type: 'text', text: p.text });
          if (p.functionCall) content.push({ type: 'tool_use', id: 'toolu_' + Date.now(), name: p.functionCall.name, input: p.functionCall.args });
        }
        if (!content.length) { var t = resp.text(); if (t) content.push({ type: 'text', text: t }); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model: parsed.model || 'claude-sonnet-4-6', content: content, stop_reason: sr(cand?.finishReason), stop_sequence: null, usage: { input_tokens: resp.usageMetadata?.promptTokenCount || 0, output_tokens: resp.usageMetadata?.candidatesTokenCount || 0 } }));
      } catch (err) {
        console.error('Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, function() { console.log('Proxy on :' + PORT + ' (' + GEMINI_MODEL + ') workdir: ' + WORKDIR); });
