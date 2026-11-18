# Anton Local Command Bridge (ALCB) 3.1.5

[English](README.md) | **Русский**

Локальный мост между веб-интерфейсом LLM и Linux-машиной.
LLM пишет блок `ALCB/2`, расширение находит его в ответе ассистента,
выполняет локально через Native Messaging и возвращает в чат
`stdout` / `stderr` / `exit code`.

Поддерживаемые сайты (unified-версия): **ChatGPT**, **Google AI Mode**,
**DeepSeek**, **GigaChat**, **Grok**.

Native host name (не меняется): `com.anton.local_command`.

---

## 1. Протокол ALCB/2

Оба варианта заголовка/футера эквивалентны: с `#` и без.

~~~text
ALCB/2 kind=bash id=job-001 timeout=10s
echo hello
ALCB/END id=job-001
~~~

~~~text
#ALCB/2 kind=bash id=job-002 timeout=10s
echo hello
#ALCB/END id=job-002
~~~

Python:

~~~text
#ALCB/2 kind=python id=job-003 timeout=20s
import os
print(os.getcwd())
#ALCB/END id=job-003
~~~

Правила:

- `id` **обязан быть уникальным**. Persistent dedupe блокирует повторный
  автоматический запуск того же `id`, даже после reload вкладки.
- `timeout` опционален: `500ms`, `10s`, `2m`, `1h`. Без него — дефолт хоста.
- `kind` — `bash`, `python` или `dom`.
- Блок выполняется **только** если он внутри ответа ассистента
  (`assistantScope()`), и только когда есть и заголовок, и футер,
  и их `id` совпадают.
- Во время streaming блок считается неполным (`complete: false`)
  и ждёт следующего прохода сканера.

Допустимые формы заголовка/футера:

- `ALCB/2 ...` / `ALCB/END ...`
- `#ALCB/2 ...` / `#ALCB/END ...`
- `# ALCB/2 ...` / `# ALCB/END ...` (пробел после `#`)
- с ведущими пробелами/табами

---

## 2. Архитектура

~~~text
LLM web page
  -> site-adapter.js      DOM-специфика сайта
  -> content.js           парсер ALCB/2, dedupe, baseline, auto-run, Run locally
  -> background.js        chrome.runtime.sendNativeMessage
  -> host/index.js        Node.js, 4-byte LE length + JSON framing
  -> bash / python3
  <- stdout / stderr / exitCode
~~~

Раскладка проекта:

~~~text
~/mmcp/anton-local-command-unified/
├── extension/
│   ├── manifest.json
│   ├── site-adapter.js
│   ├── content.js
│   ├── background.js
│   ├── styles.css
│   └── tests/
│       ├── parseAlcbV2Text.test.js
│       └── run-tests.sh
├── host/
│   ├── index.js
│   └── package.json
├── install-linux.sh
└── README.md
~~~

Добавление нового LLM-сайта — правка только `site-adapter.js`
(`hostname`, `composerSelectors`, `codeBlockSelector`, `assistantScope()`)
+ URL в `manifest.json`. Движок исполнения не трогается.

Для Grok (`x.com/i/grok`) используется отдельный site adapter.
Поскольку элементы управления ответа Grok могут появляться позже самого
текста ответа, `content.js` делает короткие повторные ALCB/2-сканы после
DOM-мутаций.

`kind=dom` выполняет JavaScript в выбранной вкладке через
`chrome.scripting.executeScript()` в `MAIN` world. На страницах с CSP,
запрещающей `unsafe-eval`, произвольный строковый JavaScript через
`AsyncFunction` может быть заблокирован самой страницей.

---

## 3. Установка / обновление

1. Обновить файлы в `extension/`.
2. `chrome://extensions` -> **Reload** у ALCB.
3. На каждой открытой вкладке LLM — **Ctrl+Shift+R**
   (иначе старый `content.js` даст `Extension context invalidated`).
4. В панели ALCB внизу должна быть строка `ALCB 3.1.5`.

Если расширение загружается как **новое** unpacked-расширение — Chrome
сгенерирует новый ID, и native host надо перерегистрировать:

~~~sh
./install-linux.sh <EXTENSION_ID> chrome
# или
./install-linux.sh <EXTENSION_ID> chromium
~~~

---

## 4. Диагностика

- **Run locally работает, auto-run — нет.**
  Проблема почти всегда в `codeBlockSelector` / `assistantScope()` /
  парсере / streaming / baseline / dedupe, а не в Native Messaging.
- **Extension context invalidated.**
  После Reload расширения обнови вкладку (Ctrl+Shift+R).
- **Блок не запускается повторно.**
  Это dedupe по `id` — сделай новый `id`.
- **collectAlcbV2CodeBlocks находит 0 кандидатов.**
  Проверь `ALCB_SITE_ADAPTER.codeBlockSelector` для текущего сайта.
- **Native messaging error.**
  Проверь `host/index.js` (`node --check`, ручной запуск),
  путь в native-manifest и `allowed_origins` (ID расширения).

Полезные точки в `content.js`: `parseAlcbV2Text`,
`collectAlcbV2CodeBlocks`, `baselineAlcbV2Blocks`, `scanAlcbV2Blocks`,
`enqueueAutoExecution`.

---

## 5. Тесты парсера

~~~sh
cd ~/mmcp/anton-local-command-unified/extension/tests
./run-tests.sh
~~~

Тест берёт `parseAlcbV2Text` прямо из `content.js` (без сборки,
без зависимостей) и проверяет оба синтаксиса (`ALCB/2` и `#ALCB/2`),
streaming-состояние, id mismatch, пустой payload и прочее.
Ненулевой exit code означает регресс.

Текущий статус: **15 passed, 0 failed**.

---

## 6. Версии

| Компонент | Версия |
|---|---|
| `manifest.json` | `3.1.5` |
| `content.js` (`ALCB_VERSION`) | `3.1.5` |
| `host/package.json` | `3.1.5` |

---

## 7. Важно: stdout хоста — это протокол

`host/index.js` общается с Chrome через Native Messaging framing:
4-байтовая little-endian длина + JSON. **Любая запись в stdout**,
кроме этого фрейминга, ломает протокол, и Chrome отвечает:

~~~text
Native messaging error: Error when communicating with the native messaging host.
~~~

Правила:

- В хосте **нельзя** использовать `console.log` / `console.info` /
  `process.stdout.write` для логов.
- Для логов — только `console.error` / `process.stderr.write`.
- В `background.js` это не критично, но для единообразия тоже `console.error`.

Проверка: `node host/index.js </dev/null` — stdout должен быть пустым,
баннер версии — в stderr.
