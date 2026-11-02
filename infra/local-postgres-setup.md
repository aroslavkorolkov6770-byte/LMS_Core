# Local PostgreSQL Setup

## Текущий рабочий вариант проекта
Проект использует отдельный локальный кластер PostgreSQL внутри папки проекта:
- data: `C:\Users\KROLL\Desktop\LMS Core\infra\local-postgres\data`
- port: `55432`
- user: `postgres`
- database: `lms_core`
- auth: только для локальной разработки

## Как запускать и останавливать
Старт:
`powershell
.\infra\scripts\start-local-postgres.ps1
`

Стоп:
`powershell
.\infra\scripts\stop-local-postgres.ps1
`

## Локальные команды проекта
Применить схему в базу:
`powershell
.\infra\scripts\run-db-push.ps1
`

Засеять роли:
`powershell
.\infra\scripts\run-db-seed-roles.ps1
`

## Что важно
- `DATABASE_URL` проекта сейчас должен указывать на `postgresql://postgres@127.0.0.1:55432/lms_core`
- Seed ролей запускать после применения схемы.
