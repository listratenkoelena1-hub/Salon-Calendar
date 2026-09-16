# Проверка текущего main с новыми Firestore Rules

Дата проверки: 16 сентября 2026 года.

## Что именно проверено

Проверка выполнена не на старой локальной копии, а на точном снимке актуального GitHub `main`:

- commit: `2f3ed8988aedd38bbd13b657a626541660866ce2` — `Merge secure online booking management`;
- `salon-calendar/index.html`: Git blob `82fb15d2f0dbc1f0e08b5d858c6f485d565ddbde`;
- текущие main Rules: Git blob `9ab47f3de5adb683c179a072c76d480ce4eee129`;
- `salon-functions/functions/index.js`: Git blob `c7093977bb02d9d6fef0d9a2269f3db968ee2252`;
- новые client-history Rules: Git blob `64f648332704d89aadf060428c869d34251b3e36`.

Тест `current-main-rules-compat-emulator.test.js` закрепляет эти хеши и завершается ошибкой, если вместо точного снимка подставлен другой файл.

Воспроизводимый запуск использует `firebase.current-main-rules-compat.json`, переменную `CURRENT_MAIN_ROOT` с путём к точному снимку и `CURRENT_MAIN_RULES_ONLY=1`.

## Результат

Точный текущий frontend `main` совместим с новыми Rules в локальных Auth + Firestore Emulator: тест прошёл.

Проверены manager, staff и анонимный online-booking клиент:

- старые appointments с телефоном и без телефона по-прежнему читаются manager и staff;
- браузерная прямая запись appointments запрещена, как и в текущем main;
- календарь продолжает писать appointments через callable `mutateAppointment`;
- `OffWork`, чтение staff и разрешённое изменение staff собственного цвета/длительностей работают;
- правила чтения `users` сохраняются;
- новые приватные коллекции закрыты от всех браузерных ролей;
- анонимный пользователь не читает календарь;
- manager сохраняет доступ к `activityLog`;
- staff может создать техническую строку лога без телефона, но не может читать лог или записывать туда телефон.

Последний пункт — намеренное усиление новых Rules. Это единственное проверенное изменение поведения относительно старых Rules, где любой вошедший пользователь имел полный доступ к `activityLog`.

## Отдельно о Functions

Cloud Functions с Admin SDK выполняют серверные операции в обход Firestore Rules, поэтому проверка Rules сосредоточена на реальных браузерных операциях точного `main`.

Полный запуск старого Functions-файла из точного main в современном локальном runtime остановился на его старом вызове `admin.firestore.FieldValue.serverTimestamp()`. Это существующая несовместимость старого namespace с текущим emulator/runtime, а не отказ новых Rules.

В подготовленной client-history ветке этот legacy-вызов уже заменён на прямые модульные импорты. Полный связанный тест Auth + Firestore + Functions для нового backend прошёл на Node 22.23.2. Поэтому ночное включение должно публиковать совместимые Rules, Functions и frontend как один согласованный выпуск, а не оставлять старые Functions вместе с новой схемой надолго.

## Подготовленный rollback

Сохранены две версии:

1. `firebase-rollbacks/firestore.rules.main-2f3ed898.rules` — точная побайтовая копия Rules текущего main, Git blob `9ab47f3de5adb683c179a072c76d480ce4eee129`.
2. `firebase-rollbacks/firestore.rules.safe-rollback-client-history.rules` — рабочий безопасный rollback, Git blob `980dc24c206eb1bd25afad4cd12013dc213fe5b2`.

Безопасный rollback отдельно прошёл Firestore Emulator. Он восстанавливает прежнее поведение календаря и `activityLog`, но продолжает полностью закрывать `appointmentPrivate`, client lookup/history, контакты online booking и внутренние очереди.

Точную старую копию можно использовать только до первого появления приватных client-history документов. Если новые Functions или миграция уже успели что-либо записать, разрешён только безопасный rollback: старое общее fallback-правило иначе открыло бы новые коллекции вошедшим staff-пользователям.

Публикация rollback — это новый deploy Rules, а не кнопка отмены. Она не удаляет и не отменяет уже записанные данные.

## Что не выполнялось

- `main` не изменялся и не объединялся;
- Firestore Rules, Functions и Hosting в `rosesnails-calendar` не публиковались;
- production не менялся;
- настоящие appointments не создавались, не изменялись и не удалялись;
- исторический перенос не запускался в режиме записи.

## Остаток работ до полного включения

1. Непосредственно перед ночным окном ещё раз получить самый свежий `main`. Если SHA изменился, повторить эту проверку на новом снимке.
2. Перенести client-history изменения в свежий `main` без перезаписи более новых частей календаря и повторить все unit, Rules и связанные emulator-тесты.
3. Повторить production dry-run переноса: только чтение, сверка количества кандидатов, `writes: 0`.
4. Создать и надёжно сохранить постоянный production secret `CLIENT_LOOKUP_PEPPER`.
5. Держать рядом предыдущие Functions/frontend и безопасные rollback Rules.
6. В согласованное тихое окно сначала опубликовать закрывающие Rules, проверить вход manager/staff и чтение старых записей, затем без паузы опубликовать совместимые Functions и frontend.
7. Проверить настоящие роли и основные сценарии: старые записи без client ID, manager/staff, online request, Confirm, Decline, Cancel/No-show и архив. Не создавать тестовые реальные appointments без отдельного разрешения.
8. Только после стабильной проверки выполнить исторический перенос: сначала маленький `--limit`, вручную проверить публичный appointment, private contact и history, затем перенести остаток.

Последний read-only dry-run нашёл 5 026 appointments: 25 кандидатов с корректным телефоном, из них 23 online booking и 2 обычных; 5 001 запись без телефона останется без изменений. Эти числа нужно обновить перед реальным запуском.
