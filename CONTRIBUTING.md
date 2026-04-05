# Contributing to CCBuddy

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Prerequisites: Bun >= 1.3, Claude Code CLI
bun install
cp .env.example .env
# Edit .env with your Feishu App credentials

bun run dev  # Start with hot reload
```

## Code Style

- **Linter**: Biome (`bun run lint`)
- **Type Check**: TypeScript strict mode (`bun run typecheck`)
- **No Prettier** — Biome handles formatting

## Testing

```bash
bun test              # Run all tests
bun run test:watch    # Watch mode
bun run test:ci       # CI mode (no watch)
```

Tests are organized in three layers:
- `tests/unit/` — Pure function and module tests
- `tests/integration/` — Cross-module interaction tests
- `tests/e2e/` — Full server tests

## Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add multi-platform channel support
fix: resolve WebSocket reconnection timeout
docs: update architecture diagram
test: add StreamingCard fallback tests
refactor: extract message parser into module
```

## Pull Request Process

1. Fork the repo and create a feature branch
2. Make your changes with tests
3. Run `bun test` and `bun run typecheck` — all must pass
4. Submit a PR with a clear description

## Project Structure

```
src/           9 core modules (~1.6K LOC)
tests/         11 test files (169 tests)
web/           React dashboard (optional)
data/          Runtime data (gitignored)
```

## Questions?

Open an issue or start a discussion.
