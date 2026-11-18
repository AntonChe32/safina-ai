#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const ALCB_HOST_VERSION = '3.1.4';
console.error('[ALCB] host/index.js loaded', ALCB_HOST_VERSION); // stderr: stdout is NM framing

const DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  maxStdoutBytes: 512 * 1024,
  maxStderrBytes: 128 * 1024,
  maxCommandLength: 128 * 1024
});

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.length >= 4) {
    const len = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + len) return;

    const json = inputBuffer.subarray(4, 4 + len).toString('utf8');
    inputBuffer = inputBuffer.subarray(4 + len);
    handleMessage(json).catch((err) => {
      writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err.message } });
    });
  }
});

// Do not exit immediately on stdin EOF: Chrome sendNativeMessage closes stdin
// while an async command may still be running. Let the event loop drain after
// the response is written.
process.stdin.on('end', () => {});

async function handleMessage(json) {
  let msg;
  try {
    msg = JSON.parse(json);
  } catch {
    writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  try {
    let result;
    if (msg.method === 'shell.run') result = await shellRun(msg.params || {});
    else if (msg.method === 'code.run') result = await codeRun(msg.params || {});
    else if (msg.method === 'config.load') result = loadConfig(msg.params || {});
    else if (msg.method === 'path.resolveDir') result = resolveDir(msg.params || {});
    else {
      writeMessage({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    writeMessage({ jsonrpc: '2.0', id: msg.id ?? null, result });
  } catch (err) {
    writeMessage({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: err.message } });
  }
}

function writeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > 1024 * 1024) {
    const fallback = Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: obj.id ?? null,
      error: { code: -32001, message: `Response too large: ${body.length} bytes` }
    }), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(fallback.length, 0);
    process.stdout.write(Buffer.concat([header, fallback]));
    return;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function expandPath(value) {
  let s = String(value || '').trim();
  if (!s) return s;
  s = s.replace(/^~(?=\/|$)/, os.homedir());
  s = s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_m, name) => process.env[name] ?? '');
  return path.resolve(s);
}

function parseCfgFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    out[key] = value;
  }
  return out;
}

function parseTimeoutValue(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|sec|m|min|h)?$/);
  if (!m) throw new Error(`Bad timeout value: ${value}`);

  const n = Number(m[1]);
  const unit = m[2] || 's';
  const factor = unit === 'ms' ? 1 : unit === 'm' || unit === 'min' ? 60000 : unit === 'h' ? 3600000 : 1000;
  const ms = Math.round(n * factor);
  return Math.max(1000, Math.min(86400000, ms));
}

