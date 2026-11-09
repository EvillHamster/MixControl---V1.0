# MixControl: запуск, рабочий сервер и GitHub

Инструкция для текущего проекта. Рабочая папка Windows: `E:\Проекты\MixControl-2026-11-09-v2`.
Приложению нужны Node.js 24 и постоянная PostgreSQL либо Docker Compose. Обычный статический хостинг, GitHub Pages и хостинг только PHP для этого приложения не подходят.

## 1. Ежедневный запуск в VS Code на Windows

Откройте именно папку проекта. В терминале PowerShell:

```powershell
Set-Location -LiteralPath 'E:\Проекты\MixControl-2026-11-09-v2'
npm ci
npm run dev
```

`npm ci` нужен при первой установке и после изменения зависимостей; каждый день достаточно `npm run dev`.
Откройте http://127.0.0.1:5173. Команда запускает постоянную локальную PostgreSQL в `.postgres`, API и Vite. Если настроена внешняя БД, подключается к ней. Остановка — Ctrl+C; данные остаются.

Никогда не удаляйте `.postgres`, пытаясь исправить ошибку запуска. Это рабочие данные, если используется встроенная PostgreSQL.
`ECONNREFUSED 5432` означает, что PostgreSQL недоступна; `ECONNREFUSED 3001` часто является следствием незапущенного API. Проверьте `.env`, запуск БД, занятые порты, журналы терминала.

## 2. Все команды проекта

| Команда                    | Назначение                                                               |
| -------------------------- | ------------------------------------------------------------------------ |
| `npm ci`                   | Установить зависимости строго из package-lock.json                       |
| `npm run dev`              | Разработка: локальная БД + API + Vite                                    |
| `npm run build`            | Проверка TypeScript и сборка интерфейса                                  |
| `npm start`                | API и собранный интерфейс на порту 3001; PostgreSQL должна работать      |
| `npm run db:local`         | Отдельно запустить локальную PostgreSQL                                  |
| `npm run db:migrate`       | Обновить схему БД; при старте API это происходит автоматически           |
| `npm test`                 | Модульные тесты                                                          |
| `npm run test:integration` | Интеграционные тесты в отдельной PostgreSQL-базе; рабочая БД не меняется |

Запуск сборки на локальном ПК, если PostgreSQL не запущена: в первом терминале `npm run db:local`, во втором — `npm run build`, затем `npm start`. Адрес сборки http://127.0.0.1:3001.
Если PostgreSQL уже работает как служба, дополнительный `db:local` не нужен.

## 3. Что уточнить у ИТ перед размещением

Передайте ИТ этот файл и проект. Нужны: сервер Linux с Docker Compose либо Windows с Node.js/PostgreSQL; постоянный диск для БД; внутреннее DNS-имя, например mixcontrol.company.example; HTTPS-сертификат; доступ сотрудников по локальной сети/VPN; резервное копирование и учётная запись для обслуживания. Уточните, разрешён ли GitHub или нужен корпоративный GitHub Enterprise.

Сотрудники открывают один общий адрес в браузере. Устанавливать Node.js или PostgreSQL на каждый рабочий ПК не нужно. Сервер должен оставаться включённым.
Первую настройку KEYUSER выполняйте до открытия доступа остальным сотрудникам. Существующие пользователи переносятся вместе с БД.

## 4. Рекомендуемый вариант: Linux + Docker Compose

Docker Engine и Compose должны быть установлены ИТ по официальной инструкции для ОС сервера.
На сервере клонируйте закрытый репозиторий или скопируйте исходники без `node_modules`, `.postgres`, `.env`. Базу переносите отдельно по разделу 7.

```bash
git clone https://github.com/OWNER/REPOSITORY.git mixcontrol
cd mixcontrol
cp deploy/production.env.example .env
openssl rand -hex 24
nano .env
```

Вставьте полученный случайный пароль в POSTGRES_PASSWORD. В `.env` должны быть:

```dotenv
POSTGRES_PASSWORD=YOUR_48_HEX_CHARACTERS
COOKIE_SECURE=true
TRUST_PROXY=1
```

Не используйте текст примера в качестве пароля. Пароль БД не является паролем входа сотрудника.

```bash
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 app
curl http://127.0.0.1:3001/api/health
```

Успешная проверка возвращает `{"status":"ok"}`. Compose создаёт PostgreSQL в постоянном томе postgres_data; порт БД наружу не публикуется. API доступен только локально на сервере, через 127.0.0.1:3001.

### HTTPS и общий адрес

