# nervegraph

> Obsidian Graph View, но для исходного кода.
> Одна команда сканирует проект, вторая открывает интерактивную карту связей в браузере.

```bash
npx nervegraph scan     # → .nervegraph/graph.json
npx nervegraph view     # → http://localhost:4210
```

**Первая цель — Shopify-темы.** Потом JS/TS-проекты.

---

## Зачем

Открыть чужую тему на 60 000 строк и за 10 секунд понять её архитектуру.
Перед удалением файла увидеть, кто его использует. Перед правкой сниппета —
что сломается.

Побочный, но важный эффект: `graph.json` — машиночитаемый файл, поэтому
AI-агент (Claude Code, Cursor) читает карту вместо того, чтобы грепать весь репозиторий.

---

## Документы ТЗ

| # | Файл | О чём |
|---|------|-------|
| 01 | [docs/01-vision.md](docs/01-vision.md) | Проблема, пользователи, границы продукта, что НЕ делаем |
| 02 | [docs/02-cli.md](docs/02-cli.md) | Команды, флаги, конфиг, вывод, коды выхода |
| 03 | [docs/03-graph-schema.md](docs/03-graph-schema.md) | **Контракт `graph.json`** — центральный документ |
| 04 | [docs/04-scanners.md](docs/04-scanners.md) | Правила разбора Liquid / JSON / JS / CSS, резолвинг путей |
| 05 | [docs/05-viewer.md](docs/05-viewer.md) | UI графа: взаимодействие, режимы, панель детали |
| 06 | [docs/06-architecture.md](docs/06-architecture.md) | Структура репо, зависимости, производительность, тесты |
| 07 | [docs/07-agent-api.md](docs/07-agent-api.md) | `query`, формат для AI-агентов, интеграция с Claude Code |
| 08 | [docs/08-roadmap.md](docs/08-roadmap.md) | v0.1 → v0.5, что входит в MVP, что осознанно отложено |

---

## Ключевые решения (зафиксированы)

| Вопрос | Решение | Почему |
|--------|---------|--------|
| Имя пакета | `nervegraph`, бинарь `nerve` | Проверить на npm перед публикацией |
| Runtime | Node ≥ 20, TypeScript, ESM | LTS |
| Парсер аргументов | `node:util` → `parseArgs` | Stdlib, commander не нужен |
| HTTP-сервер | `node:http` | 3 статических файла, express не нужен |
| Liquid | Регулярки по тегам, не полный AST | Теги ссылок тривиально регулярны |
| JS | `es-module-lexer` + регулярка на `require` | Babel-AST — оверкилл для v0.1 |
| CSS | `postcss` | Корректно достаёт `@import` и селекторы |
| Визуализация | `force-graph` (vasturiano), canvas | Из коробки: drag, zoom, highlight, 5k+ узлов |
| Фронтенд-фреймворк | Нет. Vanilla JS + один HTML | Панель детали — это 150 строк DOM |
| Хранилище | Один `graph.json` | SQLite при 100k+ узлов, не раньше |

Обоснование каждого — в [docs/06-architecture.md](docs/06-architecture.md).
