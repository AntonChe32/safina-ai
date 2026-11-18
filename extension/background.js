const ALCB_BACKGROUND_VERSION = '3.1.4';
console.error('[ALCB] background.js loaded', ALCB_BACKGROUND_VERSION);
const HOST_NAME = 'com.anton.local_command';
const STORAGE_KEY = 'alcbStateV12'; // keep old key so saved commands survive upgrades

const DEFAULT_STATE = Object.freeze({
  cfgPath: null,
  bashrc: null,
  cwd: null,
  timeoutMs: 30000,
  commands: []
});

function storageGet() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      resolve({ ...DEFAULT_STATE, ...(data?.[STORAGE_KEY] || {}) });
    });
  });
}

function storageSet(nextState) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: nextState }, resolve);
  });
}

function callNative(req) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, req, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(`Native messaging error: ${err.message}`));
        return;
      }
      if (!response) {
        reject(new Error('Native host returned empty response'));
        return;
      }
      if (response.error) {
        reject(new Error(response.error.message || String(response.error)));
        return;
      }
      resolve(response);
    });
  });
}

function rpc(method, params = {}) {
  return {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method,
    params
  };
}

function makeTextPayload(data) {
  const text = String(data || '');
  return {
    kind: 'text',
    encoding: 'utf-8',
    mime: 'text/plain',
    data: text,
    bytes: new TextEncoder().encode(text).length,
    truncated: false
  };
}

function makeSyntheticRunResult(command, text, exitCode = 0) {
  return {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    result: {
      exitCode,
      signal: null,
      durationMs: 0,
      stdout: makeTextPayload(text),
      stderr: makeTextPayload('')
    }
  };
}

function shellWords(line) {
  const words = [];
  let cur = '';
  let quote = null;
  let escape = false;
  for (const ch of String(line || '')) {
    if (escape) { cur += ch; escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { words.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words;
}

function startsWithMeta(command, name) {
  const t = String(command || '').trim();
  return t === name || t.startsWith(name + ' ');
}
function parseTimeoutMs(value, fallback = 30000) {
  // Internal timeoutMs values are numbers and are ALWAYS milliseconds.
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fallback;

    return Math.max(
      1000,
      Math.min(86400000, Math.round(value))
    );
  }

  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;

  const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|sec|m|min|h)?$/);
  if (!m) return NaN;

  const n = Number(m[1]);

  // Human-entered strings without a suffix keep the historical meaning:
  // "30" = 30 seconds.
  const unit = m[2] || 's';

  const factor =
    unit === 'ms' ? 1 :
    unit === 'm' || unit === 'min' ? 60000 :
    unit === 'h' ? 3600000 :
    1000;

  const ms = Math.round(n * factor);

  return Math.max(
    1000,
    Math.min(86400000, ms)
  );
}

