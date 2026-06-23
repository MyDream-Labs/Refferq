## 1) API-покрытие (интеграционные)

Выбор стека: **Vitest** (Jest намеренно не используется в этом репозитории для API/e2e-планов).
Для API-интеграций используем только Vitest через `npm run test:api`.

Что именно мокается по умолчанию:
- `@/lib/email` → `tests/mocks/email.mock.ts`
- `@/lib/otp` → `tests/mocks/otp.mock.ts`
- `@/lib/rate-limit` → `tests/mocks/rate-limit.mock.ts`
- `@/lib/prisma` → `tests/mocks/prisma.mock.ts`
- `@/lib/fraud-detection` / `@/lib/program-settings` / `@/lib/audit` — мокировать в конкретном сценарии через `vi.mock`, где есть риск внешнего side-effect.
- `global fetch` (webhook/admin-webhooks-ветки и любые outbound вызовы) — мокировать локально через `vi.fn` в кейсе, где идёт реальный outbound.

В `tests/mocks/email.mock.ts` дополнительно замокан `resend.emails.send`, чтобы безопасно проходили и маршруты, которые дергают `resend` напрямую (например, `admin/reports/email`).

Короткое правило для каждого API-интеграционного кейса:
- если route может отправлять мейлы (OTP/уведомления/отчёты), `vi.mock('@/lib/email', () => import('./mocks/email.mock'))` — всегда.
- если тест проверяет только логику статусов/валидаций без фактического side-effect, поднимайте только нужные моки (`otp`/`rate-limit`/`prisma`) и не добавляйте лишних.

Запускаем тестовый стенд: Postgres из docker-compose.yml + Next dev, база инициализируется
prisma db push + seed для детерминированных фикстур.

### Что покрыть первым (P0)

- Auth flow
  - POST /api/auth/login
    - 202 + next: register для неизвестного email
    - 410 на legacy-поля (password/token/otp…)
    - 400/невалидный email
    - 429 при лимите

  - POST /api/auth/register
    - новый email + валидный name -> создание + OTP (или stub) + 202
    - существующий ACTIVE/PENDING -> 202 + next: otp
    - INACTIVE/SUSPENDED -> 403

  - POST /api/auth/send-otp
    - legacy-блок 410
    - 3/min лимит, валидный flow

  - POST /api/auth/verify-otp
    - неверный код -> 400
    - PENDING/INACTIVE/SUSPENDED -> 403
    - успешный -> HTTP 200 и Set-Cookie auth-token

  - GET /api/auth/me
    - валидный токен/невалидный/просроченный/нет токена

