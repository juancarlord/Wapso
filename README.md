# WhatsApp Cloud Inbox (Wapso)

A web inbox for a WhatsApp Business number, built with Next.js on top of the WhatsApp Cloud API through [Kapso](https://kapso.ai) (`@kapso/whatsapp-cloud-api`). It started from Kapso's open-source WhatsApp inbox template and is being adapted for Mundo Radiológico. The long-term goal is a multi-agent contact center hosted on a private intranet (see [docs/ROADMAP.md](docs/ROADMAP.md)).

> **Status:** single-user inbox. There is **no database, no login and no agent/queue system yet**. All conversations and messages are read live from the Kapso API, and the UI refreshes by polling. It runs on the Mundo Radiológico intranet.

## Features (implemented)

- **Conversation list:** loads conversations for the configured phone number from Kapso (cursor pagination, 100 per page), refreshes every 10 s, client-side search, and merges entries that share a phone number or contact name.
- **Message view:** loads messages for the selected conversation (50 by default, max 100) and refreshes every 5 s.
- **Sending:** text messages plus image, video, audio and document attachments (uploaded to WhatsApp media first, with an optional caption).
- **Media:** incoming media is proxied through `/api/media/[mediaId]`; images open in a preview with zoom, pan and rotate.
- **24-hour rule:** free-form messages are only allowed within 24 h of the customer's last inbound message; otherwise the UI only offers templates.
- **Templates:** list the WABA's message templates, fill in header/body parameters and send.
- **Interactive messages:** send a reply-button message (up to 3 buttons, optional text header).
- **Quick reply:** one hard-coded Spanish canned message for Mundo Radiológico's document-verification line (`src/components/message-view.tsx`).
- Recipients can be a phone number or a business-scoped user ID (BSUID).

## Tech stack

- **Framework:** Next.js 15.5 (App Router, Turbopack in dev), React 19.1, TypeScript
- **UI:** Tailwind CSS v4, shadcn/ui (Radix UI primitives), lucide-react, date-fns
- **Backend:** Next.js API route handlers (Node.js)
- **WhatsApp provider:** Kapso proxy for the Meta Graph API (`https://api.kapso.ai/meta/whatsapp`, Graph `v24.0`)

## Prerequisites

1. **Node.js** 20+
2. Kapso credentials for a connected WhatsApp Business number:
   - `PHONE_NUMBER_ID`
   - `KAPSO_API_KEY`
   - `WABA_ID` (needed to list templates)

## Local setup

```bash
npm install
cp .env.example .env    # fill in the three values below
npm run dev
```

`.env`:

```env
PHONE_NUMBER_ID=your_phone_number_id
KAPSO_API_KEY=your_kapso_api_key
WABA_ID=your_business_account_id
```

Open [http://localhost:4000](http://localhost:4000).

Other scripts:

| Script | Command |
|---|---|
| `npm run build` | `next build` |
| `npm start` | `next start` (port 3000 unless you pass `-p`) |
| `npm run lint` | `eslint` |

## API routes

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/conversations?status=&after=` | List conversations (Kapso `conversations.list`) |
| GET | `/api/messages/[conversationId]?limit=` | Messages of a conversation |
| POST | `/api/messages/send` | Send text or media (`multipart/form-data`: `to`, `body`, `file`) |
| POST | `/api/messages/interactive` | Send a reply-button message (`phoneNumber`, `header`, `body`, `buttons`) |
| GET | `/api/templates` | List the WABA's templates |
| POST | `/api/templates/send` | Send a template with parameters |
| GET | `/api/media/[mediaId]` | Download and stream a media file |

**These routes have no authentication.** Anyone who can reach the server can read the conversations and send messages from the business number. The app is currently deployed only on the Mundo Radiológico intranet, which is what keeps it safe today. Don't expose it to the public internet (or put it behind a reverse proxy with auth) until login is added, and add login before moving to multiple agents so each message can be attributed to a person.

## Project structure

```
whatsapp-cloud-inbox/
├── src/
│   ├── app/
│   │   ├── api/            # Route handlers listed above
│   │   ├── layout.tsx
│   │   └── page.tsx        # Two-pane layout: ConversationList + MessageView
│   ├── components/         # conversation-list, message-view, media-message, template + interactive dialogs, ui/ (shadcn)
│   ├── hooks/              # use-auto-polling
│   ├── lib/                # whatsapp-client (Kapso client), template-parser, utils
│   └── types/whatsapp.ts
├── assets/                 # Screenshot from the upstream Kapso template
├── public/
├── docs/                   # Roadmap and improvement notes
└── .env.example
```

## Authentication, users and Coolify deploy

Every page and `/api/*` route requires login (`src/middleware.ts`, Node runtime); only `/login` and `/api/auth/login` are public. Users live in SQLite (`$DATA_DIR/inbox.db`, Node's built-in `node:sqlite`, Node ≥ 22.5). Roles: `admin` (Administrador: manages every user, the only one who can create or promote leads and admins), `lead` (Líder: creates, deactivates, reactivates, resets and deletes agents only) and `agent` (Agente: uses the inbox and can view `/admin/usuarios` read-only). All rules are enforced in the API. Existing databases are migrated automatically on start to add the `lead` role. The session cookie (httpOnly, SameSite=Lax, Secure in production, 12 h) carries the user id and a session version; each request re-checks the user in the DB, so deactivating a user or resetting a password logs them out immediately. State-changing API calls must pass a same-origin check. Login is rate limited in memory (5 failures per 15 min per IP+user). Users created or reset by an admin must change their password (min 10 chars) at first login.

Bootstrap the first admin: run `npm run hash-password` (hidden input, prints `scrypt$...`), and set `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH`. On start, if no active admin exists, that admin is created (or re-enabled with that password). After the first successful boot and login, **remove `ADMIN_PASSWORD_HASH` (and `ADMIN_USERNAME`) from Coolify** and redeploy; otherwise, if no active admin exists on a later start, that password is restored. Create agents from `/admin/usuarios`.

Coolify (Nixpacks) settings:

- Build: `npm run build`, start: `npm start`, port `3000`; Node ≥ 22.5 (`engines` in package.json)
- Persistent storage: a volume mounted at `/app/data` and `DATA_DIR=/app/data`. Without it, users are lost on every redeploy.
- Env vars: `KAPSO_API_KEY`, `PHONE_NUMBER_ID`, `WABA_ID`, `AUTH_SECRET` (≥32 chars), `APP_ORIGIN` (e.g. `https://whatsapp-mundoradiologico.tekobo.io`; required in production, otherwise every POST/PATCH is rejected), `DATA_DIR`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, optional `ADMIN_NAME`. In Coolify, mark the hash as a literal value or escape `$` if it gets interpolated.
- HTTPS only (Secure cookie; `AUTH_INSECURE_COOKIE` is a local-testing switch and is refused in production). Without a valid `AUTH_SECRET` every request gets 503. Rotating `AUTH_SECRET` logs everyone out.
- Run a single instance: the rate limiter is in memory and SQLite is local.

## Planned (not implemented yet)

Multi-agent workspace, queue and assignment engine, admin dashboard, customer context panel, PostgreSQL + Prisma for local state, per-user roles, and Kapso webhooks instead of polling. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Documentation

- [docs/ROADMAP.md](docs/ROADMAP.md): plan for turning the inbox into a multi-agent contact center (database, auth, webhooks, queue, admin view)
- [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md): suggested code-level improvements (SSE/WebSockets, data-fetching library, splitting `message-view.tsx`, canned responses, error toasts)

## License

MIT, see [LICENSE](LICENSE) (copyright Kapso, from the upstream template).
