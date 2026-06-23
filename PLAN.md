# TEST PLAN (KISS)

## Цель
Покрыть базовый функционал API и ключевые бизнес-флоу (авторизация, трекинг, деньги/выплаты, интеграции и важные админ/affiliate ручки) интеграционными тестами без избыточных сценариев.

## Инструмент
- **Vitest** (`npm run test:api`)
- Моки: `tests/mocks/*` для `email`, `otp`, `rate-limit`, `prisma`, fetch/webhook-ветки при необходимости

## Что уже закрыто (сейчас)
- `auth`: login/register/send-otp/verify-otp/me, middleware RBAC, статусные ветки.
- `tracking + webhook`: `track/referral`, `track/conversion`, `webhook/conversion`, `webhook/refund`, идемпотентность и авторизация.
- Деньги/выплаты:
  - `admin/payouts` (POST/PUT/GET/DELETE)
  - `admin/payouts/auto` (dryRun / частичный fail-safe)
  - `admin/commissions/mature`, `admin/transactions`, `admin/refunds`
- Affiliate: `profile`, `referrals`, `payouts`, `resources`
- Админский core: `affiliates`, `batch`, `referrals`, `partner-groups`, `api-keys`, `settings`, `dashboard`, `reports`, `emails`, `transactions`, `referrals/[id]`
- Дополнительно добавлено (в этой итерации):
  - `admin/integration` (GET/PUT)
  - `admin/integration/generate-key`
  - `admin/profile` (GET/PUT)
  - `auth/logout`
  - `admin/settings/integration` (GET/POST/DELETE)
  - `admin/settings/profile` (GET/PUT)

## Что считать выполненным
`npm run test:api` зелёный и покрытие выше по всем блокам без тестов ради покрытия:
- проверены happy path + критичные негативные ветки
- проверены side-effects, где они бизнес-критичны (ролевые проверки, идемпотентность, транзакционный rollback)

## Осталось как опционально
- frontend e2e (Playwright) для 3–4 сценариев из старого плана, если нужна отдельная проверка UI.
- дополнительное покрытие вторичных админ-модулей (`coupons/invoices/webhooks/programs`), по мере времени.