- Middleware + роуты по ролям
  - /api/admin/* без сессии -> 401
  - user без ADMIN -> 403
  - /api/affiliate/* без роли/токена -> 401/403
  - статусные ветки: INACTIVE/SUSPENDED не проходят.

- Tracking
  - POST /api/track/referral
    - без key 401, невалидный payload 400, невалидный код 404
    - успешный: структура ответа

  - POST /api/track/conversion
    - без key 401
    - payload валидация (amount/orderId/eventId)
    - неверная referralCode/неактивный affiliate
    - idempotency: повторный request с тем же X-Idempotency-Key возвращает duplicate: true

- Webhook
  - POST /api/webhook/conversion
    - auth (apikey/sig), idempotency, retry-ветка
    - с attribution по referral_code и по attribution_key
    - повторный webhook (без дубля транзакций)

  - POST /api/webhook/refund
    - auth, отсутствие идентификатора -> 400
    - idempotent повтор возврата
    - статусы комиссий меняются корректно (PENDING/APPROVED/PAID case)

- Payout/комиссии (транзакционность)
  - POST /api/admin/payouts
    - happy-path + недопустимые комиссии + недостаточный баланс + rollback-сценарий

  - POST /api/admin/payouts/auto
    - dryRun
    - реальный проход + частичный fail внутри цикла (чтобы ошибки не ломали весь пакет)

  - PUT /api/admin/payouts статус и side-effect (email можно мокать)

- Affiliate API
  - GET/PUT /api/affiliate/profile
  - POST /api/affiliate/referrals, GET /api/affiliate/referrals
  - POST /api/affiliate/generate-code и GET /api/affiliate/payouts
  - GET/POST /api/affiliate/resources (increment downloads)

### Покрыть через 2–3 отдельные API‑набора после P0

- Admin: /api/admin/affiliates, /batch, /referrals, /transactions, /partner-groups, /api-keys, /settings, /reports, /dashboard, /emails.

- GET /r/[code] (редирект + ref/attr, allowlist host).

## 2) Тестовые слои, которые нужны сразу

1. hardening-smoke расширить как «sanity set» (быстро, как сейчас).
2. api integration (Vitest + fetch к запущенному серверу)
   - 20–30 быстрых кейсов, проверка статусов/тайпок/побочных эффектов в БД.
3. frontend e2e (Playwright)
   - /login: неизвестный email → переход в register, известный → OTP-step.
   - /register: name + email → OTP-step → verify success.
   - роль + редиректы: /admin и /affiliate при неверной роли.
   - базовый happy-path affiliate/admin dashboard загрузка, ошибки API отображение.
   - рут /r/[code]: переход с dest, выставление ref/attr, cookie, запрет open-redirect.

## 3) Что заранее учесть технически

- Мокаем внешние интеграции (Resend, email, подписи webhook), иначе тесты нестабильны.
- Отдельная DB для e2e (refferq_test), cleanup после теста (prisma truncate по таблицам).
- В тестовых данных держать фиксированного:
  - ADMIN активного, AFFILIATE активного
  - INACTIVE, SUSPENDED, PENDING для негативных сценариев.

  - Добавить скрипты:
    - npm run test:api
    - npm run test:e2e
    - npm run test:smoke (объединяет hardening + API sanity)

## 4) Что уже поднято в репозитории

- Добавлен `vitest` (конфиг `vitest.config.ts`) и `npm run test:api` + `npm run test:smoke`.
- Подготовлен мок-слой для внешних зависимостей:
  - `tests/mocks/email.mock.ts`
  - `tests/mocks/otp.mock.ts`
  - `tests/mocks/rate-limit.mock.ts`
  - `tests/mocks/prisma.mock.ts`
- Добавлены интеграционные API-тесты:
  - `tests/api.auth.integration.test.ts` (auth flow + middleware / RBAC / me)
  - `tests/api.tracking.webhook.integration.test.ts` (track-referral, track-conversion, webhook conversion/refund)
  - `tests/api.payout.integration.test.ts` (admin payouts + auto payouts + status side-effect)
  - `tests/api.affiliate.integration.test.ts` (affiliate profile/referrals/payouts/resources)
  - `tests/api.admin.money-core.integration.test.ts` (admin commissions mature, admin transactions, /r/[code])
  - `tests/api.admin.operational.integration.test.ts` (admin affiliates, referrals, partner-groups, api-keys, settings)

Все внешние интеграции в этих тестах замоканы:
  - email (`@/lib/email` -> `tests/mocks/email.mock.ts`)
  - OTP (`@/lib/otp` -> `tests/mocks/otp.mock.ts`)
  - лимитирование (`@/lib/rate-limit` -> `tests/mocks/rate-limit.mock.ts`)
  - Prisma (`@/lib/prisma` -> `tests/mocks/prisma.mock.ts`)
  - настройки программы (`@/lib/program-settings` через локальные стаб-объекты)

- Текущий статус: `npm run test:api` зелёный на новых и существующих API-интеграционных сценариях.

## 5) Что закрыто по текущему PLAN (сейчас)

- ✅ Финансовые критичные флоу покрыты:
  - трек конверсий и идемпотентность
  - payout manual и batch с частичным fail
  - комиссия + созревание payout (`mature`)
  - транзакционные операции с транзакциями/комиссиями в админке
  - создание referral и side-effects по `/api/admin/referrals/[id]`

- ✅ Ключевые админ-операции закрыты интеграционными тестами:
  - `/api/admin/affiliates` (GET/POST)
  - `/api/admin/referrals` (GET/POST batch)
  - `/api/admin/referrals/[id]` (approve path + commission create)
  - `/api/admin/analytics` (overview + агрегаты)
  - `/api/admin/affiliates/[id]` (PATCH/DELETE)
  - `/api/admin/partner-groups` (GET/POST/DELETE)
  - `/api/admin/api-keys` (GET/POST/PUT/DELETE)
  - `/api/admin/settings` (GET, PUT no-op/update-guard paths)
  - `/api/admin/affiliates/batch` (changeStatus/changeGroup/delete + валидации)
  - `/api/admin/dashboard` (статистика и агрегаты)
  - `/api/admin/reports` (summary + csv формат)
  - `/api/admin/emails` (GET/POST/PUT/DELETE + валидации)
  - `/api/admin/refunds` (POST happy path/ошибки + GET списка)
  - `/api/admin/payouts` (GET filter/CSV + DELETE)
  - `/api/admin/payouts/auto` (GET конфигурации + POST dryRun/fail-safe)
  - `/api/admin/refunds` (неизвестный транзакт / уже refunded / нет отменяемых комиссий)
  - `/api/admin/reports/email` (валидации + мокированный `resend`)
  - `tests/api.admin.analytics.extras.integration.test.ts` (8 кейсов)

- ✅ Дополнительно добавлен smoke-набор `tests/api.admin.analytics.integration.test.ts` (20 кейсов).

- Для тестов используется KISS-набор сценариев: только регрессно-значимые happy-path и ключевые отказные ветки без перегруза.
