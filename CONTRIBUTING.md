# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

## Workflow

1. Ветка от `main`.
2. Изменения + тесты на новую логику (`test/**/*.test.ts`, `node --test`).
3. `npm run build` и `npm test` должны проходить локально — тот же прогон делает CI.
4. PR с коротким описанием, что и зачем.

## Структура

Архитектура и решения по стеку — в [README.md](README.md) и [docs/06-architecture.md](docs/06-architecture.md).
Как добавить новый язык/резолвер — в [EXTENDING.md](EXTENDING.md).

## Коммиты

Обычный формат `type: what` (`fix: ...`, `feat: ...`, `test: ...`) — без строгого enforce, но старайтесь быть последовательными с историей репозитория.
