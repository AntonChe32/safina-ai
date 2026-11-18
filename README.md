# safina-ai / Anton Local Command Bridge (ALCB) 3.1.5

**English** | [Русский](README.ru.md)

**safina-ai / ALCB** is a multi-LLM browser automation bridge that connects
ordinary web-based AI chats directly to the user's local computer.

It allows an AI / LLM assistant to emit special `ALCB/2` command blocks.
The Chrome extension detects those blocks in the assistant response and can
execute them locally as **Bash**, **Python**, or **DOM JavaScript**.

ALCB does **not** require the AI website itself to support MCP and is not tied
to one dedicated coding agent.

Currently supported AI frontends:

- **ChatGPT**
- **Google AI Mode**
- **DeepSeek**
- **GigaChat**
- **Grok / X**

> **One local execution bridge, multiple AI frontends.**

ALCB uses Chrome Extension Manifest V3, Chrome Native Messaging, a local
Node.js native host, DOM observation, and site-specific adapters.

---

## Why ALCB?

A normal AI chat can generate a command such as:

~~~bash
uname -a
~~~

but a normal browser page cannot execute that command on the user's Linux
machine.

ALCB provides the missing execution path:

~~~text
ChatGPT / Grok / DeepSeek / Google AI Mode / GigaChat
                         |
                         v
                    AI response
                         |
                         v
                    ALCB/2 block
                         |
                         v
                 Chrome extension
                         |
              +----------+----------+
              |                     |
              v                     v
       Native Messaging       chrome.scripting
              |                     |
              v                     v
        Bash / Python          Browser DOM
              |
              v
        Local computer
~~~

This allows an ordinary web AI chat to:

- execute Bash commands;
- execute Python code;
- inspect stdout, stderr and exit codes;
- work with local files and projects;
- run tests and diagnostic commands;
- modify and inspect source code;
- automate browser DOM operations;
- interact with another open browser tab;
- use command results in the next reasoning step.

---

## Multi-LLM architecture

ALCB is deliberately independent from a single AI provider.

The same local bridge can be controlled from:

~~~text
ChatGPT
Google AI Mode
DeepSeek
GigaChat
Grok
   |
   +------> ALCB/2 ------> local machine
~~~

This is useful when different AI services have different capabilities,
availability, context limits, or usage limits.

Site-specific DOM behavior is isolated in `extension/site-adapter.js`.
The command execution engine remains shared.

---

## ALCB/2 protocol

### Bash

~~~text
#ALCB/2 kind=bash id=job-001 timeout=10s
echo "Hello from ALCB"
#ALCB/END id=job-001
~~~

### Python

~~~text
#ALCB/2 kind=python id=job-002 timeout=20s
import platform
print(platform.platform())
#ALCB/END id=job-002
~~~

### DOM JavaScript

~~~text
#ALCB/2 kind=dom id=job-003 titlere=Work timeout=10s
return document.title;
#ALCB/END id=job-003
~~~

The leading `#` is optional.

### Protocol rules

- `id` must be unique.
- Persistent deduplication prevents accidental automatic re-execution.
- `timeout` is optional.
- Supported kinds are `bash`, `python`, and `dom`.
- A block must belong to an assistant response.
- Header and footer IDs must match.
- Incomplete streaming blocks are not executed.
- Existing historical blocks are baselined when the page loads and are not
  automatically executed.

---

## Architecture

~~~text
LLM web page
    |
    v
site-adapter.js
    |
    v
content.js
    |
    +-- ALCB/2 parser
    +-- MutationObserver
    +-- assistantScope()
    +-- baseline
    +-- persistent dedupe
    |
    v
background.js
    |
    +-- Native Messaging --> host/index.js --> bash / python3
    |
    +-- chrome.scripting ------------------> DOM JavaScript
~~~

Project layout:

~~~text
safina-ai/
├── extension/
│   ├── manifest.json
│   ├── site-adapter.js
│   ├── content.js
│   ├── background.js
│   ├── styles.css
│   └── tests/
│       ├── parseAlcbV2Text.test.js
│       ├── noBareConsole.test.js
│       └── run-tests.sh
├── host/
│   ├── index.js
│   ├── package.json
│   └── com.anton.local_command.json.template
├── examples-commands.json
├── install-linux.sh
├── LICENSE
├── README.md
└── README.ru.md
~~~

---

## Site adapters

Different AI websites use different DOM structures.

Site-specific logic lives in:

~~~text
extension/site-adapter.js
~~~

Each adapter defines:

- hostname matching;
- composer selectors;
- assistant response scope;
- code-block selectors;
- `assistantScope()`.

