# apps/control-center

Локальная desktop-app для запуска и остановки проекта без ручного терминала.

## Git и удаленная LMS
Первый этап нового мастера уже доступен: по умолчанию «Новая установка клиента», реальный сохраняемый план/автоматический путь и отдельная read-only проверка сервера. Это пока не полная первичная установка: текущий Git не имеет утвержденного NestJS/PostgreSQL адаптера, и интерфейс явно показывает причину блокировки. Инструкция: [new-installation-wizard.md](../../docs/new-installation-wizard.md).

В разделе «Репозиторий» доступны реальные чтение Git по SSH и получение отдельного Git-снимка. Первый SSH-worker обновляет уже существующую JSON/Next.js/npm LMS под одним fork PM2, сохраняя данные/окружение и выполняя backup/health/rollback. Это пока не универсальная первичная установка: основной сценарий автоматического создания нового клиента/каталога/БД/запуска остается в TASKS.md.

Точные поля и порядок теста: [test-server-quick-start.md](../../docs/test-server-quick-start.md). Устройство/ограничения: [remote-update.md](../../docs/remote-update.md). После проверки пароль очищается; следующая операция требует нового ввода. В журнал попадают безопасные коды ошибок, не пароль или сырой SSH stderr.

## Что уже умеет
- запускать и останавливать `PostgreSQL`
- запускать и останавливать `apps/api`
- запускать и останавливать `apps/lms-web`
- запускать и останавливать `apps/deploy-panel`
- показывать статус по портам и PID
- открывать URL сервиса
- открывать лог-файл сервиса
- открывать единый config-файл
- встраивать локальную deploy-панель прямо в правую часть окна
- встраивать локальный LMS runtime и preview клиента
- показывать offline-состояние встроенной панели, если `deploy-panel` не запущена
- запускать `deploy-panel` прямо из offline-блока
- показывать визуальную индикацию нажатия и выполнения действий по сервисам
- вести отдельный лог launcher-а
- автообновлять встроенный лог launcher-а и сервисов
- открывать сервис прямо внутри app через mini-browser
- выбирать клиента для preview из живого списка
- открывать preview клиента в большом режиме просмотра внутри app

## Где настраивается
Главный файл настройки:
- `C:\Users\KROLL\Desktop\LMS Core\apps\control-center\config\launcher-config.json`

Через него можно менять:
- список сервисов
- порты
- URL
- команды запуска
- общие env-переменные
- дефолтный `Client ID` для preview можно менять уже из самого окна app

## Команды
- `pnpm --dir apps/control-center dev`
- `pnpm --dir apps/control-center build`
- `pnpm --dir apps/control-center check`

## Скрипты управления
- `C:\Users\KROLL\Desktop\LMS Core\infra\scripts\control-dev-service.ps1`
- `C:\Users\KROLL\Desktop\LMS Core\infra\scripts\start-control-center.ps1`
- `C:\Users\KROLL\Desktop\LMS Core\infra\scripts\start-control-center-hidden.vbs`

## Как запускать
- основной вариант: ярлык `C:\Users\KROLL\Desktop\LMS Core Control Center.lnk`
- резервный вариант: `powershell -ExecutionPolicy Bypass -File "C:\Users\KROLL\Desktop\LMS Core\infra\scripts\start-control-center.ps1"`

## Важное замечание
- если встроенная deploy-панель стала белой или пустой, сначала нужно проверить, жив ли сервис `deploy-panel`
- в этом проекте белый встроенный экран уже один раз оказался не багом интерфейса, а следствием остановленных локальных сервисов

## Идея архитектуры
Сделано в два слоя:
- PowerShell-слой реально управляет локальными процессами
- Electron-окно только показывает состояние и вызывает эти команды

Такой подход проще всего дорабатывать дальше без переписывания всего launcher-а.
