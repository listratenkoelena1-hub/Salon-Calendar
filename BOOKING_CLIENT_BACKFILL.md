# Исторический перенос client history — безопасный запуск

Ветка: `codex/booking-client-history-backfill`, отдельно от `main` и Buddha. Скрипт находится в `salon-functions/functions/client-history-backfill-cli.js`; он запускается оператором из терминала, а не из интерфейса календаря. Автоматического переноса при открытии приложения нет.

## Что показал режим без записи

На 15 сентября 2026 в проекте `rosesnails-calendar` read-only режим получил только необходимые поля appointments и сверил число документов независимым Firestore COUNT:

| Показатель | Количество |
|---|---:|
| Все appointments | 5 026 |
| С корректным телефоном, кандидаты | 25 |
| Из них online booking | 23 |
| С телефоном без booking-признака | 2 |
| Без телефона | 5 001 |
| Уникальные нормализованные телефоны | 18 |
| Пары «телефон + точное имя» | 19 |
| Некорректные телефоны / отсутствующие имена / уже новая схема | 0 / 0 / 0 |

Числа могут измениться до запуска, поскольку календарь живой. Имена, телефоны и ID отдельных appointments в отчёт не выводятся. Команда из директории `salon-functions/functions`:

`node client-history-backfill-cli.js --project=rosesnails-calendar --dry-run`

По умолчанию тоже выполняется dry-run. Он требует существующего Firebase CLI login, читает appointments только с маской полей, но делает `writes: 0`. Полное чтение 5 тысяч appointments не выполняется при обычной записи клиента или работе календаря — только во время операторского аудита/переноса.

## Что делает перенос

Для каждого legacy appointment с корректным телефоном и именем одна серверная Firestore-транзакция:

1. Повторно читает appointment и пропускает уже версионированный документ.
2. По HMAC телефона с неизменным секретом `CLIENT_LOOKUP_PEPPER` находит или создаёт один случайный `clientId` на телефон.
3. По точному нормализованному имени находит или создаёт отдельный случайный `clientProfileId` для человека внутри этого телефона. Исторический автоматический перенос не делает нечёткое объединение разных имён: сомнительные связи можно подтверждать позднее вручную.
4. Переносит телефон из публичного appointment в закрытые `appointmentPrivate` и `clientLookup`/`clientPhoneIndex`/`clientProfiles`.
5. Создаёт `clientAppointmentHistory` с исходными статусом, online-booking source, мастером, услугой и фактической/стандартной длительностью.
6. Добавляет в публичный appointment только служебные `privacySchemaVersion: 1` и `hasPrivateContact: true`. Старые поля `phone` и `phoneLookup` удаляются.
7. После транзакции проверяет все три связанные записи. Повторный запуск не создаёт новые ID и не дублирует историю.

Declined online requests сохраняются в истории, но не обучают предпочтениям. Старые записи без телефона не изменяются и по-прежнему открываются через календарь/архив.

Реальный `--apply` имеет несколько обязательных стопоров: подтверждение точного project ID, флаги о заранее проверенных опубликованных Rules и backend, отдельное окружение `BOOKING_BACKFILL_ENABLE_WRITES=YES`, стабильный HMAC-секрет и Admin SDK credentials. Эти флаги не заменяют проверку deployment и отдельное разрешение владельца. Сейчас real apply **не выполнялся**.

## Проверка в эмуляторе

Запуск из корня этой рабочей копии с Java 21 в `PATH`:

`firebase emulators:exec --config firebase.backfill-emulator.json --only firestore --project demo-booking-client-backfill "npm --prefix salon-functions/functions run test:emulator"`

Для связанного теста Auth + Firestore + Functions нужен также Node 22 в `PATH` и локальный `salon-functions/functions/.secret.local` с **только синтетическими** значениями из `salon-functions/functions/emulator-secret-example.txt`. Файл `.secret.local` игнорируется Git и не должен попадать в публикацию:

`firebase emulators:exec --config firebase.backfill-emulator.json --only auth,firestore,functions --project demo-booking-client-backfill "npm --prefix salon-functions/functions run test:integration"`

Эмулятор загружает подготовленный локальный `firestore.rules` и создаёт собственную базу вымышленных appointments. Он не подключает к тесту 5 026 production-записей и не публикует Rules в настоящем Firebase.

Проверены две вымышленные менеджерские учётные записи, staff и анонимный клиент: old phone-free и new public appointments читаются авторизованными пользователями; `appointmentPrivate`, `clientLookup`, `clientPhoneIndex`, `clientProfiles` и `clientAppointmentHistory` запрещены всем браузерным ролям. Серверная транзакция переносит вымышленные online/declined/manual appointments, повторный запуск не дублирует данные, phone-free запись остаётся прежней. Полный тест с Auth и Functions проверяет точный поиск, ограниченную историю, отказ staff, новую ручную запись с телефоном, онлайн-запрос и его подтверждение; исходный online-booking признак и увеличенная длительность сохраняются. Настоящие аккаунты и Hosting в этот локальный тест не подключаются. Прогон успешно повторён на официальной Node 22.23.2, совпадающей с заданной основной версией runtime.

## Условия перед настоящим переносом

1. Проверить новые Rules и backend в полном тестовом окружении; затем отдельно разрешить их publication в проект `rosesnails-calendar`. Hosting preview сам по себе не изолирует Firestore или Functions.
2. Получить новый dry-run, проверить неизвестные случаи и заморозить/сохранить стабильный `CLIENT_LOOKUP_PEPPER`.
3. Опубликовать закрывающие Rules и совместимый приватный backend в согласованном порядке. Пока legacy документы с телефоном остаются публично читаемыми как целый appointment, скрытие одних полей Rules невозможно.
4. Только после отдельного разрешения выполнить `--apply`, желательно малой порцией `--limit`, сверить публичный, приватный и history документ, затем продолжить. Скрипт можно безопасно перезапустить.
5. Проверить настоящие роли и архив старых записей без телефона. `main`, production Hosting, booking requests и реальные appointments до этого этапа не менять.
