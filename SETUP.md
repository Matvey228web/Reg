# SETUP: настройка бэкенда и деплой Mifs Rent

Этот репозиторий содержит только фронтенд — Telegram Mini App (статические HTML/CSS/JS файлы, без сборки). Хранение данных и бизнес-логика находятся вне репозитория, в no-code сервисах: **Airtable** (база данных) и **Latenode** (вебхуки/API, связывающие приложение с Airtable). Ничего из перечисленного ниже не настраивается кодом — это делается вручную в веб-интерфейсах сервисов по этой инструкции.

Пока Airtable/Latenode не настроены, приложение можно полноценно использовать в демо-режиме — см. раздел «Mock-режим» в README.md.

---

## 1. База данных в Airtable

Создайте базу **"Mifs Rent Warehouse"** с пятью таблицами.

### Equipment (оборудование)
| Поле | Тип | Комментарий |
|---|---|---|
| `item_id` | Single line text (первичное поле) | напр. `MIFS-CAM-014`, уникально, содержимое QR-кода |
| `name` | Single line text | |
| `category` | Single select | `CAM`, `LEN`, `LGT`, `AUD`, `GRP`, `OTH` |
| `serial_number` | Single line text | |
| `status` | Single select | `Available`, `Rented`, `In Repair`, `Retired` |
| `condition_notes` | Long text | |
| `photo` | Attachment | опционально |
| `created_at` | Created time | авто |
| `current_transaction` | Link to Transactions | одна связь, заполняется при выдаче |

### Staff (сотрудники)
| Поле | Тип | Комментарий |
|---|---|---|
| `staff_id` | Autonumber (первичное) | |
| `full_name` | Single line text | |
| `login` | Single line text | уникальный логин |
| `pin_hash` | Single line text | **хэш** PIN-кода, не хранить в открытом виде (см. §4) |
| `telegram_id` | Number | опционально, для сверки с Telegram initData |
| `role` | Single select | `Warehouse Staff`, `Admin` |
| `active` | Checkbox | чтобы отключать сотрудника, не удаляя |
| `session_token` | Single line text | текущий активный токен |
| `token_issued_at` | Date/time | для проверки истечения сессии |

### Clients (клиенты/проекты)
| Поле | Тип |
|---|---|
| `client_id` | Autonumber (первичное) |
| `client_name` | Single line text |
| `project_name` | Single line text |
| `phone` | Single line text |
| `notes` | Long text |
| `created_at` | Created time |

### Transactions (выдачи/приёмы)
| Поле | Тип | Комментарий |
|---|---|---|
| `transaction_id` | Autonumber (первичное) | |
| `item` | Link to Equipment | |
| `client` | Link to Clients | |
| `staff_out` | Link to Staff | кто выдал |
| `staff_in` | Link to Staff | кто принял, пусто до возврата |
| `checked_out_at` | Date/time | |
| `expected_return_at` | Date/time | опционально |
| `checked_in_at` | Date/time | пусто до возврата |
| `status` | Single select | `Open`, `Closed` |
| `notes` | Long text | |

### Defects (дефекты)
| Поле | Тип | Комментарий |
|---|---|---|
| `defect_id` | Autonumber (первичное) | |
| `item` | Link to Equipment | |
| `reported_by` | Link to Staff | |
| `related_transaction` | Link to Transactions | опционально |
| `description` | Long text | |
| `severity` | Single select | `Minor`, `Major`, `Out of Service` |
| `status` | Single select | `Open`, `In Repair`, `Resolved` |
| `reported_at` | Created time | |
| `resolved_at` | Date/time | пусто до решения |
| `resolution_notes` | Long text | |

**Автоматизация в Latenode**: при создании дефекта с `severity = Out of Service` или переводе дефекта в `status = In Repair` — сценарий должен также выставить `Equipment.status = In Repair` у соответствующего предмета. При решении последнего открытого дефекта предмета — вернуть `Equipment.status = Available` (если только предмет не выдан в аренду в этот момент).

---

## 2. Сценарии (вебхуки) в Latenode

Почему Latenode, а не Albato: Latenode позволяет писать кастомный JS-шаг и возвращать произвольный синхронный JSON-ответ с нужным статус-кодом — это нужно для логина (возврат токена) и структурированных ошибок (например, «предмет уже выдан», HTTP 409). Albato слабее в синхронных ответах на вебхук-триггер.

Создайте по одному HTTP-вебхук-сценарию на каждый пункт ниже. Базовый URL всех сценариев (или общий домен Latenode-аккаунта) впишите в `js/config.js` → `WEBHOOK_BASE_URL`.

**Формат ответа для всех эндпоинтов**: `{ "ok": true|false, "data": {...}|null, "error": "текст"|null }`, с соответствующим HTTP-статусом (200 при успехе, 401/404/409 при ошибках).

**Авторизация**: все запросы, кроме `/auth/login`, приходят с заголовком `Authorization: Bearer <token>`. Сценарий должен найти в Staff запись с таким `session_token`, проверить `token_issued_at` (не старше 12 часов) — иначе вернуть 401.