Попросите ИТ направить DNS-имя на сервер и настроить Nginx по примеру [deploy/nginx.conf.example](deploy/nginx.conf.example). Замените DNS-имя и пути сертификата; пример рассчитан на Nginx на том же сервере, вне Docker.
После установки конфигурации:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Открывать сотрудникам нужно `https://ВАШЕ-ВНУТРЕННЕЕ-ИМЯ/`. В Nginx сохранены Host и настройки SSE, чтобы таблицы и счётчики обновлялись без перезагрузки.
TRUST_PROXY=1 задавайте только за одним доверенным прокси; прямой внешний доступ к порту 3001 в этом варианте закрыт. COOKIE_SECURE=true требует HTTPS. Для первичной локальной проверки без HTTPS можно временно поставить false, но рабочий адрес настраивайте с HTTPS.

### Управление и обновление

```bash
# Статус и журналы
docker compose ps
docker compose logs -f --tail=100 app

# Перезапуск приложения
docker compose restart app

# Обновление кода: сначала сделайте резервную копию по разделу 6
git pull --ff-only
docker compose build app
docker compose up -d --no-deps app
docker compose logs --tail=100 app

# Остановка и запуск без удаления данных
docker compose stop
docker compose start
```

НЕ выполняйте `docker compose down -v`: ключ -v удаляет постоянный том БД.
Миграции применяются автоматически при запуске API. Перед обновлением сохраняйте БД; откат образа сам по себе не отменяет миграции.

## 5. Альтернатива: Windows-сервер без Docker

ИТ устанавливает Node.js 24, Git и PostgreSQL как автоматически запускаемую службу. Создаёт отдельную БД mixcontrol и отдельного пользователя PostgreSQL. Значения ниже замените своими.

```powershell
Set-Location -LiteralPath 'E:\Проекты\MixControl-2026-11-09-v2'
npm ci
Copy-Item .env.example .env
notepad .env
```

Copy-Item нужен только при отсутствии `.env`; не перезаписывайте существующий файл.
В `.env` укажите реальную БД:

```dotenv
DATABASE_URL=postgresql://mixcontrol:URL_ENCODED_PASSWORD@127.0.0.1:5432/mixcontrol
HOST=127.0.0.1
PORT=3001
COOKIE_SECURE=true
TRUST_PROXY=1
```

Спецсимволы пароля в URL должны быть URL-кодированы. За HTTPS-прокси на том же сервере:

```powershell
npm run build
npm start
```

ИТ настраивает доверенный HTTPS reverse proxy (например IIS с ARR либо Nginx), сохраняющий Host, передающий X-Forwarded-Proto и поддерживающий SSE без буферизации. Для постоянной эксплуатации оформляет Node-процесс как службу или задание, запускающее `npm start` в папке проекта и перезапускающее его после сбоя. Открытое окно VS Code для работы сотрудников не требуется.

Для первичной проверки с другого ПК в закрытой локальной сети можно указать HOST=0.0.0.0, COOKIE_SECURE=false и открывать http://IP-СЕРВЕРА:3001. ИТ должна ограничить порт доверенной подсетью. Это промежуточный вариант до настройки HTTPS; порт PostgreSQL 5432 сотрудникам не открывайте.

Обновление Windows: резервная копия → остановить службу приложения → `git pull --ff-only` → `npm ci` → `npm run build` → запустить службу → проверить /api/health.

## 6. Резервная копия и восстановление Docker

Выполняйте из папки Compose. Используйте PostgreSQL custom dump: он сохраняет таблицы, пользователей приложения, хеши паролей, измерения, аудит и схему.
Пример не перезаписывает существующий локальный файл: используйте уникальное имя с датой.

```bash
docker compose exec -T db pg_dump -U mixcontrol -d mixcontrol -Fc -f /tmp/mixcontrol-backup.dump
docker compose cp db:/tmp/mixcontrol-backup.dump ./backups/mixcontrol-YYYY-MM-DD-HHMM.dump
```

Перед копированием создайте каталог backups (`mkdir -p backups` в Linux, `New-Item -ItemType Directory -Force backups` в PowerShell). Копируйте резервные файлы на отдельный защищённый диск и регулярно проверяйте восстановление. Не отправляйте их в GitHub.

Проверка восстановления в ОТДЕЛЬНУЮ пустую базу, без изменения рабочей:

```bash
docker compose cp ./backups/mixcontrol-YYYY-MM-DD-HHMM.dump db:/tmp/restore.dump
docker compose exec -T db createdb -U mixcontrol mixcontrol_restore_check
docker compose exec -T db pg_restore -U mixcontrol -d mixcontrol_restore_check --no-owner --no-privileges --exit-on-error /tmp/restore.dump
docker compose exec -T db psql -U mixcontrol -d mixcontrol_restore_check -c "SELECT count(*) FROM measurements;"
```

Рабочее восстановление делает ИТ на остановленном приложении в пустую целевую БД после сохранения текущей копии. Не запускайте команды удаления рабочей БД наугад. `pg_restore` должен быть совместим с версией `pg_dump`.

## 7. Перенос текущих данных с Windows на сервер

GitHub переносит исходники, но не БД. Не копируйте живую папку `.postgres` между машинами.

Для переносимого снимка приложения в PowerShell:

