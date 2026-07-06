# Contact Center Roadmap

To evolve this project from a single-user inbox into a fully-fledged WhatsApp Contact Center, we need to introduce a local database to track our own state (agents, assignments, queues) alongside the Kapso API, which will continue to handle the raw WhatsApp messages.

Here is the step-by-step roadmap to make this dream a reality:

## Phase 1: Database & Authentication Foundation

Currently, the app relies purely on Kapso's API to list conversations. To assign conversations to agents, we need a local database.

1.  **Add a Database & ORM:**
    *   Set up a PostgreSQL database (e.g., Supabase, Vercel Postgres, or Neon).
    *   Install an ORM like **Prisma** or **Drizzle ORM** for type-safe database access.
2.  **Implement Authentication:**
    *   Add **NextAuth.js (Auth.js)** or **Supabase Auth**.
    *   Create roles: `AGENT` and `ADMIN`.
    *   Force users to log in before accessing the dashboard.

## Phase 2: Database Schema

We need to sync Kapso's conversations with our local state.

```prisma
// Example Prisma Schema
model User {
  id            String    @id @default(cuid())
  name          String
  email         String    @unique
  role          Role      // AGENT, ADMIN
  status        Status    // ONLINE, OFFLINE, BUSY
  conversations Conversation[] // Assigned conversations
}

model Conversation {
  id              String   @id // Maps to Kapso Conversation ID
  phoneNumber     String
  contactName     String?
  status          ConvStatus // QUEUED, ACTIVE, RESOLVED
  assignedAgentId String?
  assignedAgent   User?    @relation(fields: [assignedAgentId], references: [id])
  files           File[]   // Files extracted from the conversation
  lastMessageAt   DateTime
}

model File {
  id             String @id @default(cuid())
  conversationId String
  url            String
  fileType       String
  conversation   Conversation @relation(fields: [conversationId], references: [id])
}
```

## Phase 3: Webhooks & The Queue System

We cannot rely purely on the frontend polling Kapso anymore. We need a backend service that listens to incoming messages and routes them.

1.  **Setup Kapso Webhooks:**
    *   Configure a webhook endpoint (e.g., `/api/webhooks/kapso`) to receive real-time notifications for every incoming message.
2.  **The Routing Logic (Queue System):**
    *   **New Message Arrives:** The webhook checks if the `conversationId` exists in our local database.
    *   **If New / Unassigned:** Create the conversation in the DB with status `QUEUED`.
    *   **If Assigned:** The message simply updates the `lastMessageAt` timestamp for the assigned agent to see.
3.  **Assignment Engine (Optional):**
    *   You can implement *Auto-assignment* (Round-robin to the next `ONLINE` agent) or *Manual Claiming* (Agents click "Accept" from a global queue pool).

## Phase 4: Frontend UI Restructuring

The UI needs to be split based on the user's role.

### Agent View (The Workspace)
*   **My Chats:** Modify the `ConversationList` to only fetch and show conversations assigned to `currentUser.id`.
*   **Queue Tab:** A tab showing unassigned conversations waiting for an agent. Agents can click to "Claim" them.
*   **User Panel (Right Sidebar):** Inside the `MessageView`, add a right-hand drawer. Whenever a file/image is sent in the chat, the backend saves it to the `File` table, and this drawer displays all files associated with the contact for quick reference.

### Admin View (The Command Center)
*   **Dashboard:** A new route (e.g., `/admin`) that displays metrics (average wait time, active chats).
*   **Agent Management:** See which agents are online/offline and their current load (number of active chats).
*   **Manual Override:** A view showing all active conversations, allowing the Admin to forcibly reassign a chat from Agent A to Agent B.

---

## Next Steps
Would you like to start by setting up **Prisma and PostgreSQL** for the database, or would you prefer to start by adding **NextAuth** for user logins?
