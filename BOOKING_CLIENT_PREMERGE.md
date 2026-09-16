# Booking client history — состояние перед preview и merge

Ветка: `codex/booking-client-history-backfill`. Этот документ фиксирует границу между уже безопасно проверенной подготовкой и действиями, которые меняют Firebase-проект.

## Уже проверено локально

- 73 обычных теста Functions проходят.
- 2 поведенческих теста Firestore Rules проходят в Firestore Emulator.
- Связанный тест Auth + Firestore + Functions проходит на Node 22.23.2.
- В тесте участвуют две вымышленные менеджерские роли, один staff и анонимный online-booking клиент.
- Проверены точный поиск по телефону, ограниченная история, запрет staff, новая ручная запись, online request, повторный request и Confirm.
- Телефон отсутствует в публичном appointment и остаётся в закрытых коллекциях.
- Повторный исторический перенос сохраняет прежние случайные `clientId`/`clientProfileId` и не дублирует историю.
- Старый appointment без телефона остаётся доступным и не изменяется.
- `npm audit --omit=dev`: 0 critical, 0 high, 8 moderate. Оставшиеся замечания находятся в Firebase Admin / Google Cloud цепочке и требуют отдельной миграции Firebase Admin 14.

Все интеграционные данные синтетические. Реальные appointments, Rules, Functions, Auth-пользователи и Hosting не изменялись.

## Что может показать Hosting preview

Из `salon-calendar` можно подготовить только online-booking frontend target:

`firebase hosting:channel:deploy booking-client-history --only booking`

Preview URL публичный и обращается к настоящим ресурсам Firebase-проекта. Поэтому до публикации совместимого backend на preview разрешена только визуальная проверка страницы; создавать настоящую booking request через preview нельзя. Preview не проверяет новые Rules, приватные коллекции или новую Functions-логику.

## Что ещё обязательно до merge в main

1. Получить самый свежий `main` и перенести в него только booking/client-history изменения, не накрывая более новый календарь старыми HTML-файлами.
2. Повторить все локальные тесты на объединённом варианте.
3. Проверить browser frontend с локальными эмуляторами либо в отдельном Firebase test project. Нужна проверка как новой, так и уже открытой старой страницы.
4. Создать и сохранить production-секрет `CLIENT_LOOKUP_PEPPER`. Синтетическое значение из emulator-файла использовать нельзя.
5. Повторить read-only dry-run непосредственно перед включением и сверить новые количества.
6. Отдельно согласовать единое окно публикации совместимых frontend, Rules и Functions.
7. После отдельного разрешения выполнить перенос сначала с малым `--limit`, проверить публичный/private/history документы и только затем продолжить.
8. После включения проверить настоящие manager/staff роли, online booking, Anyone, Confirm, Decline, Cancel, No-show, архив и legacy appointment без телефона.

## Действия, которые этим коммитом не разрешаются

- merge в `main`;
- deploy Firestore Rules или Functions;
- реальный `--apply` исторического переноса;
- создание настоящих appointments;
- production Hosting deploy.
