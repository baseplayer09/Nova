# Nova

Nova contains a Flutter app in `flutter_app/` and a TypeScript/Node.js backend
in `backend/`. The first preview target is Flutter web in Codespaces. Supabase
Auth handles account credentials and sessions; the backend verifies Supabase
access tokens before returning account information.

## Prerequisites

- Flutter SDK with web support and Dart (`flutter --version`)
- Node.js 20.19+, 22.12+, or 24+ and npm (`node --version` and `npm --version`)
- A Supabase project with the NOVA database tables and RLS policies installed.
  Keep database credentials private and never commit them.

## Configure Supabase Auth

In the Supabase dashboard, open **Authentication → Providers → Email** and
require email confirmations. Under **Authentication → URL Configuration**,
add the forwarded Codespaces URL for port `8080` to the allowed redirect URLs.
The app uses the current web origin for signup confirmation and password-reset
links. If the Codespaces URL changes, update the allowed redirect URL.

The Flutter app needs the public Supabase URL and publishable key at build time.
Do not pass database URLs, `OPENAI_API_KEY`, `PIN_PEPPER`, or `MEMORY_KEK` to
Flutter. Never use a Supabase service-role key in the app.

## Configure backend secrets

The backend reads private settings from `backend/.env` or the Codespaces
environment. For a local setup, copy `backend/.env.example` to `backend/.env`
and fill in the Supabase database/auth settings. Configure an OpenAI API key in
the backend environment to enable chat. In Codespaces, add these values under
**Repository → Settings → Secrets and variables → Codespaces**, then restart
the backend terminal:

- `OPENAI_API_KEY` (required for live AI replies)
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DATABASE_URL`, and `DIRECT_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (backend only, required for account deletion)
- `PIN_PEPPER` (a private random value of at least 32 characters)
- `MEMORY_KEK` (a private base64-encoded random 32-byte key)
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (for Gmail OAuth)
- `GOOGLE_OAUTH_REDIRECT_URI` and `NOVA_APP_ORIGIN` (HTTPS deployment URLs)
- `HOME_ASSISTANT_URL` (optional public HTTPS URL for the Home Assistant server)

Never paste keys into chat, commit them, or add them to Flutter build options.
Keep a secure backup of `MEMORY_KEK`; losing it makes encrypted conversation
data unreadable. The AI provider is called only by the backend.

## Deploy the backend to Vercel Hobby

The backend project root is `Nova/backend`. Its Vercel function serves the
existing `/api/*` routes and `/api/health`; Prisma Client is generated during
the configured Vercel build. Add the backend environment variables listed
above in the Vercel project's **Settings → Environment Variables**. Keep the
project on the free Hobby plan; usage pauses at plan limits rather than
automatically upgrading the plan.

Vercel Hobby scheduled jobs run at most once per day, while NOVA's unattended
routine scheduler needs a continuously running backend. Routine API routes
therefore report that routines are unavailable on this plan. The rest of the
backend remains available.

## Preview the Flutter app in Codespaces

Start the backend in one terminal first:

```sh
cd backend
npm start
```

In the Codespaces **Ports** tab, make sure port `3000` is forwarded privately.
The Flutter web app detects its own `8080` Codespaces URL and sends
authenticated requests to the matching backend port.

In a second terminal at the repository root, run:

```sh
cd flutter_app
flutter pub get
flutter run -d web-server \
  --web-hostname 0.0.0.0 \
  --web-port 8080 \
  --dart-define=SUPABASE_URL="$SUPABASE_URL" \
  --dart-define=SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY"
```

In the Codespaces **Ports** tab, open forwarded port `8080` in a browser. Keep
both commands running while previewing and using account/PIN features.

Run the Flutter widget tests from a second terminal at the repository root:

```sh
cd flutter_app
flutter analyze --no-fatal-infos
flutter test
```

For a manual auth check, open the forwarded app URL, create an account, verify
the address using the email link, sign in, log out, and try the password-reset
link. Supabase must allow the current port-8080 Codespaces URL as a redirect.

## Set up the database and backend

From a terminal at the repository root, install the Node.js dependencies:

```sh
cd backend
npm ci
```