function timeoutLabel(timeoutMs) {
  const ms = Number(timeoutMs) || 30000;
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function effectiveTimeoutMs(state, messageTimeoutMs) {
  return parseTimeoutMs(
    messageTimeoutMs ?? state?.timeoutMs ?? 30000,
    30000
  );
}


async function handleRunCommand(message) {
  const state = await storageGet();
  const command = String(message.command || '').trim();

  if (startsWithMeta(command, 'setcfg')) {
    const words = shellWords(command);
    if (words.length !== 2) {
      return { ok: true, response: makeSyntheticRunResult(command, 'usage: setcfg /path/to/my.cfg\n', 2), state };
    }

    const native = await callNative(rpc('config.load', { path: words[1] }));
    const cfg = native.result || {};
    const nextState = {
      ...state,
      cfgPath: cfg.cfgPath || words[1],
      bashrc: cfg.bashrc || null,
      cwd: cfg.cwd || state.cwd || null,
      timeoutMs: Number.isFinite(Number(cfg.timeoutMs)) ? Number(cfg.timeoutMs) : (state.timeoutMs || 30000),
      commands: Array.isArray(cfg.commands) && cfg.commands.length ? cfg.commands : state.commands
    };
    await storageSet(nextState);
    const text = [
      'config loaded',
      `CFG=${nextState.cfgPath || ''}`,
      `BASHRC=${nextState.bashrc || ''}`,
      `WORKDIR=${nextState.cwd || ''}`,
      `TIMEOUT=${timeoutLabel(nextState.timeoutMs)}`,
      `TIMEOUT_MS=${nextState.timeoutMs || 30000}`,
      `SAVED_COMMANDS=${nextState.commands.length}`,
      ''
    ].join('\n');
    return { ok: true, response: makeSyntheticRunResult(command, text), state: nextState };
  }

  if (startsWithMeta(command, 'settmo')) {
    const words = shellWords(command);
    if (words.length !== 2) {
      return { ok: true, response: makeSyntheticRunResult(command, 'usage: settmo 666   # seconds; also supports 5000ms, 10s, 5m, 1h\n', 2), state };
    }
    const timeoutMs = parseTimeoutMs(words[1], NaN);
    if (!Number.isFinite(timeoutMs)) {
      return { ok: true, response: makeSyntheticRunResult(command, `bad timeout: ${words[1]}\nusage: settmo 666   # seconds; also supports 5000ms, 10s, 5m, 1h\n`, 2), state };
    }
    const nextState = { ...state, timeoutMs };
    await storageSet(nextState);
    return { ok: true, response: makeSyntheticRunResult(command, `TIMEOUT=${timeoutLabel(timeoutMs)}\nTIMEOUT_MS=${timeoutMs}\n`), state: nextState };
  }

  if (startsWithMeta(command, 'cwd')) {
    const words = shellWords(command);
    if (words.length !== 2) {
      return { ok: true, response: makeSyntheticRunResult(command, 'usage: cwd /path/to/dir\n', 2), state };
    }
    const native = await callNative(rpc('path.resolveDir', { path: words[1] }));
    const nextState = { ...state, cwd: native.result?.cwd || words[1] };
    await storageSet(nextState);
    return { ok: true, response: makeSyntheticRunResult(command, `WORKDIR=${nextState.cwd}\n`), state: nextState };
  }

  if (startsWithMeta(command, 'showcfg')) {
    const text = [
      `CFG=${state.cfgPath || ''}`,
      `BASHRC=${state.bashrc || ''}`,
      `WORKDIR=${state.cwd || ''}`,
      `TIMEOUT=${timeoutLabel(state.timeoutMs)}`,
      `TIMEOUT_MS=${state.timeoutMs || 30000}`,
      `SAVED_COMMANDS=${state.commands.length}`,
      ''
    ].join('\n');
    return { ok: true, response: makeSyntheticRunResult(command, text), state };
  }

  if (startsWithMeta(command, 'reloadcfg')) {
    if (!state.cfgPath) {
      return { ok: true, response: makeSyntheticRunResult(command, 'No config loaded. Use: setcfg /path/to/my.cfg\n', 2), state };
    }
    const native = await callNative(rpc('config.load', { path: state.cfgPath }));
    const cfg = native.result || {};
    const nextState = {
      ...state,
      cfgPath: cfg.cfgPath || state.cfgPath,
      bashrc: cfg.bashrc || state.bashrc,
      cwd: cfg.cwd || state.cwd,
      timeoutMs: Number.isFinite(Number(cfg.timeoutMs)) ? Number(cfg.timeoutMs) : (state.timeoutMs || 30000),
      commands: Array.isArray(cfg.commands) && cfg.commands.length ? cfg.commands : state.commands
    };
    await storageSet(nextState);
    return { ok: true, response: makeSyntheticRunResult(command, 'config reloaded\n' + `CFG=${nextState.cfgPath}\nBASHRC=${nextState.bashrc || ''}\nWORKDIR=${nextState.cwd || ''}\nTIMEOUT=${timeoutLabel(nextState.timeoutMs)}\nTIMEOUT_MS=${nextState.timeoutMs || 30000}\n`), state: nextState };
  }

  const req = rpc('shell.run', {
    command: message.command,
    cwd: message.cwd || state.cwd || null,
    bashrc: state.bashrc || null,
    timeoutMs: effectiveTimeoutMs(state, message.timeoutMs),
    maxStdoutBytes: message.maxStdoutBytes || 524288,
    maxStderrBytes: message.maxStderrBytes || 131072,
    encoding: 'auto'
  });

  const response = await callNative(req);
  return { ok: true, response, state };
}

function compileRegex(value, label) {
  if (value == null || value === '') return null;

  try {
    return new RegExp(String(value));
  } catch (e) {
    throw new Error(
      `Invalid ${label} regular expression: ${e.message}`
    );
  }
}



async function handleRunDom(message, sender) {
  const started = Date.now();
  const code = String(message.code || '');

  if (!code.trim()) {
    throw new Error('DOM JavaScript payload is empty');
  }

  let urlre = message.urlre
    ? String(message.urlre)
    : null;

  let titlere = message.titlere
    ? String(message.titlere)
    : null;

  // Desktop equivalent of Android's dedicated Work WebView.
  if (!urlre && !titlere) {
    titlere = 'Work';
  }

  const urlRx = compileRegex(urlre, 'urlre');
  const titleRx = compileRegex(titlere, 'titlere');

  const sourceTabId = sender?.tab?.id ?? null;

  const tabs = await chrome.tabs.query({});

  const target = tabs.find((tab) => {
    if (!Number.isInteger(tab.id)) return false;

    // kind=dom is intended for another tab.
    if (sourceTabId !== null && tab.id === sourceTabId) {
      return false;
    }

    const url = String(tab.url || '');
    const title = String(tab.title || '');

    if (urlRx) {
      urlRx.lastIndex = 0;
      if (!urlRx.test(url)) return false;
    }

    if (titleRx) {
      titleRx.lastIndex = 0;
      if (!titleRx.test(title)) return false;
    }

    return true;
  });

  if (!target) {
    throw new Error(
      'No target tab matched ' +
      `urlre=${urlre ?? '<none>'} ` +
      `titlere=${titlere ?? '<none>'}`
    );
  }

  const timeoutMs = Math.max(
    1000,
    Math.min(
      120000,
      Number(message.timeoutMs) || 30000
    )
  );

  let injected;

  try {
    injected = await chrome.scripting.executeScript({
      target: {
        tabId: target.id,
        frameIds: [0]
      },

      world: 'MAIN',

      func: async (source, limitMs) => {
        const started = performance.now();
        const logs = [];

        const stringify = (value) => {
          try {
            if (typeof value === 'string') return value;
            const json = JSON.stringify(value);
            return json === undefined
              ? String(value)
              : json;
          } catch (_) {
            return String(value);
          }
        };

        const capture = (level, args) => {
          if (logs.length >= 50) return;

          logs.push({
            level,
            message: Array.from(args)
              .map(stringify)
              .join(' ')
              .slice(0, 1000)
          });
        };

        const consoleProxy = {
          log: (...a) => capture('log', a),
          info: (...a) => capture('info', a),
          warn: (...a) => capture('warn', a),
          error: (...a) => capture('error', a),
          debug: (...a) => capture('debug', a)
        };

        const serialize = (value) => {
          if (value === undefined) return null;

          const seen = new WeakSet();

          const json = JSON.stringify(value, (key, v) => {
            if (typeof v === 'bigint') {
              return String(v);
            }

            if (typeof v === 'function') {
              return '[Function]';
            }

            if (typeof v === 'undefined') {
              return null;
            }

            if (typeof Node !== 'undefined' && v instanceof Node) {
              return {
                tag: v.nodeName,
                text: (v.textContent || '').slice(0, 500)
              };
            }

            if (v && typeof v === 'object') {
              if (seen.has(v)) return '[Circular]';
              seen.add(v);
            }

            return v;
          });

          return json === undefined
            ? null
            : JSON.parse(json);
        };

        const execute = async () => {
          try {
            // Same model as Android WorkDomReader:
            // arbitrary JS body, async/await and top-level return supported.
            const AsyncFunction =
              Object.getPrototypeOf(async function() {})
                .constructor;

            const fn = new AsyncFunction(
              'console',
              source
            );

            const value = await fn.call(
              window,
              consoleProxy
            );

            return {
              success: true,
              url: location.href,
              result: serialize(value),
              console: logs,
              error: null,
              durationMs:
                Math.round(performance.now() - started)
            };
          } catch (e) {
            return {
              success: false,
              url: location.href,
              result: null,
              console: logs,
              error: String(
                e && e.stack ? e.stack : e
              ),
              durationMs:
                Math.round(performance.now() - started)
            };
          }
        };

        const timeout = new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              success: false,
              url: location.href,
              result: null,
              console: logs,
              error: 'JavaScript task timeout',
              durationMs:
                Math.round(performance.now() - started)
            });
          }, limitMs);
        });

        return await Promise.race([
          execute(),
          timeout
        ]);
      },

      args: [code, timeoutMs]
    });

  } catch (e) {
    return {
      ok: true,
      response: {
        success: false,
        url: target.url || '',
        result: null,
        console: [],
        error: e?.message || String(e),
        durationMs: Date.now() - started,
        target: {
          tabId: target.id,
          title: target.title || '',
          url: target.url || ''
        }
      }
    };
  }

  let result = injected?.[0]?.result;

  if (!result || typeof result !== 'object') {
    throw new Error(
      'Target tab returned no DOM execution result'
    );
  }

  return {
    ok: true,
    response: {
      ...result,
      target: {
        tabId: target.id,
        title: target.title || '',
        url: target.url || ''
      }
    }
  };
}