| Эндпоинт | Тело запроса | Логика | Ответ (data) |
|---|---|---|---|
| `POST /auth/login` | `{ login, pin, telegram_id, telegram_init_data }` | Найти Staff по `login`+`active=true`, сравнить хэш `pin` с `pin_hash` (см. §4). По желанию — проверить подпись `telegram_init_data` бот-токеном. Сгенерировать токен (UUID), записать в `session_token`/`token_issued_at` | `{ token, staff_id, full_name, role }` |
| `POST /item/lookup` | `{ item_id }` | Найти Equipment по `item_id` | карточка предмета + `current_transaction` + `open_defects[]` |
| `POST /item/create` | `{ name, category, serial_number, condition_notes }` | Найти максимальный номер по категории, сформировать `item_id` (см. §5), создать запись | `{ item_id }` |
| `POST /transaction/checkout` | `{ item_id, client_id, expected_return_at, notes }` | Проверить `status=Available` (иначе 409), создать Transaction, `Equipment.status=Rented` | `{ transaction_id }` |
| `POST /transaction/checkin` | `{ item_id, has_defect, defect_description, defect_severity, notes }` | Найти открытую Transaction по предмету, закрыть, `Equipment.status = Available` или `In Repair`, при `has_defect` создать Defect | `{ transaction_id, defect_id }` |
| `POST /defect/report` | `{ item_id, description, severity }` | Создать Defect напрямую (не привязан к приёму) | `{ defect_id }` |
| `POST /defect/resolve` | `{ defect_id, status, resolution_notes }` | Обновить Defect, при необходимости вернуть `Equipment.status=Available` | `{}` |
| `POST /equipment/list` | `{ category?, status? }` | Список Equipment с опциональной фильтрацией | `[{ item_id, name, category, status, serial_number }]` |
| `POST /clients/list` | `{}` | Список всех клиентов | `[{ client_id, client_name, project_name, phone, notes }]` |
| `POST /client/create` | `{ client_name, project_name, phone, notes }` | Создать клиента | `{ client_id }` |
| `POST /client/history` | `{ client_id }` | Транзакции по клиенту | `{ transactions: [...] }` |
| `POST /item/history` | `{ item_id }` | Транзакции и дефекты по предмету | `{ transactions: [...], defects: [...] }` |
| `POST /defects/list` | `{ status? }` | Список дефектов с фильтром по статусу (`Open`/`In Repair`/`Resolved`/`all`) | `[{ defect_id, item_id, ... }]` |

Фронтенд обращается ровно к этим 13 эндпоинтам — их точное поведение в mock-режиме см. `js/mock-data.js`, оно уже соответствует этому контракту и может использоваться как эталон при написании сценариев.

---

## 3. Бот в Telegram (BotFather)

1. Откройте `@BotFather` → `/newbot`, задайте имя и username бота.
2. После деплоя фронтенда (см. §6) получите его HTTPS-URL.
3. `/setmenubutton` → выберите вашего бота → укажите текст кнопки (например, «Открыть склад») и вставьте HTTPS-URL приложения (`index.html`).
4. Дополнительно можно настроить `/setdescription`, `/setuserpic`.

Отдельный код бота не требуется: кнопка меню сразу открывает статическую страницу как Telegram Mini App.

---

## 4. Как выдать сотруднику логин и PIN

PIN нигде не хранится в открытом виде — только его хэш. Чтобы завести сотрудника:

1. Придумайте PIN (например, 4–6 цифр).
2. Посчитайте его SHA-256 хэш — например, в консоли браузера или Node.js:
   ```js
   crypto.subtle.digest("SHA-256", new TextEncoder().encode("1234"))
     .then(buf => console.log([...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")));
   ```
3. Создайте запись в Staff с `login`, посчитанным `pin_hash`, `role`, `active=true`.
4. Сценарий `/auth/login` в Latenode должен точно так же хэшировать пришедший `pin` (SHA-256) и сравнивать с `pin_hash`.
5. Сообщите сотруднику логин и PIN — больше ничего устанавливать не нужно, достаточно открыть бота в Telegram.

---

## 5. Схема ID / QR-кодов

Формат: `MIFS-<КОД_КАТЕГОРИИ>-<порядковый номер, 3 цифры>`, например `MIFS-CAM-014`. Коды категорий: `CAM` (камера), `LEN` (объектив), `LGT` (свет), `AUD` (звук), `GRP` (грип), `OTH` (другое). ID генерируется на стороне Latenode при `/item/create`, чтобы исключить коллизии при одновременном добавлении с разных телефонов. QR-код кодирует только сырую строку `item_id`, без URL.

---

## 6. Деплой фронтенда (без GitHub)

Telegram требует HTTPS-адрес для Mini App. Ничего не должно быть привязано к GitHub-аккаунту — используйте один из вариантов ручной/CLI-загрузки статики:

### Вариант А — Netlify Drop (проще всего)
1. Откройте https://app.netlify.com/drop
2. Перетащите в браузер папку репозитория (все файлы: `index.html`, `css/`, `js/`, и т.д.)
3. Получите готовый HTTPS-URL — используйте его в BotFather (§3)
4. Для последующих обновлений: перетащите папку заново, или установите Netlify CLI и деплойте командой `netlify deploy --prod --dir=.` — тоже без подключения Git-репозитория

### Вариант Б — Cloudflare Pages, прямая загрузка
1. Установите Wrangler CLI: `npm install -g wrangler`
2. В папке проекта: `wrangler pages deploy .`
3. Следуйте инструкциям CLI (создание проекта, без привязки к Git)
4. Получите HTTPS-URL проекта

В обоих случаях исходный код может продолжать храниться в этом Git-репозитории — это просто хранилище кода. Сам деплой/обновление сайта делается вручную загрузкой файлов, никакая GitHub-интеграция (Pages, Actions, вебхуки) не используется.

---

## 7. Переключение с mock-режима на реальный бэкенд

В `js/config.js`:
```js
WEBHOOK_BASE_URL: "https://<ваш-домен-latenode>",
MOCK_MODE: false,
```

После этого повторно задеплойте статику (см. §6) и проверьте по цепочке: вход → каталог (создание предмета + QR) → скан (выдача/приём) → дефекты → история.