function readCommandsFile(commandsPath) {
  if (!commandsPath || !fs.existsSync(commandsPath)) return [];
  const data = JSON.parse(fs.readFileSync(commandsPath, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`COMMANDS_JSON must be a JSON array: ${commandsPath}`);
  return data
    .filter((x) => x && typeof x === 'object' && String(x.command || '').trim())
    .map((x) => ({ title: String(x.title || x.command).slice(0, 160), command: String(x.command) }));
}

function loadConfig(params) {
  const cfgPath = expandPath(params.path);
  if (!cfgPath) throw new Error('Missing config path');
  if (!fs.existsSync(cfgPath)) throw new Error(`Config does not exist: ${cfgPath}`);
  const cfg = parseCfgFile(cfgPath);
  const bashrc = expandPath(cfg.BASHRC || path.join(os.homedir(), '.bashrc'));
  const cwd = expandPath(cfg.WORKDIR || cfg.CWD || os.homedir());
  const commandsPath = cfg.COMMANDS_JSON || cfg.COMMANDS_DB ? expandPath(cfg.COMMANDS_JSON || cfg.COMMANDS_DB) : '';
  const timeoutMs = parseTimeoutValue(cfg.TIMEOUT_MS || cfg.TIMEOUT || cfg.ALCB_TIMEOUT, null);

  if (bashrc && !fs.existsSync(bashrc)) throw new Error(`BASHRC does not exist: ${bashrc}`);
  if (cwd && !fs.existsSync(cwd)) throw new Error(`WORKDIR does not exist: ${cwd}`);

  return {
    cfgPath,
    bashrc,
    cwd,
    commandsPath,
    timeoutMs,
    commands: readCommandsFile(commandsPath)
  };
}

function resolveDir(params) {
  const cwd = expandPath(params.path);
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Directory does not exist: ${cwd}`);
  }
  return { cwd };
}

function validateParams(params) {
  const command = String(params.command || '');
  if (!command.trim()) throw new Error('Empty command');
  if (command.length > DEFAULTS.maxCommandLength) throw new Error(`Command is too long: ${command.length} bytes`);

  const timeoutMs = clampInt(params.timeoutMs, 1000, 86400000, DEFAULTS.timeoutMs);
  const maxStdoutBytes = clampInt(params.maxStdoutBytes ?? params.maxBytes, 1024, 768 * 1024, DEFAULTS.maxStdoutBytes);
  const maxStderrBytes = clampInt(params.maxStderrBytes, 1024, 256 * 1024, DEFAULTS.maxStderrBytes);

  let cwd = params.cwd ? expandPath(params.cwd) : process.env.HOME || process.cwd();
  if (!cwd.startsWith('/')) cwd = process.env.HOME || process.cwd();
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }

  let bashrc = params.bashrc ? expandPath(params.bashrc) : null;
  if (bashrc && (!fs.existsSync(bashrc) || !fs.statSync(bashrc).isFile())) {
    throw new Error(`bashrc does not exist: ${bashrc}`);
  }

  return { command, timeoutMs, maxStdoutBytes, maxStderrBytes, cwd, bashrc };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}


function validateCodeParams(params) {
  const language = String(params.language || '').trim().toLowerCase();
  if (!['python', 'py', 'c', 'cpp', 'c++', 'cxx'].includes(language)) {
    throw new Error(`Unsupported code language: ${language || '<empty>'}`);
  }

  const normalizedLanguage = language === 'py' ? 'python' : (language === 'c++' || language === 'cxx' ? 'cpp' : language);
  const code = String(params.code || '');
  if (!code.trim()) throw new Error('Empty code block');
  if (code.length > DEFAULTS.maxCommandLength) throw new Error(`Code block is too long: ${code.length} bytes`);

  const timeoutMs = clampInt(params.timeoutMs, 1000, 86400000, DEFAULTS.timeoutMs);
  const maxStdoutBytes = clampInt(params.maxStdoutBytes ?? params.maxBytes, 1024, 768 * 1024, DEFAULTS.maxStdoutBytes);
  const maxStderrBytes = clampInt(params.maxStderrBytes, 1024, 256 * 1024, DEFAULTS.maxStderrBytes);

  let cwd = params.cwd ? expandPath(params.cwd) : process.env.HOME || process.cwd();
  if (!cwd.startsWith('/')) cwd = process.env.HOME || process.cwd();
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }

  return { language: normalizedLanguage, code, timeoutMs, maxStdoutBytes, maxStderrBytes, cwd };
}

function runSpawn({ file, args, cwd, input, timeoutMs, maxStdoutBytes, maxStderrBytes, env }) {
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env: env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });

    const stdout = collectLimited(child.stdout, maxStdoutBytes);
    const stderr = collectLimited(child.stderr, maxStderrBytes);
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_) {
        try { child.kill('SIGTERM'); } catch (_) {}
      }

      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (_) {
          try { child.kill('SIGKILL'); } catch (_) {}
        }
      }, 1000).unref();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        signal: null,
        durationMs: Date.now() - started,
        stdout: encodePayload(Buffer.alloc(0), false),
        stderr: encodePayload(Buffer.from(err.message, 'utf8'), false)
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stderrPayload = stderr.buffer;
      const timeoutNote = timedOut ? Buffer.from(`\n[timeout after ${timeoutMs} ms]\n`, 'utf8') : Buffer.alloc(0);
      const mergedStderr = timeoutNote.length ? Buffer.concat([stderrPayload, timeoutNote]) : stderrPayload;
      resolve({
        exitCode: typeof code === 'number' ? code : -1,
        signal,
        durationMs: Date.now() - started,
        stdout: encodePayload(stdout.buffer, stdout.truncated),
        stderr: encodePayload(mergedStderr, stderr.truncated || timedOut)
      });
    });

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function codeRun(params) {
  const { language, code, timeoutMs, maxStdoutBytes, maxStderrBytes, cwd } = validateCodeParams(params);
  const started = Date.now();

  if (language === 'python') {
    return await runSpawn({
      file: process.env.PYTHON || 'python3',
      args: ['-'],
      cwd,
      input: code,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
      env: process.env
    });
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alc-code-'));
  const sourceName = language === 'c' ? 'main.c' : 'main.cpp';
  const sourcePath = path.join(tmpRoot, sourceName);
  const exePath = path.join(tmpRoot, 'a.out');
  fs.writeFileSync(sourcePath, code, 'utf8');

  const compiler = language === 'c'
    ? (process.env.CC || 'cc')
    : (process.env.CXX || 'c++');
  const standard = language === 'c' ? '-std=c11' : '-std=c++17';
  const compileArgs = [standard, '-O0', '-g', sourcePath, '-o', exePath];

  const compileTimeout = Math.max(1000, Math.min(timeoutMs, Math.floor(timeoutMs / 2)));
  const compile = await runSpawn({
    file: compiler,
    args: compileArgs,
    cwd,
    input: '',
    timeoutMs: compileTimeout,
    maxStdoutBytes,
    maxStderrBytes,
    env: process.env
  });

  if (compile.exitCode !== 0) {
    safeRmDir(tmpRoot);
    return {
      ...compile,
      durationMs: Date.now() - started
    };
  }

  const runTimeout = Math.max(1000, timeoutMs - compile.durationMs);
  const run = await runSpawn({
    file: exePath,
    args: [],
    cwd,
    input: '',
    timeoutMs: runTimeout,
    maxStdoutBytes,
    maxStderrBytes,
    env: process.env
  });

  safeRmDir(tmpRoot);
  return {
    ...run,
    durationMs: Date.now() - started
  };
}

function safeRmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function shellRun(params) {
  const { command, timeoutMs, maxStdoutBytes, maxStderrBytes, cwd, bashrc } = validateParams(params);
  const started = Date.now();

  return new Promise((resolve) => {
    const env = { ...process.env };
    let args;
    if (bashrc) {
      // Non-interactive rc loading without bash job-control noise.
      // eval reparses after aliases/functions from BASHRC are loaded.
      env.ALCB_BASHRC = bashrc;
      env.ALCB_COMMAND = command;
      args = ['--noprofile', '--norc', '-lc', 'shopt -s expand_aliases; source "$ALCB_BASHRC"; eval "$ALCB_COMMAND"'];
    } else {
      args = ['-lc', command];
    }

    const child = spawn('/bin/bash', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });

    const stdout = collectLimited(child.stdout, maxStdoutBytes);
    const stderr = collectLimited(child.stderr, maxStderrBytes);
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_) {
        try { child.kill('SIGTERM'); } catch (_) {}
      }

      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (_) {
          try { child.kill('SIGKILL'); } catch (_) {}
        }
      }, 1000).unref();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        signal: null,
        durationMs: Date.now() - started,
        stdout: encodePayload(Buffer.alloc(0), false),
        stderr: encodePayload(Buffer.from(err.message, 'utf8'), false)
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stderrPayload = stderr.buffer;
      const timeoutNote = timedOut ? Buffer.from(`\n[timeout after ${timeoutMs} ms]\n`, 'utf8') : Buffer.alloc(0);
      const mergedStderr = timeoutNote.length ? Buffer.concat([stderrPayload, timeoutNote]) : stderrPayload;
      resolve({
        exitCode: typeof code === 'number' ? code : -1,
        signal,
        durationMs: Date.now() - started,
        stdout: encodePayload(stdout.buffer, stdout.truncated),
        stderr: encodePayload(mergedStderr, stderr.truncated || timedOut)
      });
    });
  });
}

function collectLimited(stream, maxBytes) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;

  stream.on('data', (chunk) => {
    if (bytes >= maxBytes) {
      truncated = true;
      return;
    }
    const remaining = maxBytes - bytes;
    if (chunk.length > remaining) {
      chunks.push(chunk.subarray(0, remaining));
      bytes += remaining;
      truncated = true;
      return;
    }
    chunks.push(chunk);
    bytes += chunk.length;
  });

  return {
    get buffer() { return Buffer.concat(chunks, bytes); },
    get truncated() { return truncated; }
  };
}

function encodePayload(buffer, truncated) {
  const kind = detectKind(buffer);
  if (kind === 'text') {
    return { kind: 'text', encoding: 'utf-8', mime: 'text/plain', data: buffer.toString('utf8'), bytes: buffer.length, truncated, reason: truncated ? 'max_bytes_exceeded' : undefined };
  }
  return { kind: 'binary', encoding: 'base64', mime: 'application/octet-stream', data: buffer.toString('base64'), bytes: buffer.length, truncated, reason: truncated ? 'max_bytes_exceeded' : undefined };
}

function detectKind(buffer) {
  if (buffer.length === 0) return 'text';
  if (buffer.includes(0x00)) return 'binary';
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) return 'binary';
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const okControl = code === 9 || code === 10 || code === 13 || code === 8 || code === 12;
    if (code < 32 && !okControl) control++;
  }
  return control > Math.max(4, text.length * 0.02) ? 'binary' : 'text';
}
