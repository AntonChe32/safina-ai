const ALCB_VERSION = '3.1.5';
// Debug logging is OFF by default. Enable at runtime:
//   localStorage.setItem('ALCB_DEBUG', '1')  (reload page)
//   or open the page with ?alcb_debug=1
// Never writes to stdout in the native host; this is content-side only.
const ALCB_DEBUG = (() => {
  try {
    if (globalThis.localStorage?.getItem('ALCB_DEBUG') === '1') return true;
  } catch (_) {}
  try {
    const u = new URL(globalThis.location?.href || '');
    if (u.searchParams.get('alcb_debug') === '1') return true;
  } catch (_) {}
  return false;
})();
function alcbDebug(...args) { if (ALCB_DEBUG) console.debug('[ALCB]', ...args); }
function alcbInfo(...args)  { if (ALCB_DEBUG) console.info('[ALCB]', ...args); }
function alcbWarn(...args)  { if (ALCB_DEBUG) console.warn('[ALCB]', ...args); }
console.info('[ALCB] content.js loaded', ALCB_VERSION, 'chrome.runtime?', !!globalThis.chrome?.runtime);

const STATE = {
  command: '',
  lastComposerText: '',
  running: false,
  bridgeState: { cfgPath: null, bashrc: null, cwd: null, timeoutMs: 30000, commands: [] }
};

const CONFIG = {
  timeoutMs: 30000,
  // Keep under Chrome Native Messaging's 1 MB host->extension message limit.
  maxStdoutBytes: 524288,
  maxStderrBytes: 131072
};

const CODE_LANGUAGE_CACHE = new WeakMap();
const CODE_PAYLOAD_CACHE = new WeakMap();

function ensurePanel() {
  let panel = document.getElementById('alcb-panel');
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = 'alcb-panel';
  panel.innerHTML = `
    <div id="alcb-command"></div>
    <div id="alcb-actions">
      <button id="alcb-run" type="button">Run locally</button>
      <button id="alcb-hide" type="button">Hide</button>
    </div>
    <div id="alcb-status"></div>
    <div id="alcb-cfg"></div>
    <div id="alcb-saved-title">Saved commands</div>
    <div id="alcb-saved-list"></div>
    <div id="alcb-saved-actions">
      <button id="alcb-saved-run" type="button">Run selected</button>
      <button id="alcb-saved-add" type="button">Add current</button>
      <button id="alcb-saved-delete" type="button">Delete</button>
      <button id="alcb-saved-refresh" type="button">Refresh</button>
    </div>
    <div id="alcb-version">ALCB ${ALCB_VERSION}</div>
  `;
  document.documentElement.appendChild(panel);

  panel.querySelector('#alcb-run').addEventListener('click', runCurrentCommand);
  panel.querySelector('#alcb-hide').addEventListener('click', () => {
    panel.classList.remove('alcb-visible');
  });
  panel.querySelector('#alcb-saved-refresh').addEventListener('click', refreshBridgeState);
  panel.querySelector('#alcb-saved-add').addEventListener('click', addCurrentSavedCommand);
  panel.querySelector('#alcb-saved-delete').addEventListener('click', deleteSelectedSavedCommand);
  panel.querySelector('#alcb-saved-run').addEventListener('click', runSelectedSavedCommand);
  panel.querySelector('#alcb-saved-list').addEventListener('dblclick', runSelectedSavedCommand);

  return panel;
}

function setStatus(text) {
  const panel = ensurePanel();
  panel.querySelector('#alcb-status').textContent = text || '';
}

function getComposer() {
  const candidates =
    globalThis.ALCB_SITE_ADAPTER?.composerSelectors || [
      'textarea',
      '[contenteditable="true"]'
    ];

  for (const selector of candidates) {
    const nodes = Array.from(document.querySelectorAll(selector));
    const visible = nodes.filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 40 && rect.height > 10 && rect.bottom > 0;
    });
    if (visible.length) return visible[visible.length - 1];
  }
  return null;
}

function getComposerText(el) {
  if (!el) return '';
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
  return el.innerText || el.textContent || '';
}

function extractDollarCommand(text) {
  // v0: first non-empty paragraph/line whose first non-space char is "$".
  const blocks = text.split(/\n{1,}/);
  for (const raw of blocks) {
    const line = raw.trimStart();
    if (line.startsWith('$')) {
      const command = line.slice(1).trim();
      if (command) return command;
    }
  }
  return '';
}


function collectCodeTextWithStructuralNewlines(root) {
  // ChatGPT/highlighters often render code as many nested spans. textContent can
  // concatenate those spans without line breaks, which destroys heredocs:
  //   <<'PY'import os ...
  // Prefer real DOM/innerText newlines when they exist, but avoid inventing
  // newlines from visual word wrapping.
  if (!root) return '';

  const blockLike = new Set(['DIV', 'P', 'LI', 'TR']);
  let out = '';

  function appendNewline() {
    if (out && !out.endsWith('\n')) out += '\n';
  }

  function walk(node) {
    if (!node) return;

    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue || '';
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node;
    const tag = el.tagName;

    if (tag === 'BR') {
      appendNewline();
      return;
    }

    // Some code renderers use a wrapper per source line.
    const before = out.length;
    for (const child of Array.from(el.childNodes)) walk(child);

    if (blockLike.has(tag) && out.length > before) appendNewline();
  }

  walk(root);
  return out;
}

function cleanExtractedCodeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n?\s*(Run locally|Running\.\.\.|Inserted|Error|Wait…|No command|Incomplete <<[^\n]*)\s*$/g, '')
    .trim();
}

const ALCB_CODE_TEXT_CACHE = new WeakMap();

function getCodeText(block) {
  if (!block) return '';

  // v1.0: treat the whole <pre> as the source of truth. In ChatGPT's DOM,
  // <code> can be split/nested in ways where reading a child code node returns
  // only the first few tokens/lines. Selecting the whole <pre> gives the same
  // text the user would copy from the block.
  const container = block.closest?.('pre') || block;

  const rawText = container.textContent || '';
  const cached = ALCB_CODE_TEXT_CACHE.get(container);

  if (cached && cached.rawText === rawText) {
    return cached.value;
  }

  const clone = container.cloneNode(true);
  clone.querySelectorAll?.('.alcb-inline-run').forEach((el) => el.remove());

  const codeNodes = Array.from(clone.querySelectorAll?.('code') || []);
  const candidates = [];

  // innerText is often closest to what Chrome copies from a code block.
  if (clone.innerText) candidates.push(clone.innerText);

  // If there are multiple code nodes, concatenate them with newlines; this
  // handles renderers that split code by line/token.
  if (codeNodes.length > 1) {
    candidates.push(codeNodes.map((n) => n.innerText || n.textContent || '').join('\n'));
  } else if (codeNodes.length === 1) {
    candidates.push(codeNodes[0].innerText || codeNodes[0].textContent || '');
  }

  candidates.push(collectCodeTextWithStructuralNewlines(clone));
  candidates.push(clone.textContent || '');

  // Prefer the candidate with the most real newlines. Heredocs/scripts need
  // structural newlines more than they need compact visual text.
  let best = '';
  let bestScore = -1;
  for (const raw of candidates) {
    const text = cleanExtractedCodeText(raw);
    if (!text) continue;
    const lines = (text.match(/\n/g) || []).length;
    const heredocBonus = /<<-?\s*['"]?[A-Za-z0-9_./-]+['"]?/.test(text) ? 1000 : 0;
    const score = heredocBonus + lines * 10 + Math.min(text.length, 10000) / 10000;
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  }

  ALCB_CODE_TEXT_CACHE.set(container, {
    rawText,
    value: best
  });

  return best;
}

function getLatestDollarCommandFromCodeBlocks() {
  const codeBlocks = Array.from(document.querySelectorAll('code'));

  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    const code = codeBlocks[i];
    const text = getCodeText(code);
    if (!text) continue;

    const command = normalizeShellBlockToScript(text, { allowPlainScript: false });
    if (!command) continue;

    return { command, sourceText: text, element: code };
  }

  return null;
}