Prisma uses `DIRECT_URL` for CLI operations. The backend uses `DATABASE_URL` for
pooled application connections. Make a private local environment file and
replace the example values with the connection strings from your Supabase
project's **Connect** settings:

```sh
cp .env.example .env
```

Use the Supabase pooler connection string for `DATABASE_URL` and the direct
connection string for `DIRECT_URL`. Never commit `.env` or paste its values into
chat. The following validation and client-generation commands do not connect to
Supabase:

```sh
npm run db:validate
npm run db:generate
npm test
```

For a fresh Supabase database, apply the initial Prisma migration:

```sh
npm run db:migrate
```

Then run the SQL in
[`backend/prisma/rls-identity.sql`](./backend/prisma/rls-identity.sql) in
Supabase **SQL Editor**. It creates the restricted `nova_app` database role,
enables per-profile row-level security, and creates/backfills profiles when
Supabase Auth users are created or deleted. The script is safe to rerun after
the schema changes. `db:migrate` and this SQL step require real Supabase
credentials and a reachable database; the automated tests use no live services.

If you already created NOVA tables manually, back up the database and reconcile
its schema with the Prisma migration history before running `db:migrate`.
Do not run the initial migration against tables that already exist. If you have
verified that the existing tables match the initial migration, record that
baseline instead:

```sh
npx prisma migrate resolve --applied 20261114170000_initial_schema
```

Then run the updated RLS SQL and `npm run db:migrate` to create any later
tables and confirm that no migrations remain pending. Do not mark the baseline
applied if the existing schema differs from the migration.

Start the backend with:

```sh
npm start
```

It listens on port `3000` by default. In Codespaces, forward port `3000` from
the **Ports** tab to access `http://localhost:3000/health`. Set `PORT` to use
another port.

## Auth behavior

The app uses Supabase's Flutter client for these account flows:

- Create an account and send an email-verification link.
- Sign in and keep the Supabase session across reloads.
- Send a password-reset link and set a new password from the recovery link.
- Sign out and clear the local session.
- Permanently delete the account after entering the current password, typing
  `DELETE`, and unlocking the profile with the PIN. This uses a server-only
  Supabase service-role key; never put that key in Flutter or share it in chat.

The backend exposes these protected account endpoints:

- `GET /api/auth/session`: checks a bearer token and returns the user record.
- `GET /api/auth/status`: returns whether the bearer token is valid.
- `GET /api/profile`: reads the signed-in user's `profiles` row through Prisma.
- `POST /api/auth/sign-out`: forwards a bearer token to Supabase to revoke its session.

The backend also exposes authenticated PIN endpoints:

- `GET /api/pin/status`: checks whether the profile has a PIN.
- `POST /api/pin/setup`: stores a six-digit PIN as an Argon2id hash.
- `POST /api/pin/verify`: verifies the PIN and persists failed attempts. Five
  incorrect attempts trigger a fifteen-minute lockout.

PIN hashes are salted by Argon2id and combined with the server-only
`PIN_PEPPER`. Configure it with at least 32 random characters; never pass it to
Flutter. After signing in, the app checks PIN status, asks new users to create
and confirm a six-digit PIN, then requires that PIN to unlock their profile.
Five incorrect attempts trigger a fifteen-minute lockout. Successful PIN entry
issues a signed, user-scoped unlock token; the app locks again after fifteen
minutes without activity or when it is closed. The Flutter app sends the PIN
only over HTTPS to the backend; the PIN itself is never persisted.

Prisma models the profile, encryption-key, conversation, message, PIN, and
memory tables. User-scoped database transactions set the verified Supabase
user's JWT claims and switch to the restricted `nova_app` role so PostgreSQL
RLS applies. The automated tests verify that setup without connecting to
Supabase; verify isolation against two real Supabase accounts before relying on
production data.

## Encrypted chat

The backend chat endpoints require both a valid Supabase access token and the
profile's signed PIN-unlock token. The unlock token is renewed on each request
and is held only in app memory.

- `POST /api/chat` sends a message and stores the user/assistant turns.
- `GET /api/conversations` lists the authenticated profile's conversations.
- `GET /api/conversations/:id/messages` loads one conversation.
- `DELETE /api/conversations/:id` deletes one conversation.
- `DELETE /api/conversations` deletes all conversations after in-app
  confirmation.

