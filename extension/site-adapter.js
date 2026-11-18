(() => {
  'use strict';

  const host = location.hostname.toLowerCase();

  const adapters = {
    grok: {
      id: 'grok',

      matches() {
        return (
          host === 'x.com' &&
          location.pathname.startsWith('/i/grok')
        );
      },

      composerSelectors: [
        '[contenteditable="true"][aria-label="Ask Grok (AI agent)"]',
        '[contenteditable="true"][aria-label*="Ask Grok"]',
        '[contenteditable="true"]'
      ],

      codeBlockSelector: 'pre, code',

      assistantScope(node) {
        if (!node) return null;

        let current =
          node.nodeType === Node.ELEMENT_NODE
            ? node
            : node.parentElement;

        /*
         * X obfuscates CSS class names, so identify an assistant
         * message semantically by the controls rendered with a
         * Grok response.
         *
         * User messages instead contain "Edit message".
         */
        for (let depth = 0;
             current && depth < 14;
             depth++, current = current.parentElement) {

          const hasAssistantControls =
            current.querySelector?.(
              'button[aria-label="Good response"],' +
              'button[aria-label="Bad response"],' +
              'button[aria-label="Regenerate"]'
            );

          if (!hasAssistantControls) {
            continue;
          }

          const hasUserEdit =
            current.querySelector?.(
              'button[aria-label="Edit message"]'
            );

          /*
           * Avoid climbing all the way to a conversation-level
           * container containing both user and assistant controls.
           */
          if (hasUserEdit) {
            continue;
          }

          return current;
        }

        return null;
      }
    },

    chatgpt: {
      id: 'chatgpt',

      matches() {
        return host === 'chatgpt.com';
      },

      composerSelectors: [
        'textarea[data-testid="prompt-textarea"]',
        'textarea',
        '[contenteditable="true"][data-testid="prompt-textarea"]',
        'div[contenteditable="true"]',
        '.ProseMirror'
      ],

      codeBlockSelector:
        '[data-markdown-copy="code-block"], pre',

      assistantScope(node) {
        if (!node?.closest) return null;

        return (
          node.closest(
            '[data-markdown-text-style="assistant-message"]'
          ) ||
          node.closest(
            '[data-message-author-role="assistant"]'
          )
        );
      }
    },

    google: {
      id: 'google',

      matches() {
        return (
          host === 'www.google.com' ||
          host === 'google.com'
        );
      },

      composerSelectors: [
        'textarea.ITIRGe[aria-label="Задайте вопрос"]',
        'textarea.ITIRGe',
        'textarea[aria-label="Задайте вопрос"]',
        'textarea'
      ],

      codeBlockSelector:
        '.aiModeUiCodeBlock__Container[data-complete="true"] pre',

      assistantScope(node) {
        if (!node?.closest) return null;

        return node.closest(
          '.aiModeUiCodeBlock__Container[data-complete="true"]'
        );
      }
    },

    deepseek: {
      id: 'deepseek',

      matches() {
        return host === 'chat.deepseek.com';
      },

      composerSelectors: [
        'textarea[placeholder="Сообщение для DeepSeek"]',
        'textarea[name="search"]',
        'textarea.ds-scroll-area',
        'textarea'
      ],

      codeBlockSelector:
        '.md-code-block pre',

      assistantScope(node) {
        if (!node?.closest) return null;

        const assistantMessage = node.closest(
          '.ds-assistant-message-main-content'
        );

        if (!assistantMessage) return null;

        return assistantMessage;
      }
    },

    gigachat: {
      id: 'gigachat',

      matches() {
        return host === 'giga.chat';
      },

      composerSelectors: [
        'textarea#chat-input-textarea',
        'textarea[aria-label="Сообщение"]',
        'textarea[placeholder="Спросите ГигаЧат"]',
        'textarea'
      ],

      codeBlockSelector:
        'div[class*="CodeBlock-styled__Container"] pre',

      assistantScope(node) {
        if (!node?.closest) return null;

        const codeBlock = node.closest(
          'div[class*="CodeBlock-styled__Container"]'
        );

        if (!codeBlock) return null;

        return codeBlock.closest(
          '[class*="MessageItem-styled__AssistantRow"]'
        );
      }
    }
  };

  const adapter =
    Object.values(adapters).find((item) => item.matches()) ||
    null;

  globalThis.ALCB_SITE_ADAPTER = adapter;

  console.info(
    '[ALCB] site adapter:',
    adapter?.id || 'unsupported',
    location.hostname
  );
})();
