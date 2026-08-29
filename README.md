# Plyph

Use AI on selected text in Firefox. Correct writing, rewrite text, run a selection as a prompt, or create custom actions. Results can be reviewed and edited before replacing the original selection.

## Features

- **Multiple AI providers** — Ollama, Groq, Cloudflare Workers AI, B.AI, Gemini, OpenRouter, Cerebras, OpenAI, and Vercel AI Gateway
- **Model discovery** — Refresh available models after configuring a provider, while still allowing manual model names
- **Usage guidance** — Provider allowance and model-cost warnings are shown before choosing larger cloud models
- **Built-in actions** — Professional email, summarize, translate, explain simply (customizable)
- **Custom actions** — Create your own prompts with variables and model settings
- **Flexible UI** — Floating action dot on selection, context menu, toolbar button, keyboard shortcuts
- **Review before replace** — Preview and edit AI output before applying
- **User-controlled setup** — Bring your own provider credentials or use a local Ollama server

## Install

<div >
  <a href="https://addons.mozilla.org/firefox/addon/plyph/">
    <img src="https://blog.mozilla.org/addons/files/2020/04/get-the-addon-fx-apr-2020.svg" alt="Get the Add-on" height="60" />
  </a>
  <br>
  <a href="https://addons.mozilla.org/firefox/addon/plyph/">
    <img src="https://img.shields.io/amo/v/plyph?style=flat-square&color=orange" alt="Version" />
    <img src="https://img.shields.io/amo/users/plyph?style=flat-square&color=blue" alt="Users" />
  </a>
</div>

## Usage

1. Open **Plyph Settings** (toolbar button → Settings)
2. Choose a provider and enter its credentials; Cloudflare Workers AI requires an API token and Account ID, while Ollama uses only its server URL
3. Select text on any webpage
4. Click the action dot, use the context menu (Plyph submenu), or press the keyboard shortcut
5. Choose an action → review the result → click **Replace** or **Copy**

Disable the floating dot in **Settings → General → Page controls**. History is disabled by default for privacy; enable **Save history** when you want to review, copy, delete, or clear local results from the popup. **Status feedback** defaults to the bottom center, or can follow the selected text or mouse pointer.

Cloudflare Qwen reasoning is disabled by default to keep short transformations fast and economical. Enable it from the Cloudflare provider settings when a task benefits from additional reasoning. **Preview before replacing** is enabled by default.

## Supported Fields

- Text inputs (`<input>`, `<textarea>`)
- Contenteditable elements
- Most rich-text editors (some complex editors manage their own document model and may not accept replacement)

## Privacy

- Text is sent **only when you explicitly choose an action**
- API keys and provider settings are stored in Firefox extension-local storage on your device; Plyph does not encrypt this storage
- Ollama requests go to your configured server only and do not use an API key
- Firefox requests to local Ollama use a Page Assist-style Origin rewrite, so Ollama's default CORS policy accepts them without changing Firefox or Ollama settings
- No telemetry, no background requests
