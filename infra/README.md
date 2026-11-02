# infra

Здесь будет техническая инфраструктура проекта:
- `docker`
- `env examples`
- `scripts`
- `deploy templates`

## Что уже есть
- `.env.example`
- `scripts/install-postgres.ps1`
- `scripts/start-local-postgres.ps1`
- `scripts/stop-local-postgres.ps1`
- `scripts/run-db-push.ps1`
- `scripts/run-db-generate.ps1`
- `scripts/run-db-seed-roles.ps1`
- `scripts/refresh-api-preview.ps1`
- `scripts/control-dev-service.ps1`
- `scripts/start-control-center.ps1`
- `scripts/start-control-center-hidden.vbs`
- `local-postgres-setup.md`

## Дополнительно
- `control-dev-service.ps1` управляет локальными сервисами проекта через единый сценарий `Status | Start | Stop`
- `start-control-center.ps1` собирает и запускает desktop launcher
- `start-control-center-hidden.vbs` нужен для скрытого старта launcher-а без видимого окна PowerShell
