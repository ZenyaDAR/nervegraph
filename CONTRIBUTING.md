# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

## Workflow

1. Branch off `main`.
2. Changes + tests for new logic (`test/**/*.test.ts`, `node --test`).
3. `npm run build` and `npm test` must pass locally — CI runs the same check.
4. PR with a short description of what and why.

## Structure

Architecture and stack decisions — in [README.md](README.md).
How to add a new language/resolver — in [EXTENDING.md](EXTENDING.md).

## Commits

Plain `type: what` format (`fix: ...`, `feat: ...`, `test: ...`) — not strictly enforced, but try to stay consistent with the repo's history.