```powershell
Set-Location -LiteralPath 'E:\Проекты\MixControl-2026-11-09-v2'
New-Item -ItemType Directory -Force backups
node scripts/database-snapshot.mjs export backups/transfer-YYYY-MM-DD-HHMM.json
```

PostgreSQL должна работать. На время окончательного снимка остановите ввод сотрудников, чтобы после копии не появились новые записи. JSON содержит персональные данные и хеши паролей: передавайте по защищённому каналу.

На целевом сервере восстановление разрешено только в ПУСТУЮ базу:

- сначала примените миграции `npm run db:migrate` с целевым DATABASE_URL;
- затем `node scripts/database-snapshot.mjs restore ПУТЬ-К-СНИМКУ.json`;
- не создавайте до восстановления первый KEYUSER — он переносится из снимка;
- войдите с прежним логином после восстановления.

В Docker API сам применяет миграции. Восстанавливайте до открытия адреса сотрудникам:

```bash
docker compose stop app
docker compose run --rm --no-deps -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/backups:/app/backups:ro" app node scripts/database-snapshot.mjs restore /app/backups/transfer-YYYY-MM-DD-HHMM.json
docker compose start app
```

Этот bash-пример для Linux. Каталог scripts и резервная копия примонтированы только для чтения; данные записываются в PostgreSQL. Для первой установки схемы перед этим один раз запустите приложение `docker compose up --build -d`, затем остановите app, не проходя первоначальную регистрацию.
Сессии не переносятся; сотрудники войдут заново. Снимки прежних схем поддерживаются, осиротевшие производные данные не восстанавливаются.

## 8. Загрузка проекта в GitHub

Создайте на GitHub ПУСТОЙ PRIVATE-репозиторий; не добавляйте через сайт README, .gitignore или лицензию, если они уже есть локально. При корпоративном GitHub используйте его адрес вместо github.com.
Установите Git. Настройте имя и рабочую почту (в примере замените значения):

```powershell
git config --global user.name "Ваше имя"
git config --global user.email "you@company.example"
Set-Location -LiteralPath 'E:\Проекты\MixControl-2026-11-09-v2'
git init -b main
git add .
git status
git diff --cached --stat
```

Перед коммитом убедитесь, что среди добавляемых файлов НЕТ `.env`, `.postgres`, backups, дампов, рабочих JSON-копий, паролей и node_modules. Исходные SQL-миграции server/migrations должны попасть в Git.
В проекте уже есть .gitignore. Если секрет ранее закоммичен, добавление в .gitignore не удаляет его из истории: отзовите/смените секрет и очистите историю до публикации.

```powershell
git commit -m "Initial MixControl project"
git remote add origin https://github.com/OWNER/REPOSITORY.git
git remote -v
git push -u origin main
```

OWNER/REPOSITORY замените вашим адресом. Git предложит вход через браузер/менеджер учётных данных. Не вписывайте токен в URL репозитория или файлы проекта. Если origin уже существует, проверьте его через `git remote -v`, а не добавляйте второй.
Если папка уже была Git-репозиторием, повторный `git init -b main` не нужен.

Проверить, что секреты не отслеживаются:

```powershell
git ls-files .env .postgres backups node_modules
```

Вывод должен быть пустым. Само создание PRIVATE-репозитория не заменяет корпоративное разрешение на хранение исходников вне организации.

## 9. Дальнейшая работа через GitHub и Codex

На новом ПК:

```powershell
git clone https://github.com/OWNER/REPOSITORY.git
Set-Location REPOSITORY
npm ci
Copy-Item .env.example .env
npm run dev
```

Это новая локальная БД. Чтобы работать с общими рабочими данными, настройте разрешённое подключение к серверу или используйте веб-приложение; не открывайте БД в интернет.
Откройте клонированную папку в Codex/VS Code и сообщите адрес репозитория и нужную ветку. Для изменений можно использовать:

```powershell
git pull --ff-only
git switch -c codex/описание-доработки
# После доработки и проверок:
npm run build
npm test
# При работающей PostgreSQL:
npm run test:integration
git status
git diff
git add src server shared tests package.json package-lock.json README.md
git commit -m "Describe the change"
git push -u origin HEAD
```

Добавляйте только действительно изменённые нужные файлы; список git add — пример, новые docs/deploy файлы добавляйте отдельно. Затем создайте Pull Request на сайте GitHub, проверьте и объедините его.
Codex сможет работать в открытом локальном клоне; отправка изменений потребует настроенного Git-доступа. Ссылка на репозиторий сама по себе не предоставляет доступ к закрытым исходникам.
Не публикуйте токены в чате. Репозиторий не размещён мной автоматически: для этого нужны ваш репозиторий и настроенная авторизация. Обновление рабочего сервера выполняется отдельно по разделам 4–5.

Официальные справочники: [Docker Compose в production](https://docs.docker.com/compose/how-tos/production/), [публикация существующего проекта в GitHub](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github).
