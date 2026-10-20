# Smart Joba

Локальный сайт планирования расписания колледжа по [ТЗ v0.9](docs/spec/v0.9/college_timetable_spec_v0_9_ru.docx). Реализован первый этап: PostgreSQL, вход и выход, подготовленные аккаунты пяти ролей, серверные права по области доступа и казахский интерфейс.

Импорт, календарь, редактор, генератор, утверждение, публикация и экспорт относятся к следующим этапам MVP. В текущем интерфейсе они обозначены как будущие возможности. Регистрация и восстановление пароля остаются во второй очереди.

## Запуск в Windows

Нужны Python 3.12+, Node.js 24.15+ с npm, установленные бинарники PostgreSQL 18 и .NET Framework 4.x из Windows. Сначала откройте PowerShell в папке этого репозитория.

Первичная подготовка требует интернета для установки зависимостей:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run.ps1 setup
```

Обычный запуск после подготовки работает без интернета:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run.ps1 start
```

Откройте **http://127.0.0.1:8000**. Подготовленные логины и случайные пароли находятся только на этом компьютере в **`.local/accounts.txt`**. Это синтетические демоаккаунты, а не сведения колледжа. Роли: `admin`, `scheduler`, `approver`, `teacher`, `student`; пароли для каждой роли разные. При повторном `setup` существующие пароли и назначения сохраняются.

Остановка, состояние и проверки:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run.ps1 status
powershell -ExecutionPolicy Bypass -File .\scripts\run.ps1 test
powershell -ExecutionPolicy Bypass -File .\scripts\run.ps1 stop
```

Скрипт создаёт отдельный кластер в `.local/postgres/data` на `127.0.0.1:55432`, базы `smart_joba` и `smart_joba_test`. Существующие службы и базы PostgreSQL не меняются. Если бинарники установлены в другом месте, задайте `SMART_JOBA_PG_BIN` с путём к их папке `bin`. Порт 8000 занят другим приложением — запуск остановится с сообщением, чужой процесс останется работать.

`setup` использует управляемую локальную `.env`; при несовпадении её адресов БД с настройками проекта миграции и seed останавливаются. Не заменяйте её параметрами рабочей базы колледжа. Журналы диагностики находятся в `.local/`. Не отправляйте `.env`, `.local/`, дампы и файлы с паролями в GitHub.

## Устройство проекта

| Каталог | Назначение |
|---|---|
| `backend/app/domain` | Чистые правила разрешений без HTTP и SQL |
| `backend/app/application` | Вход, сессии, ограничение попыток и аудит |
| `backend/app/infrastructure` | SQLAlchemy, Argon2id, подписи CSRF |
| `backend/app/adapters` | HTTP API, безопасные ошибки, DTO |
| `backend/migrations` | Версионируемая схема PostgreSQL |
| `frontend/src` | React + TypeScript, KK-ресурсы, адаптивные экраны |
| `scripts` | Изолированная локальная подготовка, запуск и остановка |

Пароли хешируются Argon2id. БД хранит хеши непрозрачных серверных сессий; браузер получает HttpOnly/SameSite cookie. Проверки прав выполняются на сервере при каждом закрытом запросе. Администратор не получает автоматического права утверждать и публиковать. HTTP разрешён только для локального запуска; сетевое развёртывание в этот этап не входит.

API и интерфейс обслуживаются одним процессом. Во время разработки отдельно доступны `npm run dev` в `frontend` (порт 5173, прокси `/api` на 8000) и uvicorn; подробности — в [backend/README.md](backend/README.md) и [frontend/README.md](frontend/README.md). Схема API: `/api/openapi.json`, работоспособность БД: `/api/health`.

## Документы и результаты

- [Полное ТЗ v0.9](docs/spec/v0.9/college_timetable_spec_v0_9_ru.docx).
- [Контракт первого этапа](docs/implementation/stage-1-contract.md).
- [Решения по архитектуре](docs/implementation/stage-1-decisions.md).
- [Отчёт испытаний](docs/implementation/stage-1-test-report.md).
- [Карта Must-критериев](docs/spec/v0.9/part-2-acceptance-map.json).
- [Правила для ИИ-агентов](AGENTS.md).

Карта Must — исходное распределение приоритетов ТЗ; текущее состояние фиксируется в отчёте испытаний. Ещё не реализованные модули не считаются принятыми.