Adding another browser-based LLM usually requires a new adapter and matching
URL permissions in `manifest.json`.

### Grok

Grok is supported at:

~~~text
x.com/i/grok
~~~

Grok may render assistant action controls slightly later than the response
text. ALCB therefore performs short delayed DOM rescans after relevant
mutations.

---

## DOM automation

`kind=dom` allows an AI response to execute JavaScript in another open tab.

Example:

~~~text
#ALCB/2 kind=dom id=dom-title-001 titlere=Work timeout=10s
return {
  title: document.title,
  url: location.href
};
#ALCB/END id=dom-title-001
~~~

ALCB uses `chrome.scripting.executeScript()` and supports execution in the
`MAIN` JavaScript world.

Page Content Security Policy still matters. A site that forbids
`unsafe-eval` may prevent dynamic string-to-code execution through
`eval`, `Function`, or `AsyncFunction`.

---

## Installation

### 1. Clone

SSH:

~~~bash
git clone git@github.com:AntonChe32/safina-ai.git
cd safina-ai
~~~

HTTPS:

~~~bash
git clone https://github.com/AntonChe32/safina-ai.git
cd safina-ai
~~~

### 2. Load the Chrome extension

Open:

~~~text
chrome://extensions
~~~

Enable **Developer mode**, click **Load unpacked**, and select:

~~~text
extension/
~~~

Chrome will assign an extension ID.

### 3. Install the Native Messaging host

Chrome:

~~~bash
./install-linux.sh <EXTENSION_ID> chrome
~~~

Chromium:

~~~bash
./install-linux.sh <EXTENSION_ID> chromium
~~~

Native host name:

~~~text
com.anton.local_command
~~~

---

## Updating

After changing extension files:

1. Open `chrome://extensions`.
2. Click **Reload** for ALCB.
3. Reload already-open AI tabs with `Ctrl+Shift+R`.

The panel should display:

~~~text
ALCB 3.1.5
~~~

---

## Tests

~~~bash
cd extension/tests
./run-tests.sh
~~~

Current release status:

~~~text
parseAlcbV2Text:
15 passed, 0 failed

noBareConsole:
1 passed, 0 failed
~~~

---

## Native Messaging

`host/index.js` communicates with Chrome using standard Native Messaging
framing:

~~~text
4-byte little-endian message length
+
JSON payload
~~~

Native host stdout is part of this protocol.

Do not use `console.log()` for diagnostics in the native host.
Use `console.error()` or another stderr output method.

---

## Security

ALCB is intentionally capable of executing commands generated by an AI / LLM.

This is powerful and potentially dangerous.

An AI-generated command may:

- delete or corrupt files;
- change operating system configuration;
- install or remove software;
- alter networking;
- access local data;
- transmit data over a network;
- modify repositories;
- stop services;
- execute unintended or destructive operations.

**A command is not safe merely because an AI generated it.**

Use this software entirely **at your own risk and under your own
responsibility**.

See [LICENSE](LICENSE).

---

## Search keywords

Artificial Intelligence, AI, AI automation, AI agent, autonomous agent,
multi-LLM, multi-model AI, LLM, Large Language Model, LLM agent,
agentic AI, AI assistant, AI coding assistant, AI developer tool,
AI shell, AI terminal, AI command execution, local AI automation,
local command execution, LLM automation, LLM tools, LLM tool execution,
browser AI agent, browser automation, browser agent,
Chrome extension automation, Native Messaging, Chrome Native Messaging,
shell automation, Bash automation, Python automation, DOM automation,
JavaScript automation, web automation, AI computer control,
AI-to-shell bridge, LLM-to-shell bridge, AI orchestration,
agent tools, tool calling, computer-use automation, vibe coding,
coding agent, developer automation, ChatGPT automation,
Google AI Mode automation, DeepSeek automation, GigaChat automation,
Grok automation, Linux automation, local agent, local AI tools,
AI browser extension, AI command runner, AI execution bridge.

---

## Versions

| Component | Version |
|---|---|
| `manifest.json` | `3.1.5` |
| `content.js` / `ALCB_VERSION` | `3.1.5` |
| `host/package.json` | `3.1.5` |

---

## License

See [LICENSE](LICENSE).

In short:

> USE AT YOUR OWN RISK.
> YOU ARE RESPONSIBLE FOR WHAT YOU RUN.
> THE AUTHORS ARE NOT RESPONSIBLE FOR THE CONSEQUENCES.

---

## Repository

**GitHub:** `AntonChe32/safina-ai`

**Project:** `safina-ai`

**Core technology:** Anton Local Command Bridge / ALCB
