# Voidly

<div align="center">
  <img
    src="./src/vs/workbench/browser/parts/editor/media/slice_of_void.png"
    alt="Voidly"
    width="180"
    height="180"
  />

  <h3>An AI-powered code editor built around your workflow.</h3>

  <p>
    Understand your codebase · Work with AI agents · Review every change
  </p>

  <p>
    <a href="https://github.com/Zevino/void/releases">Downloads</a>
    ·
    <a href="https://github.com/Zevino/void/issues">Report an issue</a>
    ·
    <a href="https://github.com/Zevino/void/blob/main/VOID_CODEBASE_GUIDE.md">Codebase guide</a>
  </p>

  <p>
    <img alt="Build" src="https://github.com/Zevino/void/actions/workflows/release.yml/badge.svg" />
    <img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" />
    <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20x64-informational" />
  </p>
</div>

---

**Voidly** is an independently maintained AI code editor by **Zevino**, built on the open-source [Void](https://github.com/voideditor/void) project and the [VS Code / Code-OSS](https://github.com/microsoft/vscode) codebase.

It brings AI assistance into the editor instead of making you switch between your IDE and a chat window. Use models to explore a codebase, reason about implementation, generate edits, and review the resulting changes before accepting them.

> This repository is an independent distribution. It is not affiliated with or endorsed by Microsoft or the original Void maintainers.

## What you can do with Voidly

### AI-assisted development

- **Chat with your codebase** — ask questions, investigate unfamiliar code, and work through implementation decisions.
- **Agent workflows** — let an AI agent work through coding tasks with access to supported tools.
- **Inline completions** — get AI-generated suggestions while writing code.
- **Edit in context** — use the editor's Ctrl+K workflow to request targeted changes.
- **Apply and review** — inspect generated edits with inline diffs before keeping them.

### Choose your models

Voidly integrates with multiple model providers and supports local model workflows. Provider and model availability depends on your configuration.

The source currently includes integrations for:

- OpenAI
- Anthropic
- Google
- Mistral
- Ollama
- Other compatible providers and local endpoints supported by the codebase

You can configure the provider and model used by supported AI features in the editor.

### Keep control of your changes

AI-generated code should be reviewable. Voidly uses editor-native change tracking and diff views so you can inspect what changed and decide what to keep.

## Downloads

**Windows x64 builds** are published through GitHub Releases.

<a href="https://github.com/Zevino/void/releases/latest">
  <img alt="Download latest Voidly release" src="https://img.shields.io/badge/Download-Latest%20Windows%20Build-5865F2?style=for-the-badge" />
</a>

Each automated Windows release is intended to provide:

| Package | Description |
| --- | --- |
| `VoidlySetup-x64-*.exe` | Windows installer |
| `Voidly-win32-x64.zip` | Portable ZIP package |

For development builds, check the latest [GitHub Actions run](https://github.com/Zevino/void/actions/workflows/release.yml). A push to `main` triggers the Windows x64 build and publishes its output as a GitHub Release.

> The current automated release workflow targets **Windows x64**. Do not assume that other platform installers are published unless they appear in Releases.

## Getting started

1. Open [GitHub Releases](https://github.com/Zevino/void/releases).
2. Download the installer or portable ZIP for Windows x64.
3. Launch Voidly and configure an AI provider and model in the application settings.
4. Open a project and start using chat, agent workflows, or inline assistance.

You will generally need your own provider credentials for hosted models. Local model setups, such as Ollama, require the corresponding local service to be installed and running.

## Development

Voidly is built on a large TypeScript/Electron codebase with a React-based UI subproject and Gulp build tooling.

### Prerequisites

- Git
- Node.js **20.18.2** (see `.nvmrc`)
- npm
- Python 3.11 for the current Windows CI build
- On Windows, Visual Studio 2022 or Build Tools with the C++ workload and Windows SDK for native dependencies

### Run the development version

Clone this repository:

```bash
git clone https://github.com/Zevino/void.git
cd void
```

Install dependencies and build the React UI:

```bash
npm ci
npm run buildreact
```

Start the development build tasks:

```bash
npm run watch
```

Then launch the development version:

- **Windows:** `./scripts/code.bat`
- **macOS / Linux:** `./scripts/code.sh`

For the full setup, platform prerequisites, troubleshooting notes, and local build instructions, see **[HOW_TO_CONTRIBUTE.md](./HOW_TO_CONTRIBUTE.md)**.

### Build Windows x64

The repository's automated release workflow performs the Windows x64 packaging steps:

1. Install dependencies.
2. Build the React products.
3. Download the Electron runtime.
4. Package the Windows x64 application.
5. Build the Inno Setup updater and installer.
6. Publish the installer and portable ZIP to GitHub Releases.

The workflow configuration is in [`.github/workflows/release.yml`](./.github/workflows/release.yml).

## Project structure

Most Voidly-specific work lives under:

```text
src/vs/workbench/contrib/void/
```

The application follows the VS Code workbench architecture:

- `browser/` — renderer-side workbench and UI code
- `common/` — shared services and interfaces
- `electron-main/` — Electron main-process integrations

Useful project documentation:

- [Voidly Codebase Guide](./VOID_CODEBASE_GUIDE.md) — architecture, services, AI message flow, and edit/apply internals.
- [Development & Contribution Guide](./HOW_TO_CONTRIBUTE.md) — prerequisites, developer mode, and build instructions.
- [Issues](https://github.com/Zevino/void/issues) — bug reports and feature requests.

## Privacy and provider data

Voidly is designed to send model requests directly to the provider you configure rather than operate a separate hosted AI service that stores your prompts.

When using a hosted provider, your prompts, code context, and other request data are still subject to that provider's terms, privacy policy, and retention settings. When using a local model, data handling depends on your local runtime and configuration.

Please review the policies of your selected provider before sending sensitive code or information.

## Contributing

Bug reports, reproducible performance issues, and focused improvements are welcome.

1. Check the existing [issues](https://github.com/Zevino/void/issues) before opening a new one.
2. Include reproduction steps, environment details, and relevant logs when reporting a bug.
3. For code changes, create a focused pull request with a clear description and validation notes.

For architecture and setup details, start with the [Codebase Guide](./VOID_CODEBASE_GUIDE.md) and [Development Guide](./HOW_TO_CONTRIBUTE.md).

## Credits

Voidly is independently maintained and distributed by **Zevino**. It builds on the work of the [Void](https://github.com/voideditor/void) and [Visual Studio Code](https://github.com/microsoft/vscode) open-source projects and their contributors.

- Repository: [github.com/Zevino/void](https://github.com/Zevino/void)
- Issues: [github.com/Zevino/void/issues](https://github.com/Zevino/void/issues)
- Releases: [github.com/Zevino/void/releases](https://github.com/Zevino/void/releases)

---

<div align="center">
  <sub>Built independently by Zevino. Powered by open source.</sub>
</div>
