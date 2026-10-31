# Suite Wave 0 → lecciones para Mundo (kapso-exit cutover)

Fecha: 2026-10-30 (COT). Fuente: Tekobo Suite Wave 0 en `suite.tekobo.io`, Meta Cloud API directo (NO Kapso).
Úsalo como checklist antes/durante el cutover de Mundo (`INBOX_SOURCE=local`, ver `CUTOVER.md` en la rama de cutover).
Sin secretos aquí: valores reales solo en Coolify.

## Checklist (plain)

1. **Subscribe webhooks = ON.** Que "Verify" salga verde NO basta. En Meta → WhatsApp → Configuration, el número debe tener *Subscribe webhooks* activado; si no, los mensajes entrantes no llegan y no hay error (nos pasó en Suite).
2. **Coolify y el signo `$`.** Coolify se "come" el `$` en variables. Para `META_WEBHOOK_VERIFY_TOKEN` y el hash scrypt de `ADMIN_PASSWORD_HASH` (si aplica), marcar la variable como **Literal** o escribir `$$`. Revisar el valor después de guardar.
3. **Alertas Resend obligatorias para arrancar.** `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`, `ALERT_RESEND_API_KEY` — no quitarlas en el cutover o la app no inicia.
4. **`PHONE_NUMBER_ID` exacto.** Mensajes con `metadata.phone_number_id` distinto se descartan en silencio. Mundo debe usar **CallcenterMundo `886500594547558`**. Nunca el de Tekobo Suite `1372015455998160`.
5. **`APP_ORIGIN` exacto, sin `/` final** (ej. `https://whatsapp-mundoradiologico.tekobo.io`). Si no coincide → login da 403 "origin".
6. **Webhook:** URL `…/api/webhooks/meta`, verify token ≥ 32 caracteres, campo suscrito `messages`.
7. **No mezclar WABAs.**
   - Mundo CallcenterMundo: WABA `1242112867743026`, phone ID `886500594547558`.
   - Tekobo Suite (aparte): WABA `29085928537730754`, número +57 319 7858284, phone ID `1372015455998160`.
8. **(Opcional) `subscribed_apps`.** `POST /{WABA_ID}/subscribed_apps` puede responder "API not supported for this WABA" en la nueva estructura de "messaging account" de Meta (en Suite se vio Messaging Account ID `1519797803387591`). Si pasa, confirmar la suscripción por la UI (punto 1). TODO: verificar si aplica a la WABA de Mundo.

## Prueba rápida tras cutover
Enviar un WhatsApp al número de Mundo → debe aparecer en el inbox en segundos. Si no: revisar 1, 4, 6.