Conversation content is encrypted with AES-256-GCM using a random key per
profile; that key is wrapped by the backend-only `MEMORY_KEK`. The backend
decrypts only to form the prompt sent to the configured AI provider. A live
chat check requires `OPENAI_API_KEY`, a valid Supabase account, the database
schema/RLS setup, and a configured PIN.

## Approved memories

When a user explicitly starts a message with a request such as "Remember
that...", NOVA creates an encrypted pending proposal. The app shows a **Remember
this?** card; the content is not considered saved until the user approves it.
Declining deletes the pending proposal. Passwords, PINs, payment-card-like
numbers, and government-ID terms are blocked from memory storage on the backend.

- `GET /api/memories/pending` lists proposals awaiting a decision.
- `POST /api/memories/:id/approve` approves one proposal.
- `POST /api/memories/:id/decline` discards one proposal.
- `GET /api/memories?search=...` searches approved memories after decrypting
  them server-side.
- `DELETE /api/memories/:id` permanently deletes one approved memory.
- `GET /api/memories/export` returns approved memories as readable JSON. The
  Settings data export also includes saved conversations and their messages;
  the app lets the user copy the combined JSON.

Memory records use the same per-profile AES-256-GCM key as chat content. The
routine instructions use the same per-profile encryption key.

## Activity

The Activity tab combines saved conversation dates, approved memory events, and
scheduled routine runs from the signed-in profile. Filters show all activity,
routine runs, or runs waiting for approval. It does not record every app
interaction. The list refreshes from the backend when opened and can be manually
refreshed.

## Scheduled routines

The Routines tab supports weekly time schedules in a selected timezone. Each
scheduled occurrence is queued by the backend while it is online and waits in
the app for the user to review and approve it. Only after approval does NOVA
send the routine's saved prompt to chat. A routine cannot directly operate
integrations, and any outside action must still be separately approved in its
connection flow. The Routines screen checks for new approvals every 30 seconds
while open. Missed schedules are not replayed one by one after downtime.

Routine prompts are encrypted with the profile's data key. Routines and queued
runs use profile-scoped RLS. The backend checks for due schedules every 30
seconds; a continuously available backend and the updated database SQL are
required for unattended queueing.

- `GET /api/routines` lists the signed-in profile's schedules.
- `POST /api/routines` creates a weekly schedule.
- `POST /api/routines/:id/enabled` enables or pauses a schedule.
- `DELETE /api/routines/:id` deletes a schedule and its pending runs.
- `GET /api/routines/runs` lists scheduled occurrences.
- `POST /api/routines/runs/:id/run` requires an explicit approval and starts
  the routine prompt in chat.

## Native voice

The installed Android and iOS apps support tap-to-talk dictation and spoken
replies. Windows dictation uses a beta plugin and needs testing on a Windows
device. Dictation is requested only after tapping the microphone and requests
on-device speech recognition. NOVA puts recognized words in the composer for
review; it does not send them automatically. Replies are read aloud only after
tapping that reply's speaker button. The web preview remains text-only and
never requests microphone access. Speech recognition availability depends on
the device; typing remains available if it is unavailable.

The Android project requests microphone permission at runtime. iOS displays
microphone and speech-recognition permission prompts; the app currently targets
iOS 16 or newer. Wake-word listening is not yet enabled: it needs a Picovoice
AccessKey and custom platform models, and its client-side key would be
extractable from a built app. Do not paste that key into chat or commit it.

To try voice on a device or emulator, first run `flutter devices` from
`flutter_app/`. Native builds need the Supabase URL and publishable key, plus
`NOVA_API_BASE_URL` set to the HTTPS address of a backend reachable from the
device. A private Codespaces port or `localhost` on a physical phone will not
work as that address. From `flutter_app/`, run:

```sh
flutter pub get
flutter run -d <device-id> \
  --dart-define=SUPABASE_URL="$SUPABASE_URL" \
  --dart-define=SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
  --dart-define=NOVA_API_BASE_URL="$NOVA_API_BASE_URL"
```

