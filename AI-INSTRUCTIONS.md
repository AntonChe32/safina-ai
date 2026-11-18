# Instructions for AI Assistants Using ALCB

This document tells an AI assistant how to work with
**Anton Local Command Bridge (ALCB)**.

ALCB connects an ordinary browser-based AI chat to the user's local computer.

Supported AI frontends currently include:

- ChatGPT
- Google AI Mode
- DeepSeek
- GigaChat
- Grok / X

The AI does not need native MCP support.

---

## Basic operating model

When local execution is useful, the assistant may output an ALCB command.

The normal work cycle is:

~~~text
reason about the task
        |
        v
emit ALCB command
        |
        v
local execution
        |
        v
receive stdout / stderr / result
        |
        v
analyze the real result
        |
        v
next command or final answer
~~~

The execution result is the source of truth.

Do not claim that an operation succeeded merely because you generated a
command for it.

---

## Command structure

A real ALCB command has this general structure:

~~~text
EXAMPLE: #ALCB/2 kind=bash|python|dom id=<unique-id> timeout=<time>
EXAMPLE: <command or code>
EXAMPLE: #ALCB/END id=<same-unique-id>
~~~

`EXAMPLE:` is used throughout this document deliberately so that documentation
examples cannot execute automatically.

When actually using ALCB, omit the `EXAMPLE:` prefix.

The leading `#` before the protocol marker is optional.

---

## Unique IDs

Every command must use a new unique `id`.

Never reuse the ID of an earlier command.

Good examples:

~~~text
inspect-project-20261118-001
check-git-status-20261118-002
run-tests-20261118-003
~~~

Persistent deduplication may reject an already executed ID.

---

## Bash

Use `kind=bash` for shell commands and normal Linux administration.

Documentation example:

~~~text
EXAMPLE: #ALCB/2 kind=bash id=inspect-system-001 timeout=20s
EXAMPLE: pwd
EXAMPLE: uname -a
EXAMPLE: ls -la
EXAMPLE: #ALCB/END id=inspect-system-001
~~~

In real use, remove `EXAMPLE:` from every line.

Prefer Bash for:

- shell commands;
- Git;
- system diagnostics;
- process inspection;
- package tools;
- filesystem inspection;
- build and test commands.

For non-trivial shell scripts, prefer:

~~~bash
set -euo pipefail
~~~

Use an explicit working directory when appropriate.

---

## Python

Use `kind=python` when Python is more reliable or expressive than shell.

Documentation example:

~~~text
EXAMPLE: #ALCB/2 kind=python id=list-files-001 timeout=20s
EXAMPLE: from pathlib import Path
EXAMPLE: for p in Path(".").iterdir():
EXAMPLE:     print(p)
EXAMPLE: #ALCB/END id=list-files-001
~~~

Python is especially useful for:

- JSON processing;
- text transformations;
- structured filesystem changes;
- calculations;
- data processing;
- tasks involving difficult shell quoting.

---

## DOM JavaScript

Use `kind=dom` when code must execute inside an open browser tab.

Documentation example:

~~~text
EXAMPLE: #ALCB/2 kind=dom id=read-title-001 titlere=Work timeout=10s
EXAMPLE: return {
EXAMPLE:   title: document.title,
EXAMPLE:   url: location.href
EXAMPLE: };
EXAMPLE: #ALCB/END id=read-title-001
~~~

Optional target selectors include:

~~~text
titlere=<regular expression>
urlre=<regular expression>
~~~

DOM execution can be affected by the target page's Content Security Policy.

---

## Important rules

When using ALCB:

1. Always use a new unique ID.
2. Output a complete command block.
3. Opening and closing IDs must match.
4. Do not split one command across multiple assistant messages.
5. Do not use placeholder IDs such as `...`.
6. Choose a reasonable timeout.
7. Wait for and inspect the real execution result.
8. If the command fails, diagnose the returned error instead of assuming.
9. Use a new ID for every retry.

---

## Preferred technical workflow

For software work, prefer:

~~~text
inspect current state
        |
        v
make the smallest useful change
        |
        v
verify syntax / configuration
        |
        v
run tests
        |
        v
inspect diff / result
        |
        v
report completion
~~~

Do not guess something that can cheaply be verified through ALCB.

---

## Output discipline

Avoid unnecessarily large output.

Prefer focused commands such as:

~~~bash
git status --short
git diff --stat
grep
head
tail
sed
find
~~~

Request more detail in a second command when needed.

---

## Git workflow

A good repository workflow is:

~~~text
git status --short
git diff
tests
git diff --check
git add ...
git commit ...
git push
~~~

Only commit or push when requested or clearly required by the user's task.

Never report that a push succeeded until execution output confirms it.

---

## Safety

ALCB executes real commands on the user's machine.

Commands can:

- modify or delete files;
- alter system configuration;
- install or remove software;
- change networking;
- access local data;
- modify repositories;
- communicate over the network;
- stop services;
- expose sensitive information.

Prefer reversible operations.

Inspect paths before destructive filesystem commands.

Create backups for important edits when practical.

Do not expose passwords, private keys, tokens, cookies, or other credentials
in chat output.

An AI-generated command is not automatically safe.

---

## Multi-LLM behavior

ALCB uses the same protocol across supported AI websites.

Do not depend on provider-specific tool syntax.

The relevant abstraction is:

~~~text
AI assistant
    |
    v
ALCB protocol
    |
    v
local machine / browser
~~~

This allows the same local execution bridge to work with multiple LLM
frontends.

---

## Minimal instruction for an AI

The user can tell a new AI assistant:

> You have access to Anton Local Command Bridge (ALCB), which can execute
> Bash, Python, and browser DOM JavaScript on my local machine. When local
> execution is useful, emit a complete ALCB command with a new unique ID.
> After execution, analyze the returned stdout, stderr, exit code, or DOM
> result and continue from the actual runtime state. Never claim success
> before the execution result confirms it.

---

## Important note for documentation authors

Never place a complete executable ALCB block in documentation that may itself
appear inside an ALCB-enabled AI response.

Use an inert prefix such as:

~~~text
EXAMPLE:
~~~

on every protocol and payload line.

Otherwise the documentation example itself may be executed.
