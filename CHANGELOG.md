# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - Initial Beta

### Added

- **Core Engine**: Automated AI agent assistant for Antigravity IDE.
- **Feature**: Auto Retry capability to automatically resume operations upon agent failure or limits.
- **Feature**: Auto Accept functionality handling file edits, terminal execution, and VS Code permission dialogues.
- **Feature**: Smart Model Rotation fallback mechanism handling rate limits and quota exhaustion across configured models.
- **Security**: Dangerous command blocking mechanism protecting against destructive commands (e.g., `rm -rf`, `mkfs`) via bounded regex matching.
- **Architecture**: Scalable multi-session Chrome DevTools Protocol (CDP) client managing multiple agent webviews concurrently.
- **Architecture**: Event-driven `MutationObserver` button detection inside webviews replacing slow periodic polling.
- Bilingual (English/Chinese) support for GitHub Issue templates (Bug Report & Feature Request).
- Development environment prerequisites and setup guidelines to both `README.md` and `README.zh-CN.md`.

### Changed

- **Architecture**: Refactored `domMonitor.ts` by decoupling and extracting browser-injected script functions to a dedicated `injectedScripts.ts` file, significantly improving modularity.
- **CI/CD**: Upgraded GitHub Actions workflows (`test.yml`, `publish.yml`) to use Node.js v22 and updated GitHub action runners (`checkout@v5`, `setup-node@v6`).
- **Code Quality**: Migrated to ESLint v9 (Flat Config format) and enforced strict typing rules across the codebase.
- **Developer Experience**: Integrated `husky` and `lint-staged` to guarantee Prettier formatting and ESLint auto-fixing automatically during the `pre-commit` phase.

### Fixed

- Eliminated all residual ESLint warnings (`@typescript-eslint/no-explicit-any` and `@typescript-eslint/no-unused-vars`) in both source code and testing suites, achieving a zero-warning baseline.
- Fixed `TS2345` type mismatch compilation errors related to `http.IncomingMessage` in `cdpClient.ts`.
- Resolved missing ESLint dependencies (`@eslint/js`, `typescript-eslint`) that previously blocked CI/CD pipelines.