These three values are URLs/public client configuration, not backend secrets.
Never pass database URLs, `OPENAI_API_KEY`, `PIN_PEPPER`, `MEMORY_KEK`, or the
Supabase service-role key to Flutter. Android requires an Android
emulator/device with speech recognition installed. iOS builds require macOS and
Xcode; Windows builds require Windows. Use `flutter test` and
`flutter analyze --no-fatal-infos` in `flutter_app/` for the hardware-free
checks available in Codespaces.

## Gmail read-only connection

The Connections tab supports Google OAuth with `gmail.readonly` and
`calendar.events` plus the identity scopes. Gmail is still read-only: there are
no send, draft, delete, or modify routes. Gmail search results show only sender,
subject, date, and a short Google-provided snippet; fetched mail is not saved by
NOVA. Calendar events can be read and created; NOVA requires an on-screen
review and confirmation before creating an event. The refresh token is
encrypted with the profile data key before storage, and integration calls
require both the signed-in Supabase session and PIN unlock.

- `GET /api/integrations/calendar/events?timeMin=...&timeMax=...` lists up to
  50 events in a range of at most 31 days.
- `POST /api/integrations/calendar/events` creates an event only when its
  payload includes `approved: true`; the app sets this only after the user
  reviews the event and taps **Create event**.

## Home Assistant and Amazon Music

Set `HOME_ASSISTANT_URL` to the HTTPS URL reachable from the deployed backend.
Each profile connects with its own Home Assistant long-lived access token; the
backend verifies the token and encrypts it with that profile's data key before
storing it in `connected_accounts`. Connections are profile-scoped by RLS.
Disconnecting deletes NOVA's token, but the user must revoke that token in
Home Assistant to invalidate it there.

The app lists supported lights, switches, covers, locks, alarms, and media
players. It asks for on-screen approval before every action. Locks and alarms
also require entering the six-digit NOVA PIN immediately before the action.
Amazon Music has no supported direct NOVA playback API, so playback requests
are sent through a selected Home Assistant media player only if the user's
Home Assistant setup supports Amazon Music. NOVA never asks for an Amazon
password.

The RLS setup script allows the Google and Home Assistant connection providers.
Rerun [`backend/prisma/rls-identity.sql`](./backend/prisma/rls-identity.sql)
after updating to this version. The script also creates the RLS-protected
routine tables and the narrowly scoped database function used by the scheduler.

To configure a deployed OAuth test:

1. In Google Cloud Console, enable the Gmail API and Google Calendar API, then
   create an OAuth client ID for a Web application. Existing Gmail connections
   need to disconnect and reconnect to grant Calendar access.
2. Add the exact value of
   `GOOGLE_OAUTH_REDIRECT_URI` to the OAuth client's authorized redirect URIs.
   The URL format is `https://YOUR_BACKEND_HOST/api/integrations/google/callback`.
3. Add the Google client ID and secret to backend environment secrets. Set
   `NOVA_APP_ORIGIN` to the app's HTTPS origin, without a path.
4. Rerun [`backend/prisma/rls-identity.sql`](./backend/prisma/rls-identity.sql)
   in Supabase SQL Editor to create the encrypted connected-account table and
   its RLS policy.
5. Add test accounts to Google's OAuth consent screen while the app remains in
   testing mode, then use **Connections → Connect Google**. Calendar event
   creation remains gated by a separate confirmation in NOVA.

Live OAuth is intentionally not testable from the current private Codespaces
preview: Google must be able to reach the registered HTTPS callback. The
backend OAuth flow is implemented, but do not make a Codespaces port public
just to test it. The user can test it after deploying the backend to a public
HTTPS host and registering that callback.

## Settings preview

The Settings tab includes account/logout, PIN-security information, memory
review and JSON export, and accessibility controls for text size, high contrast,
and reduced motion. Accessibility preferences are stored locally per Supabase
profile on each device; they do not sync between devices. Voice recognition,
wake-word listening, and push notifications are intentionally unavailable in
the Codespaces web preview. No microphone or background listening is enabled
there. The remaining designed voice, location, and profile-switching features
are not part of this web-preview implementation.