function looksLikePromptLine(line) {
  const trimmed = String(line || '').trimStart();
  if (trimmed.startsWith('$')) return { command: trimmed.slice(1).trimStart() };

  // Common shell transcript prompts: user@host:~/path$ command, root# command.
  const match = trimmed.match(/^[\w.@:/~+-]+[$#]\s+(.+)$/);
  if (match?.[1]) return { command: match[1].trimStart() };

  return null;
}

function heredocDelimiterFromLine(line) {
  // Covers: <<EOF, <<'EOF', <<"EOF", <<-EOF
  const match = String(line || '').match(/<<-?\s*['"]?([A-Za-z0-9_./-]+)['"]?/);
  return match?.[1] || null;
}

function cleanCollapsedLineContinuations(line) {
  // Some ChatGPT DOM variants expose a visual multiline block as one text line:
  //   && \printf ... && \pwd
  // That backslash was meant to escape the newline, not the command name.
  // Remove it only after shell separators or at the beginning of a command fragment.
  return String(line || '')
    .replace(/(^|[;&|]{1,2}\s*)\\(?=[A-Za-z_][A-Za-z0-9_./-]*\b)/g, '$1')
    .replace(/(^|\s)\\(?=(printf|pwd|find|sed|grep|cat|head|tail|wc|ls|awk|python3?|node|cmake|make|git)\b)/g, '$1');
}

function appendScriptLine(script, line) {
  const cleaned = cleanCollapsedLineContinuations(line);
  if (!script.length) {
    script.push(cleaned);
    return;
  }

  const previous = script[script.length - 1];
  if (previous.trimEnd().endsWith('\\')) {
    // Turn a visual Bash line continuation into one clean logical line.
    // Important: do not leave "\printf" / "\pwd" artifacts.
    script[script.length - 1] = previous.replace(/\\\s*$/, '').trimEnd() + ' ' + cleaned.trimStart();
    return;
  }

  script.push(cleaned);
}

function normalizeShellBlockToScript(text, options = {}) {
  const rawText = String(text || '').replace(/\u00a0/g, ' ');
  const lines = rawText.split(/\r?\n/);

  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  if (!lines.length) return '';

  const hasPrompt = lines.some((line) => looksLikePromptLine(line));

  // Real bash/sh code blocks often contain plain scripts without a leading "$" prompt.
  // If the block is explicitly shell-labelled and has no transcript prompt, run it as-is.
  if (!hasPrompt && options.allowPlainScript) {
    return lines.join('\n').trim();
  }

  const script = [];
  let heredocEnd = null;

  for (const rawLine of lines) {
    const line = String(rawLine || '');
    const prompt = looksLikePromptLine(line);

    if (prompt) {
      const command = prompt.command;
      if (command) {
        appendScriptLine(script, command);
        heredocEnd = heredocDelimiterFromLine(command) || heredocEnd;
      }
      continue;
    }

    const trimmedStart = line.trimStart();
    const previous = script.length ? script[script.length - 1] : '';
    const previousContinues = previous.trimEnd().endsWith('\\');

    if (heredocEnd) {
      appendScriptLine(script, line);
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }

    if (trimmedStart.startsWith('>')) {
      const continuation = trimmedStart.slice(1).trimStart();
      appendScriptLine(script, continuation);
      heredocEnd = heredocDelimiterFromLine(continuation) || heredocEnd;
      continue;
    }

    // Important for ChatGPT-rendered multi-line bash blocks:
    // $ cd project && \
    // printf ...
    // The second line is not a new prompt, but it is part of the command.
    if (previousContinues) {
      appendScriptLine(script, line);
      heredocEnd = heredocDelimiterFromLine(line) || heredocEnd;
      continue;
    }

    // Otherwise treat non-prompt lines as transcript output and do not execute them.
  }

  return script.join('\n').trim();
}

function stripPromptLinesToCommand(text) {
  return normalizeShellBlockToScript(text, { allowPlainScript: false });
}

function languageKindFromHint(value) {
  const hint = String(value || '').toLowerCase();
  if (!hint) return '';

  // Common ChatGPT / highlight.js / markdown language labels and classes.
  // Keep C strict so ordinary words containing the letter "c" do not match.
  if (/(^|[^a-z0-9])(language-|lang-|source-)?(bash|sh|shell|zsh|console|terminal)([^a-z0-9]|$)/.test(hint)) return 'shell';
  if (/(^|[^a-z0-9])(language-|lang-|source-)?(python|py)([^a-z0-9]|$)/.test(hint)) return 'python';
  if (/(^|[^a-z0-9])(language-|lang-|source-)?(cpp|c\+\+|cxx|cc)([^a-z0-9]|$)/.test(hint)) return 'cpp';
  if (/(^|[^a-z0-9])(language-|lang-|source-)?c([^a-z0-9+#-]|$)/.test(hint)) return 'c';
  return '';
}

function languageHintFields(el, includeText = false) {
  if (!el) return '';
  const fields = [
    String(el.getAttribute?.('data-language') || ''),
    String(el.className || ''),
    String(el.getAttribute?.('aria-label') || ''),
    String(el.getAttribute?.('data-testid') || '')
  ];
  if (includeText) {
    // innerText can force a synchronous layout calculation. The language
    // header is plain text, so textContent is sufficient and much cheaper.
    const text = String(el.textContent || '').trim();
    if (text.length <= 200) fields.push(text);
  }
  return fields.join(' ');
}

function nearestExplicitCodeLanguage(code) {
  const cached = CODE_LANGUAGE_CACHE.get(code);
  if (cached) return cached;

  function remember(kind) {
    if (kind) CODE_LANGUAGE_CACHE.set(code, kind);
    return kind;
  }

  // Prefer a language attached directly to <pre>/<code>.
  const ownKind = languageKindFromHint(languageHintFields(code));
  if (ownKind) return remember(ownKind);
  for (const inner of Array.from(code.querySelectorAll?.('code') || [])) {
    const kind = languageKindFromHint(languageHintFields(inner));
    if (kind) return remember(kind);
  }

  // In current ChatGPT markup the visible language label is in a header that
  // precedes a deeply nested content wrapper. Search from <pre> outwards and
  // return immediately on the first language marker. This is important when
  // one assistant message contains several differently labelled code blocks.
  let el = code.parentElement;
  for (let i = 0; el && i < 16; i++, el = el.parentElement) {
    const parentKind = languageKindFromHint(languageHintFields(el));
    if (parentKind) return remember(parentKind);
    if (el.matches?.('article, [data-message-author-role]')) break;

    let siblingCount = 0;
    for (let sibling = el.previousElementSibling;
      sibling && siblingCount < 4;
      sibling = sibling.previousElementSibling, siblingCount++) {
      const siblingKind = languageKindFromHint(languageHintFields(sibling, true));
      if (siblingKind) return remember(siblingKind);

      for (const labelled of Array.from(sibling.querySelectorAll?.(
        '[data-language], [aria-label], [data-testid], [class*="language-"], [class*="lang-"]'
      ) || [])) {
        const labelledKind = languageKindFromHint(languageHintFields(labelled, true));
        if (labelledKind) return remember(labelledKind);
      }
    }
  }
  return '';
}

function isExplicitShellCodeBlock(code) {
  return nearestExplicitCodeLanguage(code) === 'shell';
}

function looksLikePlainShellScript(text) {
  const source = String(text || '').trim();
  if (!source) return false;
  if (/\[exit code:|\[LOCAL COMMAND ERROR\]|\[stdout |\[stderr |\[BINARY /i.test(source)) return false;

  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;

  // Transcript prompts are shell even if the code block has no language class.
  if (lines.some((line) => looksLikePromptLine(line))) return true;

  const first = lines[0];
  const joined = lines.slice(0, 8).join('\n');

  // Strong shell-script markers. This makes code blocks like
  //   cat > /tmp/at.py <<'PY'
  //   ...
  //   PY
  // runnable even when ChatGPT's DOM does not expose language-bash.
  if (/^#!\s*\/.*\b(bash|sh|zsh)\b/.test(first)) return true;
  if (/\b(cat|tee)\s+>\s+\S+\s+<<-?['"]?[A-Za-z0-9_./-]+['"]?/.test(joined)) return true;
  if (/\\\s*$/.test(first) || lines.some((line) => /&&\s*\\\s*$/.test(line))) return true;

  // Common one-liners we actually use in this workflow.
  const shellStart = /^(cd|pwd|ls|find|grep|sed|awk|cat|head|tail|wc|printf|echo|mkdir|rm|cp|mv|chmod|adb|stty|timeout|python3?|node|git|cmake|make|unzip|zip|tar|sudo)\b/;
  if (shellStart.test(first)) return true;

  // Assignment followed by command, e.g. FOO=1 make.
  if (/^[A-Za-z_][A-Za-z0-9_]*=.*\s+\w+/.test(first)) return true;

  return false;
}


function looksLikePlainPythonScript(text) {
  const source = String(text || '').trim();
  if (!source) return false;
  if (/\[exit code:|\[LOCAL COMMAND ERROR\]|\[stdout |\[stderr |\[BINARY /i.test(source)) return false;

  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;

  // Avoid stealing obvious shell/C/C++ blocks.
  const first = lines[0];
  if (looksLikePromptLine(first) || isExplicitShellCodeBlock({ querySelectorAll: () => [], className: '', getAttribute: () => '' })) return false;
  if (/^(cd|pwd|ls|find|grep|sed|awk|cat|head|tail|wc|printf|echo|mkdir|rm|cp|mv|chmod|adb|timeout|node|git|cmake|make|sudo)\b/.test(first)) return false;
  if (/^#\s*include\b|\bint\s+main\s*\(/.test(source)) return false;

  const joined = lines.slice(0, 30).join('\n');
  let score = 0;

  if (/^#!.*\bpython[0-9.]*\b/.test(first)) score += 4;
  if (/^\s*(from\s+[A-Za-z_][\w.]*\s+import\s+|import\s+[A-Za-z_][\w.]*)/m.test(source)) score += 2;
  if (/^\s*(def|class)\s+[A-Za-z_][\w]*\s*[(:]/m.test(source)) score += 3;
  if (/^\s*(for|if|elif|else|while|try|except|finally|with)\b.*:\s*$/m.test(source)) score += 2;
  if (/\bprint\s*\(/.test(source)) score += 2;
  if (/\bf[\"'][^\n]*\{[^\n]+\}[^\n]*[\"']/.test(source)) score += 1;
  if (/^\s*[A-Za-z_]\w*\s*=\s*(\[|\{|\(|\"|'|\d|True\b|False\b|None\b)/m.test(source)) score += 1;
  if (/^\s{4,}\S/m.test(source) && /:\s*\n\s{4,}\S/.test(source)) score += 1;

  return score >= 2;
}

function looksLikePlainCBlock(text) {
  const source = String(text || '').trim();
  if (!source || /\[exit code:|\[LOCAL COMMAND ERROR\]|\[stdout |\[stderr |\[BINARY /i.test(source)) return false;
  if (/^\s*#\s*include\s*<[^>]+\.h>/m.test(source)) return true;
  if (/\bint\s+main\s*\([^)]*\)\s*\{/.test(source) && /\bprintf\s*\(/.test(source)) return true;
  return false;
}

function looksLikePlainCppBlock(text) {
  const source = String(text || '').trim();
  if (!source || /\[exit code:|\[LOCAL COMMAND ERROR\]|\[stdout |\[stderr |\[BINARY /i.test(source)) return false;
  if (/^\s*#\s*include\s*<iostream>/m.test(source)) return true;
  if (/\bstd::|\busing\s+namespace\s+std\b|\bcout\s*<</.test(source)) return true;
  return false;
}

function explicitCodeLanguage(code) {
  return nearestExplicitCodeLanguage(code);
}

function runnableKindForCodeBlock(code, suppliedText = null) {
  const text = suppliedText == null ? getCodeText(code) : suppliedText;
  if (!text) return '';
  if (/\[exit code:|\[LOCAL COMMAND ERROR\]|\[stdout |\[stderr |\[BINARY /i.test(text)) return '';

  const explicit = explicitCodeLanguage(code);
  if (explicit) return explicit;

  // v1.2.1: ChatGPT sometimes renders a Python fence without language-*
  // classes. In that case a pure Python block had no inline button. Detect
  // common Python/C/C++ syntax conservatively before falling back to shell.
  if (looksLikePlainPythonScript(text)) return 'python';
  if (looksLikePlainCppBlock(text)) return 'cpp';
  if (looksLikePlainCBlock(text)) return 'c';

  if (looksLikePlainShellScript(text)) return 'shell';
  return '';
}

function runnableLabel(kind) {
  // Keep the visible button name stable. The exact runtime is shown in title/confirm.
  return 'Run locally';
}

function getInlineRunnablePayload(block) {
  // Most refreshes are caused by a different, currently streaming message.
  // Avoid cloning and extracting every unchanged historical code block again.
  const rawText = String(block?.textContent || '');
  const cached = CODE_PAYLOAD_CACHE.get(block);
  if (cached?.rawText === rawText) return cached.payload;

  const text = getCodeText(block);
  const kind = runnableKindForCodeBlock(block, text);
  if (!kind) return null;
  let payload;
  if (kind === 'shell') {
    payload = { kind: 'shell', command: normalizeShellBlockToScript(text, { allowPlainScript: true }) };
  } else {
    payload = { kind, code: cleanExtractedCodeText(text) };
  }
  CODE_PAYLOAD_CACHE.set(block, { rawText, payload });
  return payload;
}

function isLikelyShellCodeBlock(code) {
  const text = getCodeText(code);
  if (!text) return false;
  if (/\[exit code:|\[LOCAL COMMAND ERROR\]|\[stdout |\[stderr |\[BINARY /i.test(text)) return false;

  return isExplicitShellCodeBlock(code) || looksLikePlainShellScript(text);
}

function getInlineCommandFromCode(code) {
  const text = getCodeText(code);
  // v0.8: any block that gets an inline Run button is executed as the whole
  // script. A leading "$" prompt is optional, not required.
  return normalizeShellBlockToScript(text, { allowPlainScript: true });
}


function codeTextFingerprint(text) {
  const source = String(text || '');
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${source.length}:${hash.toString(16)}`;
}

function getCodeBlockStability(code, command) {
  const fp = codeTextFingerprint(command || getCodeText(code));
  const now = Date.now();
  const previous = code.dataset.alcbFingerprint || '';

  if (previous !== fp) {
    code.dataset.alcbFingerprint = fp;
    code.dataset.alcbStableSince = String(now);
    return { fingerprint: fp, stableMs: 0, stable: false };
  }

  const since = Number(code.dataset.alcbStableSince || now);
  const stableMs = Math.max(0, now - since);
  return { fingerprint: fp, stableMs, stable: stableMs >= 900 };
}

function findIncompleteHeredoc(script) {
  const lines = String(script || '').split(/\r?\n/);
  let expected = null;

  for (const line of lines) {
    if (expected) {
      if (line.trim() === expected) expected = null;
      continue;
    }
    expected = heredocDelimiterFromLine(line);
  }

  return expected;
}

function summarizeCommand(command) {
  const lines = String(command || '').split(/\r?\n/);
  const first = (lines.find((line) => line.trim()) || '').trim();
  const suffix = lines.length > 1 ? ` (${lines.length} lines)` : '';
  return `${first.slice(0, 120)}${suffix}`;
}

function setInlineButtonText(button, text) {
  if (button.textContent !== text) button.textContent = text;
}

// One pending stability timer per DOM code block.
// A stability check must not trigger a full-page refresh.
const ALCB_STABILITY_TIMERS = new WeakMap();

function clearInlineStabilityTimer(code) {
  const id = ALCB_STABILITY_TIMERS.get(code);
  if (id !== undefined) {
    clearTimeout(id);
    ALCB_STABILITY_TIMERS.delete(code);
  }
}

function updateInlineButtonState(code, button, suppliedPayload = null) {
  const payload = suppliedPayload || getInlineRunnablePayload(code);
  const displayText = payload?.kind === 'shell' ? payload.command : payload?.code;
  const stability = getCodeBlockStability(code, displayText || '');

  button.dataset.alcbCommandFingerprint = stability.fingerprint;

  if (!payload || !displayText) {
    clearInlineStabilityTimer(code);
    button.disabled = true;
    setInlineButtonText(button, 'No command');
    button.title = 'No runnable code detected';
    return false;
  }

  button.dataset.alcbRunKind = payload.kind;
  button.title = payload.kind === 'shell'
    ? `Run locally: ${summarizeCommand(payload.command)}`
    : `${runnableLabel(payload.kind)} locally (${String(displayText).split(/\r?\n/).length} lines)`;

  if (payload.kind === 'shell') {
    const heredocMissing = findIncompleteHeredoc(payload.command);
    if (heredocMissing) {
      button.disabled = true;
      setInlineButtonText(button, `Incomplete <<${heredocMissing}`);
      // Wait for DOM changes, not a recurring timer.
      clearInlineStabilityTimer(code);
      return false;
    }
  }

  if (!stability.stable) {
    button.disabled = true;
    button.hidden = true;

    // Replace any existing timer for this block.
    clearInlineStabilityTimer(code);

    const id = setTimeout(() => {
      ALCB_STABILITY_TIMERS.delete(code);

      if (!code.isConnected || !button.isConnected) return;

      // Refresh only this button, not every code block.
      updateInlineButtonState(code, button);
    }, Math.max(250, 950 - stability.stableMs));

    ALCB_STABILITY_TIMERS.set(code, id);
    return false;
  }

  clearInlineStabilityTimer(code);
  button.disabled = false;
  button.hidden = false;
  setInlineButtonText(button, runnableLabel(payload.kind));
  return true;
}

function attachInlineRunButtons() {
  // Only fenced code blocks. Never attach Run locally to inline code.
  const blocks = Array.from(document.querySelectorAll('pre'));

  for (const block of blocks) {
    const payload = getInlineRunnablePayload(block);
    if (!payload) continue;

    const host = block.closest?.('pre') || block;
    const wrapper = host.parentElement || host;
    wrapper.classList.add('alcb-inline-wrapper');

    let button = wrapper.querySelector(':scope > .alcb-inline-run');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'alcb-inline-run';
      button.hidden = true;
      button.textContent = '';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        // Re-read the whole <pre> at click time. Never run a child <code>
        // fragment captured earlier.
        const payload = getInlineRunnablePayload(block);
        const displayText = payload?.kind === 'shell' ? payload.command : payload?.code;
        const stability = getCodeBlockStability(block, displayText || '');

        if (!payload || !displayText) {
          window.alert('No runnable code detected.');
          updateInlineButtonState(block, button);
          return;
        }

        if (payload.kind === 'shell') {
          const missing = findIncompleteHeredoc(payload.command);
          if (missing) {
            window.alert(`This shell block has an incomplete heredoc: missing terminator ${missing}. It will not be run.`);
            updateInlineButtonState(block, button);
            return;
          }
        }

        if (!stability.stable) {
          window.alert('This code block is still changing. Wait until the button is enabled.');
          updateInlineButtonState(block, button);
          return;
        }

        if (payload.kind === 'shell') runCommand(payload.command, button);
        else runCodeBlock(payload.kind, payload.code, button);
      });
      wrapper.appendChild(button);
    }

    block.dataset.alcbButtonAttached = '1';
    updateInlineButtonState(block, button, payload);
  }
}

function sendRuntimeMessage(message) {
  // Chrome extension content scripts expose chrome.runtime.  Do not use
  // browser.runtime here: in Chrome it is commonly undefined and creates the
  // exact error: Cannot read properties of undefined (reading 'sendMessage').
  if (!globalThis.chrome) {
    throw new Error('[ALCB v1.2] chrome API is unavailable. This content.js is not running as a Chrome extension content script. Reload the extension from chrome://extensions and refresh chatgpt.com.');
  }
  if (!globalThis.chrome.runtime) {
    throw new Error('[ALCB v1.2] chrome.runtime is unavailable. Disable duplicate/old copies of this extension, reload this extension, then refresh chatgpt.com.');
  }
  if (typeof globalThis.chrome.runtime.sendMessage !== 'function') {
    throw new Error('[ALCB v1.2] chrome.runtime.sendMessage is unavailable. The extension runtime is not connected.');
  }

  return new Promise((resolve, reject) => {
    globalThis.chrome.runtime.sendMessage(message, (response) => {
      const err = globalThis.chrome.runtime.lastError;
      if (err) {
        reject(new Error('[ALCB v1.2] ' + err.message));
        return;
      }
      resolve(response);
    });
  });
}


async function refreshBridgeState() {
  try {
    const response = await sendRuntimeMessage({ type: 'ALCB_GET_STATE' });
    if (response?.ok) {
      STATE.bridgeState = response.state || STATE.bridgeState;
      renderBridgeState();
    }
  } catch (e) {
    setStatus(e?.message || String(e));
  }
}

function formatTimeout(timeoutMs) {
  const ms = Number(timeoutMs) || CONFIG.timeoutMs;
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function currentTimeoutMs() {
  return Number(STATE.bridgeState?.timeoutMs) || CONFIG.timeoutMs;
}

function renderBridgeState() {
  const panel = ensurePanel();
  const st = STATE.bridgeState || {};
  const cfg = panel.querySelector('#alcb-cfg');
  if (cfg) {
    cfg.textContent = [
      `CFG: ${st.cfgPath || '-'}`,
      `BASHRC: ${st.bashrc || '-'}`,
      `CWD: ${st.cwd || '-'}`,
      `TMO: ${formatTimeout(st.timeoutMs || CONFIG.timeoutMs)}`
    ].join('\n');
  }

  const list = panel.querySelector('#alcb-saved-list');
  if (!list) return;
  list.innerHTML = '';
  const commands = Array.isArray(st.commands) ? st.commands : [];
  if (!commands.length) {
    const empty = document.createElement('div');
    empty.className = 'alcb-saved-empty';
    empty.textContent = 'No saved commands yet';
    list.appendChild(empty);
    return;
  }

  commands.forEach((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'alcb-saved-item';
    row.dataset.index = String(index);
    row.title = item.command || '';
    row.textContent = item.title || item.command || `Command ${index + 1}`;
    row.addEventListener('click', () => {
      list.querySelectorAll('.alcb-saved-item').forEach((el) => el.classList.remove('selected'));
      row.classList.add('selected');
    });
    list.appendChild(row);
  });
}

function selectedSavedIndex() {
  const panel = ensurePanel();
  const selected = panel.querySelector('#alcb-saved-list .alcb-saved-item.selected');
  if (!selected) return -1;
  return Number(selected.dataset.index || -1);
}

async function addCurrentSavedCommand() {
  const command = STATE.command || getComposerText(getComposer()).trim();
  if (!command) {
    window.alert('No current command to save.');
    return;
  }
  const first = command.split(/\r?\n/).find((line) => line.trim()) || command;
  const title = window.prompt('Command title:', first.trim().slice(0, 80));
  if (!title) return;
  const response = await sendRuntimeMessage({ type: 'ALCB_ADD_SAVED_COMMAND', title, command });
  if (!response?.ok) {
    window.alert(response?.error || 'Failed to save command');
    return;
  }
  STATE.bridgeState = response.state || STATE.bridgeState;
  renderBridgeState();
}

async function deleteSelectedSavedCommand() {
  const index = selectedSavedIndex();
  if (index < 0) {
    window.alert('Select a saved command first.');
    return;
  }
  const item = STATE.bridgeState.commands?.[index];
  if (!window.confirm(`Delete saved command?\n\n${item?.title || item?.command || index}`)) return;
  const response = await sendRuntimeMessage({ type: 'ALCB_DELETE_SAVED_COMMAND', index });
  if (!response?.ok) {
    window.alert(response?.error || 'Failed to delete command');
    return;
  }
  STATE.bridgeState = response.state || STATE.bridgeState;
  renderBridgeState();
}

function runSelectedSavedCommand() {
  const index = selectedSavedIndex();
  if (index < 0) {
    window.alert('Select a saved command first.');
    return;
  }
  const item = STATE.bridgeState.commands?.[index];
  if (!item?.command) return;
  runCommand(item.command, null);
}

function refreshPanel() {
  const composer = getComposer();
  const composerText = getComposerText(composer);
  STATE.lastComposerText = composerText;

  let command = extractDollarCommand(composerText);

  if (!command) {
    const found = getLatestDollarCommandFromCodeBlocks();
    command = found?.command || '';
  }

  STATE.command = command;

  const panel = ensurePanel();
  renderBridgeState();
  panel.classList.add('alcb-visible');

  if (STATE.running) return;

  if (!command) {
    panel.querySelector('#alcb-command').textContent = 'No current command detected';
    setStatus('Use $ setcfg $HOME/my.cfg or run a saved command.');
    return;
  }

  panel.querySelector('#alcb-command').textContent = `$ ${command}`;
  setStatus(`Detected local command. Timeout: ${formatTimeout(currentTimeoutMs())}.`);
}

function formatPayload(name, payload) {
  if (!payload) return '';
  const bytes = Number(payload.bytes || 0);
  const truncated = payload.truncated ? ', truncated' : '';

  if (payload.kind === 'text') {
    const label = payload.truncated
      ? `[TRUNCATED ${name} text/plain, ${bytes} bytes]`
      : `[${name} text/plain, ${bytes} bytes]`;
    return `${label}\n\n\`\`\`text\n${payload.data || ''}\n\`\`\``;
  }

  const mime = payload.mime || 'application/octet-stream';
  const label = `[BINARY ${name} ${mime}, ${bytes} bytes${truncated}, base64]`;
  return `${label}\n\n\`\`\`base64\n${payload.data || ''}\n\`\`\``;
}

function formatCommandResult(command, rpcResponse) {
  const result = rpcResponse.result;
  if (!result) return `$ ${command}\n[empty result]`;

  const parts = [
    `${command.includes('\n') ? command : `$ ${command}`}`,
    `[exit code: ${result.exitCode}${result.signal ? `, signal: ${result.signal}` : ''}, duration: ${result.durationMs} ms]`
  ];

  const stdout = formatPayload('stdout', result.stdout);
  const stderr = formatPayload('stderr', result.stderr);
  if (stdout) parts.push(stdout);
  if (stderr && (result.stderr?.bytes || result.stderr?.data)) parts.push(stderr);

  return parts.join('\n\n');
}

function insertTextIntoComposer(text) {
  const el = getComposer();
  if (!el) throw new Error('Composer not found');

  const addition = `\n\n${text}\n`;
  el.focus();

  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + addition + el.value.slice(end);
    const pos = start + addition.length;
    el.selectionStart = el.selectionEnd = pos;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  // ContentEditable / ProseMirror path.
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);

  // execCommand still works well for contenteditable insertion in Chrome.
  document.execCommand('insertText', false, addition);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: addition }));
}

async function runCommand(command, triggerButton = null, options = {}) {
  if (!command || STATE.running) return;

  const missing = findIncompleteHeredoc(command);
  if (missing) {
    window.alert(`Refusing to run incomplete heredoc: missing terminator ${missing}`);
    return;
  }

  const lineCount = String(command).split(/\r?\n/).length;
  const preview = command.includes('\n') ? command : `$ ${command}`;

  if (options.confirm !== false) {
    const ok = window.confirm(`Run this local command?\n\nLines: ${lineCount}   Bytes: ${new Blob([command]).size}\n\n${preview}`);
    if (!ok) return;
  }

  STATE.running = true;
  const panel = ensurePanel();
  panel.classList.add('alcb-visible');
  const oldButtonText = triggerButton?.textContent;
  if (triggerButton) {
    triggerButton.textContent = 'Running...';
    triggerButton.disabled = true;
  }
  setStatus(`Running... timeout ${formatTimeout(currentTimeoutMs())}`);

  try {
    const response = await sendRuntimeMessage({
      type: 'ALCB_RUN_COMMAND',
      command,
      timeoutMs: `${options.timeoutMs ?? currentTimeoutMs()}ms`,
      maxStdoutBytes: CONFIG.maxStdoutBytes,
      maxStderrBytes: CONFIG.maxStderrBytes
    });

    if (!response?.ok) throw new Error(response?.error || 'Unknown extension error');
    if (response.state) {
      STATE.bridgeState = response.state;
      renderBridgeState();
    }

    const formatted = formatCommandResult(command, response.response);
    insertTextIntoComposer(formatted);
    setStatus('Inserted result into composer.');
    if (triggerButton) triggerButton.textContent = 'Inserted';
  } catch (e) {
    const renderedCommand = command.includes('\n') ? command : `$ ${command}`;
    const errorText = `${renderedCommand}\n\n[LOCAL COMMAND ERROR]\n\n\`\`\`text\n${e?.message || String(e)}\n\`\`\``;
    try { insertTextIntoComposer(errorText); } catch (_) {}
    setStatus(e?.message || String(e));
    if (triggerButton) triggerButton.textContent = 'Error';
  } finally {
    STATE.running = false;
    if (triggerButton) {
      setTimeout(() => {
        triggerButton.disabled = false;
        triggerButton.textContent = oldButtonText || 'Run locally';
      }, 1200);
    }
    setTimeout(refreshPanel, 400);
  }
}


function formatCodeRunResult(language, code, rpcResponse) {
  const result = rpcResponse.result;
  const langLabel = language === 'cpp' ? 'C++' : language === 'c' ? 'C' : 'Python';
  if (!result) return `${langLabel} block\n[empty result]`;

  const parts = [
    `${langLabel} block (${String(code).split(/\r?\n/).length} lines)`,
    `[exit code: ${result.exitCode}${result.signal ? `, signal: ${result.signal}` : ''}, duration: ${result.durationMs} ms]`
  ];

  const stdout = formatPayload('stdout', result.stdout);
  const stderr = formatPayload('stderr', result.stderr);
  if (stdout) parts.push(stdout);
  if (stderr && (result.stderr?.bytes || result.stderr?.data)) parts.push(stderr);

  return parts.join('\n\n');
}

async function runCodeBlock(language, code, triggerButton = null, options = {}) {
  if (!code || STATE.running) return;

  const langLabel = language === 'cpp' ? 'C++' : language === 'c' ? 'C' : 'Python';
  const lineCount = String(code).split(/\r?\n/).length;
  const preview = code.length > 4000 ? code.slice(0, 4000) + '\n…' : code;

  if (options.confirm !== false) {
    const ok = window.confirm(`Run this ${langLabel} code locally?\n\nLines: ${lineCount}   Bytes: ${new Blob([code]).size}\n\n${preview}`);
    if (!ok) return;
  }

  STATE.running = true;
  const panel = ensurePanel();
  panel.classList.add('alcb-visible');
  const oldButtonText = triggerButton?.textContent;
  if (triggerButton) {
    triggerButton.textContent = 'Running...';
    triggerButton.disabled = true;
  }
  setStatus(`Running ${langLabel}... timeout ${formatTimeout(currentTimeoutMs())}`);

  try {
    const response = await sendRuntimeMessage({
      type: 'ALCB_RUN_CODE',
      language,
      code,
      timeoutMs: `${options.timeoutMs ?? currentTimeoutMs()}ms`,
      maxStdoutBytes: CONFIG.maxStdoutBytes,
      maxStderrBytes: CONFIG.maxStderrBytes
    });

    if (!response?.ok) throw new Error(response?.error || 'Unknown extension error');
    if (response.state) {
      STATE.bridgeState = response.state;
      renderBridgeState();
    }

    const formatted = formatCodeRunResult(language, code, response.response);
    insertTextIntoComposer(formatted);
    setStatus('Inserted result into composer.');
    if (triggerButton) triggerButton.textContent = 'Inserted';
  } catch (e) {
    const errorText = `${langLabel} block\n\n[LOCAL CODE ERROR]\n\n\`\`\`text\n${e?.message || String(e)}\n\`\`\``;
    try { insertTextIntoComposer(errorText); } catch (_) {}
    setStatus(e?.message || String(e));
    if (triggerButton) triggerButton.textContent = 'Error';
  } finally {
    STATE.running = false;
    if (triggerButton) {
      setTimeout(() => {
        triggerButton.disabled = false;
        triggerButton.textContent = oldButtonText || runnableLabel(language);
      }, 1200);
    }
    setTimeout(refreshPanel, 400);
  }
}

async function runDomBlock(code, block, triggerButton = null, options = {}) {
  if (!code || STATE.running) return;

  STATE.running = true;

  const panel = ensurePanel();
  panel.classList.add('alcb-visible');

  const oldButtonText = triggerButton?.textContent;

  if (triggerButton) {
    triggerButton.textContent = 'Running...';
    triggerButton.disabled = true;
  }

  const timeoutMs =
    options.timeoutMs ??
    block?.timeoutMs ??
    currentTimeoutMs();

  setStatus(
    `Running DOM JS... timeout ${formatTimeout(timeoutMs)}`
  );

  try {
    const response = await sendRuntimeMessage({
      type: 'ALCB_RUN_DOM',
      id: block?.id || '',
      code,
      urlre: block?.urlre || null,
      titlere: block?.titlere || null,
      timeoutMs
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Unknown DOM execution error');
    }

    const resultText =
      'ALCB/2 RESULT\n' +
      `id: ${block?.id || ''}\n` +
      'kind: dom\n' +
      'executor: chrome-main-world\n\n' +
      JSON.stringify(response.response, null, 2);

    insertTextIntoComposer(resultText);

    setStatus('Inserted DOM result into composer.');

    if (triggerButton) {
      triggerButton.textContent = 'Inserted';
    }
  } catch (e) {
    const resultText =
      'ALCB/2 RESULT\n' +
      `id: ${block?.id || ''}\n` +
      'kind: dom\n' +
      'executor: chrome-main-world\n\n' +
      JSON.stringify({
        success: false,
        url: '',
        result: null,
        console: [],
        error: e?.message || String(e)
      }, null, 2);

    try {
      insertTextIntoComposer(resultText);
    } catch (_) {}

    setStatus(e?.message || String(e));

    if (triggerButton) {
      triggerButton.textContent = 'Error';
    }
  } finally {
    STATE.running = false;

    if (triggerButton) {
      setTimeout(() => {
        triggerButton.disabled = false;
        triggerButton.textContent =
          oldButtonText || 'Run locally';
      }, 1200);
    }

    setTimeout(refreshPanel, 400);
  }
}

async function runCurrentCommand() {
  return runCommand(STATE.command, null);
}


// ---------------------------------------------------------------------------
// ALCB/2 automatic execution state.
//
// ALCB/2 is the only automatic command transport.
// Discovery is handled by DOM Observer v2.
// Existing commands are baselined and never executed retroactively.
// ---------------------------------------------------------------------------

const AUTO_EXECUTED_BLOCKS = new Set();
let AUTO_EXECUTION_QUEUE = Promise.resolve();

// Do not execute markers while ChatGPT is restoring historical messages.
// The arming timer is pushed forward on every non-extension DOM mutation.
let AUTO_EXECUTION_ARMED = false;
let AUTO_ARM_TIMER = null;
let AUTO_LAST_PAGE_MUTATION = Date.now();

function armAutoExecutionLater(delay = 2500) {
  clearTimeout(AUTO_ARM_TIMER);

  AUTO_ARM_TIMER = setTimeout(() => {
    const quietMs = Date.now() - AUTO_LAST_PAGE_MUTATION;

    if (quietMs < 2200) {
      armAutoExecutionLater(2300 - quietMs);
      return;
    }

    // ALCB/2 history is baselined immediately when content.js loads.
    //
    // ALCB/2 is the only automatic execution transport.
    AUTO_EXECUTION_ARMED = true;

    if (ALCB_DEBUG) {
      globalThis.console?.info(
        '[ALCB/2] ARMED after history settled; fingerprints:',
        AUTO_EXECUTED_BLOCKS.size
      );
    }

    // Catch an ALCB/2 command which appeared after the immediate
    // baseline but before the settling interval finished.
    scanAlcbV2Blocks();
  }, delay);
}

function markerBlockFingerprint(kind, code, blockId = '') {
  const id = String(blockId || '').trim();

  if (id) return `${kind}:id:${id}`;

  return `${kind}:code:${codeTextFingerprint(String(code || ''))}`;
}

// Persistent execution history for ALCB/2.
const AUTO_STORAGE_KEY = 'alcbAutoExecutedV16';

function autoStorageGetExecuted() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AUTO_STORAGE_KEY], (data) => {
      const list = data?.[AUTO_STORAGE_KEY];
      resolve(new Set(Array.isArray(list) ? list : []));
    });
  });
}

function autoStorageRemember(fp) {
  return new Promise((resolve) => {
    chrome.storage.local.get([AUTO_STORAGE_KEY], (data) => {
      const list = Array.isArray(data?.[AUTO_STORAGE_KEY])
        ? data[AUTO_STORAGE_KEY]
        : [];

      if (!list.includes(fp)) {
        list.push(fp);

        // Prevent unbounded growth.
        if (list.length > 1000) {
          list.splice(0, list.length - 1000);
        }
      }

      chrome.storage.local.set({
        [AUTO_STORAGE_KEY]: list
      }, resolve);
    });
  });
}

function stripMarkerIdFromCode(code, suppliedId = '') {
  let text = String(code || '').replace(/\r\n/g, '\n');
  let id = String(suppliedId || '').trim();

  if (id) {
    return { id, code: text };
  }

  const lines = text.split('\n');

  if (!lines.length) {
    return { id: '', code: text };
  }

  const first = String(lines[0] || '');

  // Form 1:
  //
  //   id=foo
  //   echo hello
  //
  let m = first.trim().match(/^id=([A-Za-z0-9._:-]+)$/);

  if (m) {
    id = m[1];
    lines.shift();

    return {
      id,
      code: lines.join('\n').trimStart()
    };
  }

  // Form 2:
  //
  //   id=foo echo hello
  //
  // This is important because ChatGPT DOM can collapse a <br> boundary.
  m = first.match(/^\s*id=([A-Za-z0-9._:-]+)[ \t]+(.*)$/);

  if (m) {
    id = m[1];
    lines[0] = m[2];

    return {
      id,
      code: lines.join('\n').trimStart()
    };
  }

  return {
    id: '',
    code: text
  };
}

function enqueueAutoExecution(block, message) {
  if (ALCB_DEBUG) console.info(
    '[ALCBDBG] enqueueAutoExecution entered',
    {
      armed: AUTO_EXECUTION_ARMED,
      kind: block?.kind,
      id: block?.id
    }
  );

  if (!AUTO_EXECUTION_ARMED) {
    if (ALCB_DEBUG) console.info('[ALCB auto] ignored while history is loading');
    return;
  }

  const normalized = stripMarkerIdFromCode(
    block.code,
    block.id
  );

  const code = normalized.code;
  const blockId = normalized.id;

  if (!code.trim()) return;

  block.id = blockId;
  block.code = code;

  const fp = markerBlockFingerprint(
    block.kind,
    code,
    blockId
  );

  // In-memory fast-path.
  if (AUTO_EXECUTED_BLOCKS.has(fp)) {
    if (ALCB_DEBUG) console.info('[ALCB auto] duplicate ignored (memory):', fp);
    return;
  }

  // Reserve immediately so MutationObserver cannot enqueue the same block
  // multiple times while the async storage check is in progress.
  AUTO_EXECUTED_BLOCKS.add(fp);

  AUTO_EXECUTION_QUEUE = AUTO_EXECUTION_QUEUE
    .catch(() => {})
    .then(async () => {
      const persisted = await autoStorageGetExecuted();

      if (persisted.has(fp)) {
        if (ALCB_DEBUG) console.info(
          '[ALCB auto] duplicate ignored (persistent):',
          fp
        );
        return;
      }

      // Persist BEFORE execution.
      //
      // Even if the page reloads while the command is running, this id will
      // never be automatically executed again.
      await autoStorageRemember(fp);

      if (ALCB_DEBUG) console.info(
        '[ALCB auto] executing',
        block.kind,
        blockId ? `id=${blockId}` : 'no-id',
        fp,
        summarizeCommand(code)
      );

      if (block.kind === 'bash') {
        await runCommand(code, null, {
          confirm: false,
          source: 'auto-marker',
          timeoutMs: block.timeoutMs ?? null
        });
      } else if (block.kind === 'python') {
        await runCodeBlock('python', code, null, {
          confirm: false,
          source: 'auto-marker',
          timeoutMs: block.timeoutMs ?? null
        });
      } else if (block.kind === 'dom') {
        await runDomBlock(code, block, null, {
          confirm: false,
          source: 'auto-marker',
          timeoutMs: block.timeoutMs ?? null
        });
      }

      if (message?.dataset) {
        message.dataset.alcbAutoExecuted = '1';
      }
    })
    .catch((err) => {
      if (ALCB_DEBUG) console.error('[ALCB auto] execution failed', err);
      setStatus(
        `[auto ${block.kind}] ${err?.message || String(err)}`
      );
    });
}


// ---------------------------------------------------------------------------
// ALCB/2 — deterministic fenced-code-block transport
//
// Markdown:
//
// ```text
// ALCB/2 kind=bash id=job-001
// echo hello
// ALCB/END id=job-001
// ```
//
// or:
//
// ```text
// ALCB/2 kind=python id=job-002
// print("hello")
// ALCB/END id=job-002
// ```
//
// A command is complete ONLY when:
//   - opening header exists;
//   - closing footer exists as the final non-empty line;
//   - opening/closing ids match.
//
// Scanner uses both DOM-triggered passes and an independent 750 ms poll.
// ---------------------------------------------------------------------------

const ALCB_V2_POLL_MS = 60000;

function parseAlcbV2Text(rawText) {
  const text = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines = text.split('\n');

  while (lines.length && lines[0].trim() === '') {
    lines.shift();
  }

  while (lines.length && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  if (lines.length < 3) return null;

  const first = lines[0].trim().replace(/^#\s*/, '');

  if (!first.startsWith('ALCB/2 ')) return null;

  const attrsText = first.slice('ALCB/2 '.length);

  // Header values are whitespace-delimited.
  // Spaces inside regexes can be written as \s, e.g.:
  // titlere=^My\s+Work$
  const attrs = Object.create(null);

  for (const token of attrsText.split(/[ \t]+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;

    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);

    if (value) attrs[key] = value;
  }

  const kind = attrs.kind;
  const id = attrs.id;

  if (!['bash', 'python', 'dom'].includes(kind)) {
    return null;
  }

  if (
    !id ||
    !/^[A-Za-z0-9._:-]+$/.test(id) ||
    id === '...' ||
    /^\.+$/.test(id)
  ) {
    return null;
  }

  const timeout = attrs.timeout || null;
  const urlre = attrs.urlre || null;
  const titlere = attrs.titlere || null;

  const footer = lines[lines.length - 1].match(
    /^[ \t]*#?[ \t]*ALCB\/END[ \t]+id=([A-Za-z0-9._:-]+)[ \t]*$/
  );

  if (!footer) {
    return {
      kind,
      id,
      timeout,
      urlre,
      titlere,
      complete: false,
      code: ''
    };
  }

  if (footer[1] !== id) {
    const footerId = footer[1];

    if (id.startsWith(footerId)) {
      return {
        kind,
        id,
        timeout,
        urlre,
        titlere,
        complete: false,
        code: ''
      };
    }

    return {
      kind,
      id,
      timeout,
      urlre,
      titlere,
      complete: false,
      error: `ALCB/2 id mismatch: BEGIN=${id}, END=${footerId}`,
      code: ''
    };
  }

  const code = lines.slice(1, -1).join('\n');

  if (!code.trim()) {
    return {
      kind,
      id,
      timeout,
      urlre,
      titlere,
      complete: false,
      error: 'ALCB/2 payload is empty',
      code: ''
    };
  }

  return {
    kind,
    id,
    code,
    timeout,
    urlre,
    titlere,
    complete: true,
    transport: 'alcb-v2'
  };
}

function alcbV2AssistantScope(node) {
  const adapter = globalThis.ALCB_SITE_ADAPTER;

  if (!adapter?.assistantScope) {
    return null;
  }

  return adapter.assistantScope(node);
}

const ALCB_V2_MAX_DEPTH = 8;
const ALCB_V2_MAX_CONTAINER_TEXT = 65536;
const ALCB_V2_BATCH_MS = 80;

const ALCB_V2_PENDING_ROOTS = new Set();
let ALCB_V2_BATCH_TIMER = null;


function alcbV2NodeElement(node) {
  if (!node) return null;

  if (node.nodeType === Node.ELEMENT_NODE) {
    return node;
  }

  return node.parentElement || null;
}


function alcbV2IgnoredElement(el) {
  if (!el?.closest) return true;

  if (el.closest('#alcb-panel, .alcb-inline-run')) {
    return true;
  }

  if (el.closest('textarea, [contenteditable="true"]')) {
    return true;
  }

  return false;
}


// Extract exact ALCB/2 protocol blocks from a larger rendered
// container. The container may contain prose before/after the command.
//
// This is the key difference from parseAlcbV2Text(): that parser
// intentionally expects ONE complete protocol block. This extractor
// locates such blocks inside arbitrary visible DOM text.
function extractAlcbV2Texts(rawText) {
  const text = String(rawText || '')
    .replace(/\r\n?/g, '\n');

  if (!text.includes('ALCB/2')) {
    return [];
  }

  const lines = text.split('\n');
  const out = [];

  const headerRe =
    /^[ \t]*#?[ \t]*ALCB\/2(?:[ \t]+|$)/;

  const footerRe =
    /^[ \t]*#?[ \t]*ALCB\/END[ \t]+id=([A-Za-z0-9._:-]+)[ \t]*$/;

  for (let i = 0; i < lines.length; i++) {
    const headerLine = lines[i];

    if (!headerRe.test(headerLine)) {
      continue;
    }

    const idMatch = headerLine.match(
      /(?:^|[ \t])id=([A-Za-z0-9._:-]+)(?=$|[ \t])/
    );

    if (!idMatch) {
      continue;
    }

    const id = idMatch[1];

    if (
      id === '...' ||
      /^\.+$/.test(id)
    ) {
      continue;
    }

    let end = -1;

    for (let j = i + 1; j < lines.length; j++) {
      const footer = lines[j].match(footerRe);

      if (footer) {
        if (footer[1] === id) {
          end = j;
        }

        // Never cross an END belonging to another command.
        break;
      }

      // A new ALCB/2 command before our END means this one
      // is incomplete. Never merge adjacent commands.
      if (headerRe.test(lines[j])) {
        break;
      }
    }

    if (end < 0) {
      continue;
    }

    out.push(
      lines.slice(i, end + 1).join('\n')
    );

    // Skip the command we have just consumed.
    i = end;
  }

  return out;
}


// Return candidate elements around one changed point.
//
// We deliberately inspect the changed element AND up to eight parents.
// This handles the important streaming case where ALCB/END is inserted
// as a sibling of the node containing ALCB/2.
function alcbV2CandidateAncestors(start) {
  const result = [];
  const seen = new Set();

  let el = alcbV2NodeElement(start);

  for (
    let depth = 0;
    el && depth <= ALCB_V2_MAX_DEPTH;
    depth++, el = el.parentElement
  ) {
    if (seen.has(el)) continue;
    seen.add(el);

    if (alcbV2IgnoredElement(el)) {
      break;
    }

    const cheapText = String(el.textContent || '');

    if (!cheapText.includes('ALCB/2')) {
      continue;
    }

    // Once a container is huge, its parents will only be larger.
    if (cheapText.length > ALCB_V2_MAX_CONTAINER_TEXT) {
      break;
    }

    result.push(el);
  }

  return result;
}


// Renderer-independent collector.
//
// No site code-block selector is used here.
//
// For a full-document call we first locate TEXT NODES containing ALCB/2,
// then inspect only their nearby ancestors. For a mutation-local call we
// additionally inspect the supplied root itself, because the newly inserted
// node might contain only ALCB/END while its sibling contains the header.
function collectAlcbV2CodeBlocks(root = document.documentElement) {
  const result = [];
  const candidateElements = [];
  const candidateSeen = new Set();

  function addCandidate(el) {
    if (!el || candidateSeen.has(el)) return;
    candidateSeen.add(el);
    candidateElements.push(el);
  }

  const rootEl = alcbV2NodeElement(root);

  if (rootEl && !alcbV2IgnoredElement(rootEl)) {
    for (const el of alcbV2CandidateAncestors(rootEl)) {
      addCandidate(el);
    }
  }

  // Search text nodes only in the supplied subtree.
  // This is cheap for mutation-local roots and is used for the initial
  // baseline / rare safety-net scan for the whole document.
  let walkerRoot = root;

  if (root.nodeType === Node.TEXT_NODE) {
    const value = String(root.nodeValue || '');

    if (value.includes('ALCB/2')) {
      for (const el of alcbV2CandidateAncestors(root)) {
        addCandidate(el);
      }
    }
  } else if (
    root.nodeType === Node.ELEMENT_NODE ||
    root.nodeType === Node.DOCUMENT_NODE ||
    root.nodeType === Node.DOCUMENT_FRAGMENT_NODE
  ) {
    const walker = document.createTreeWalker(
      walkerRoot,
      NodeFilter.SHOW_TEXT
    );

    let node;

    while ((node = walker.nextNode())) {
      const value = String(node.nodeValue || '');

      if (!value.includes('ALCB/2')) {
        continue;
      }

      for (const el of alcbV2CandidateAncestors(node)) {
        addCandidate(el);
      }
    }
  }

  const emitted = new Set();

  for (const container of candidateElements) {
    if (!container.isConnected) continue;

    const assistantScope = alcbV2AssistantScope(container);


    // Site adapter is still allowed to validate that the command came
    // from an assistant response. It no longer tells us WHERE commands
    // are located.
    if (!assistantScope) {
      continue;
    }

    const rawCheap = String(container.textContent || '');

    if (
      !rawCheap.includes('ALCB/2') ||
      rawCheap.length > ALCB_V2_MAX_CONTAINER_TEXT
    ) {
      continue;
    }

    // innerText is only paid for after the cheap textContent filter.
    const visible = String(
      container.innerText ||
      container.textContent ||
      ''
    )
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');

    const extracted = extractAlcbV2Texts(visible);


    for (const blockText of extracted) {
      if (emitted.has(blockText)) continue;
      emitted.add(blockText);

      result.push({
        node: container,
        host: container,
        scope: assistantScope,
        text: blockText
      });
    }
  }

  if (ALCB_DEBUG && result.length) {
    globalThis.console?.info(
      '[ALCB/2 Observer v2] candidates:',
      result.length
    );
  }

  return result;
}


// Add one local DOM region to the pending batch.
//
// The Set is compacted:
// - if an existing root already contains this node, nothing is added;
// - if this node contains smaller queued roots, those roots are removed.
function queueAlcbV2Root(node) {
  const el = alcbV2NodeElement(node);

  if (!el || !el.isConnected) return;
  if (alcbV2IgnoredElement(el)) return;

  for (const existing of Array.from(ALCB_V2_PENDING_ROOTS)) {
    if (!existing?.isConnected) {
      ALCB_V2_PENDING_ROOTS.delete(existing);
      continue;
    }

    if (existing === el || existing.contains(el)) {
      return;
    }

    if (el.contains(existing)) {
      ALCB_V2_PENDING_ROOTS.delete(existing);
    }
  }

  ALCB_V2_PENDING_ROOTS.add(el);

  clearTimeout(ALCB_V2_BATCH_TIMER);

  ALCB_V2_BATCH_TIMER = setTimeout(() => {
    ALCB_V2_BATCH_TIMER = null;

    const roots = Array.from(ALCB_V2_PENDING_ROOTS);
    ALCB_V2_PENDING_ROOTS.clear();


    if (!AUTO_EXECUTION_ARMED) {
      return;
    }

    for (const changedRoot of roots) {
      if (!changedRoot?.isConnected) continue;

      try {
        scanAlcbV2Blocks(changedRoot);
      } catch (err) {
        if (ALCB_DEBUG) {
          globalThis.console?.error(
            '[ALCB/2 Observer v2] local scan failed:',
            err
          );
        }
      }
    }
  }, ALCB_V2_BATCH_MS);
}


function queueAlcbV2MutationRecords(records) {
  scheduleGrokAlcbRetry();

  for (const record of records) {
    const target = record.target;

    if (record.type === 'characterData') {
      queueAlcbV2Root(target);
      continue;
    }

    if (record.type === 'childList') {
      // Important: target may now contain the new END while the header
      // lives in an already existing sibling.
      queueAlcbV2Root(target);

      for (const node of record.addedNodes) {
        queueAlcbV2Root(node);
      }
    }
  }
}

function baselineAlcbV2Blocks() {
  let count = 0;

  for (const item of collectAlcbV2CodeBlocks()) {
    const block = parseAlcbV2Text(item.text);

    if (!block?.complete || !block.code?.trim()) continue;

    const fp = markerBlockFingerprint(
      block.kind,
      block.code,
      block.id
    );

    AUTO_EXECUTED_BLOCKS.add(fp);
    count++;
  }

  if (count) {
    if (ALCB_DEBUG) console.info(
      '[ALCB/2] startup baseline:',
      count,
      'complete code block(s)'
    );
  }
}


// Snapshot ALCB/2 history immediately at content-script startup.
//
// This must happen BEFORE the delayed auto-execution arming window.
// Otherwise a fast newly-generated response can finish during the quiet
// period and be mistaken for historical content.
baselineAlcbV2Blocks();

function parseAlcbV2TimeoutMs(value) {
  if (!value) return null;

  const raw = String(value).trim().toLowerCase();
  const m = raw.match(
    /^([0-9]+(?:\.[0-9]+)?)(ms|s|sec|m|min|h)?$/
  );

  if (!m) return null;

  const n = Number(m[1]);
  const unit = m[2] || 's';

  const factor =
    unit === 'ms' ? 1 :
    unit === 'm' || unit === 'min' ? 60000 :
    unit === 'h' ? 3600000 :
    1000;

  return Math.max(
    1000,
    Math.min(86400000, Math.round(n * factor))
  );
}

const ALCB_V2_PARSE_CACHE = new WeakMap();

function cachedParseAlcbV2(item) {
  const cached = ALCB_V2_PARSE_CACHE.get(item.node);

  if (cached && cached.text === item.text) {
    return cached.result;
  }

  const result = parseAlcbV2Text(item.text);

  ALCB_V2_PARSE_CACHE.set(item.node, {
    text: item.text,
    result
  });

  return result;
}

function scanAlcbV2Blocks(root = document.documentElement) {
  if (ALCB_DEBUG) console.info(
    '[ALCBDBG] scanAlcbV2Blocks',
    'armed=' + AUTO_EXECUTION_ARMED,
    'site=' + (globalThis.ALCB_SITE_ADAPTER?.id || 'unknown')
  );

  if (!AUTO_EXECUTION_ARMED) {
    if (ALCB_DEBUG) console.info('[ALCBDBG] scanner skipped: not armed');
    return;
  }

  for (const item of collectAlcbV2CodeBlocks(root)) {
    if (ALCB_DEBUG) console.info(
      '[ALCBDBG] candidate',
      String(item.text || '').slice(0, 300)
    );

    const block = cachedParseAlcbV2(item);

    if (ALCB_DEBUG) console.info(
      '[ALCBDBG] parsed',
      block
    );

    if (!block) {
      if (ALCB_DEBUG) console.info('[ALCBDBG] parser returned null');
      continue;
    }

    if (block.error) {
      if (ALCB_DEBUG) console.warn(
        '[ALCB/2]',
        block.error
      );
      continue;
    }

    if (!block.complete) {
      if (ALCB_DEBUG) console.info(
        '[ALCBDBG] block incomplete',
        block.kind,
        block.id || ''
      );
      continue;
    }

    const fp = markerBlockFingerprint(
      block.kind,
      block.code,
      block.id
    );

    if (AUTO_EXECUTED_BLOCKS.has(fp)) {
      if (ALCB_DEBUG) console.info(
        '[ALCBDBG] skipped duplicate memory',
        fp
      );
      continue;
    }

    if (ALCB_DEBUG) console.info(
      '[ALCB/2] complete block:',
      block.kind,
      `id=${block.id}`,
      `chars=${block.code.length}`
    );

    block.timeoutMs = parseAlcbV2TimeoutMs(block.timeout);

    if (ALCB_DEBUG) console.info(
      '[ALCBDBG] enqueue request',
      {
        kind: block.kind,
        id: block.id,
        timeout: block.timeout,
        timeoutMs: block.timeoutMs,
        chars: block.code?.length || 0
      }
    );

    enqueueAutoExecution(
      block,
      item.host
    );
  }
}

// Independent safety-net scanner.
//
// MutationObserver remains the fast path, but even if ChatGPT completes a
// short response between observer/renderer phases this poll will find it.
setInterval(() => {
  try {
    scanAlcbV2Blocks();
  } catch (err) {
    if (ALCB_DEBUG) console.error(
      '[ALCB/2] polling scan failed:',
      err
    );
  }
}, ALCB_V2_POLL_MS);


let timer = null;
let AUTO_SETTLE_TIMERS = [];

// Grok renders message text first and assistant action controls
// (Good response / Regenerate) slightly later.
// Retry a full ALCB/2 scan after those controls have had time to appear.
let GROK_ALCB_RETRY_TIMERS = [];

function scheduleGrokAlcbRetry() {
  if (globalThis.ALCB_SITE_ADAPTER?.id !== 'grok') {
    return;
  }

  for (const id of GROK_ALCB_RETRY_TIMERS) {
    clearTimeout(id);
  }

  GROK_ALCB_RETRY_TIMERS = [300, 1200].map(delay =>
    setTimeout(() => {
      try {
        scanAlcbV2Blocks(document.documentElement);
      } catch (err) {
        if (ALCB_DEBUG) {
          globalThis.console?.error('[ALCB/2] Grok retry scan failed:', err);
        }
      }
    }, delay)
  );
}

const AUTO_SETTLE_DELAYS = [400, 1500];

function runAutoRefreshPass() {
  attachInlineRunButtons();
  refreshPanel();

  // Automatic execution is now ALCB/2 only.
  // ALCB/2 is handled by Observer v2 from mutation-local DOM regions.
  // Do NOT perform a full-document ALCB/2 scan here.
}

function clearAutoSettleTimers() {
  for (const id of AUTO_SETTLE_TIMERS) {
    clearTimeout(id);
  }
  AUTO_SETTLE_TIMERS = [];
}

function scheduleSettledRescans() {
  clearAutoSettleTimers();

  for (const delay of AUTO_SETTLE_DELAYS) {
    const id = setTimeout(() => {
      runAutoRefreshPass();
    }, delay);

    AUTO_SETTLE_TIMERS.push(id);
  }
}

function scheduleRefresh() {
  clearTimeout(timer);
  clearAutoSettleTimers();

  timer = setTimeout(() => {
    runAutoRefreshPass();
  }, 180);

  scheduleSettledRescans();
}

document.addEventListener('input', scheduleRefresh, true);
document.addEventListener('keyup', scheduleRefresh, true);
document.addEventListener('click', scheduleRefresh, true);

function isExtensionOwnedElement(el) {
  return !!el?.closest?.('#alcb-panel, .alcb-inline-run');
}

function mutationsNeedRefresh(records) {
  for (const record of records) {
    const target = record.target?.nodeType === Node.ELEMENT_NODE
      ? record.target
      : record.target?.parentElement;
    if (isExtensionOwnedElement(target)) continue;

    if (record.type === 'childList') {
      const changed = [...record.addedNodes, ...record.removedNodes];
      if (changed.length && changed.every((node) => {
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        return isExtensionOwnedElement(el) || el?.matches?.('#alcb-panel, .alcb-inline-run');
      })) continue;
    }

    return true;
  }
  return false;
}


// Temporary ALCB CPU profiler. Remove after diagnosis.
new MutationObserver((records) => {
  // Preferred ALCB/2 discovery path:
  // inspect only DOM regions affected by this mutation batch.
  queueAlcbV2MutationRecords(records);

  if (mutationsNeedRefresh(records)) {
    AUTO_LAST_PAGE_MUTATION = Date.now();

    if (!AUTO_EXECUTION_ARMED) {
      armAutoExecutionLater();
    }

    scheduleRefresh();
  }
}).observe(document.documentElement, {
  childList: true,
  characterData: true,
  subtree: true
});
ensurePanel();
refreshBridgeState();
scheduleRefresh();
armAutoExecutionLater();