async function handleMessage(message, sender) {
  if (!message || !message.type) return null;

  if (message.type === 'ALCB_GET_STATE') {
    return { ok: true, state: await storageGet() };
  }

  if (message.type === 'ALCB_RUN_COMMAND') {
    return await handleRunCommand(message);
  }

  if (message.type === 'ALCB_RUN_DOM') {
    return await handleRunDom(message, sender);
  }

  if (message.type === 'ALCB_ADD_SAVED_COMMAND') {
    const state = await storageGet();
    const title = String(message.title || '').trim();
    const command = String(message.command || '').trim();
    if (!title || !command) throw new Error('Title and command are required');
    const nextState = { ...state, commands: [...state.commands, { title, command }] };
    await storageSet(nextState);
    return { ok: true, state: nextState };
  }

  if (message.type === 'ALCB_DELETE_SAVED_COMMAND') {
    const state = await storageGet();
    const index = Number(message.index);
    if (!Number.isInteger(index) || index < 0 || index >= state.commands.length) throw new Error('Bad command index');
    const commands = state.commands.slice();
    commands.splice(index, 1);
    const nextState = { ...state, commands };
    await storageSet(nextState);
    return { ok: true, state: nextState };
  }


  if (message.type === 'ALCB_RUN_CODE') {
    const state = await storageGet();
    const req = rpc('code.run', {
      language: message.language,
      code: message.code,
      cwd: message.cwd || state.cwd || null,
      timeoutMs: effectiveTimeoutMs(state, message.timeoutMs),
      maxStdoutBytes: message.maxStdoutBytes || 524288,
      maxStderrBytes: message.maxStderrBytes || 131072
    });
    const response = await callNative(req);
    return { ok: true, response, state };
  }

  if (message.type === 'ALCB_UPDATE_STATE') {
    const state = await storageGet();
    const nextState = { ...state, ...(message.patch || {}) };
    await storageSet(nextState);
    return { ok: true, state: nextState };
  }

  throw new Error(`Unknown message type: ${message.type}`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response || { ok: false, error: 'No response' }))
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});
