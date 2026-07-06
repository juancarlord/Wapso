# WhatsApp Contact Center

A multi-agent WhatsApp Contact Center built with Next.js and the WhatsApp Cloud API. This project evolved from a single-user inbox into a fully-fledged customer service platform designed to be hosted locally on a private intranet.

## Features (In Development)

- **Multi-Agent Workspace** - Agents have their own views and assigned conversations.
- **Queue System** - Incoming WhatsApp messages are automatically routed and queued for available agents.
- **Admin Dashboard** - Admins can monitor agent load and manually reassign conversations.
- **Rich Media Support** - Full support for images, videos, audio, and documents.
- **Customer Context** - A dedicated panel showing contact history and aggregated files.
- **Template Messages** - Enforces the WhatsApp 24-hour rule, falling back to templates when necessary.

## Tech Stack

- **Frontend:** Next.js 15, React 19, Tailwind CSS v4, Radix UI (shadcn/ui)
- **Backend:** Next.js API Routes (Node.js)
- **Database:** PostgreSQL (Self-Hosted)
- **ORM:** Prisma
- **WhatsApp Provider:** Kapso API (`@kapso/whatsapp-cloud-api`)

## Prerequisites

To run this contact center locally on your intranet, you will need:

1. **Node.js** (v20+)
2. **PostgreSQL** installed locally (or accessible on your network)
3. Kapso API Credentials:
   - `PHONE_NUMBER_ID`
   - `KAPSO_API_KEY`
   - `WABA_ID`

## Local Setup

### 1. Clone & Install
```bash
npm install
```

### 2. Environment Variables
Create a `.env` file in the root directory:
```env
# Kapso WhatsApp Credentials
PHONE_NUMBER_ID=your_phone_number_id
KAPSO_API_KEY=your_kapso_api_key
WABA_ID=your_business_account_id

# Database Connection (Adjust to your local Postgres setup)
DATABASE_URL="postgresql://username:password@localhost:5432/contact_center"
```

### 3. Database Initialization
```bash
npx prisma generate
npx prisma db push
```

### 4. Run the Application
```bash
npm run dev
```
Open [http://localhost:4000](http://localhost:4000) in your browser.

## Architecture

This application maintains its own local state via PostgreSQL to handle agent assignments, queues, and user roles, while offloading the raw WhatsApp message sending/receiving to the Kapso API via Webhooks.

## License
MIT
