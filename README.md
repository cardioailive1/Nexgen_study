# NexGen Study — Production Deployment

**Corverxis Technologies Ltd** · corverxis.com

AI academic companion for undergraduates, Master's and PhD students. Powered by NexGen Ultra.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ / Express |
| Database | PostgreSQL via Prisma ORM |
| Auth | JWT + OAuth2 (Google, Microsoft) + TOTP MFA |
| AI | Anthropic Claude API (Sonnet + Haiku) |
| Payments | Stripe Subscriptions |
| Hosting | Render.com |
| Frontend | Single HTML — served as static file |

---

## Deploy to Render in 5 Steps

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial NexGen Study production build"
git remote add origin https://github.com/your-org/nexgen-study.git
git push -u origin main
```

### 2. Create Render services
- Go to render.com → New → Blueprint
- Connect your GitHub repo
- Render reads `render.yaml` and creates the web service + PostgreSQL automatically

### 3. Set environment secrets in Render Dashboard
Go to your web service → Environment tab and add:

```
JWT_SECRET              = (generate: openssl rand -hex 32)
JWT_REFRESH_SECRET      = (generate: openssl rand -hex 32)
ENCRYPTION_KEY          = (generate: openssl rand -hex 32)
SESSION_SECRET          = (generate: openssl rand -hex 32)
ANTHROPIC_API_KEY       = sk-ant-api03-...
STRIPE_SECRET_KEY       = sk_live_...
STRIPE_PUBLISHABLE_KEY  = pk_live_...
STRIPE_WEBHOOK_SECRET   = whsec_...
STRIPE_PRICE_SCHOLAR    = price_...
STRIPE_PRICE_RESEARCHER = price_...
SUPABASE_ANON_KEY       = sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY = eyJ...
GOOGLE_CLIENT_ID        = ...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET    = ...
MICROSOFT_CLIENT_ID     = ...
MICROSOFT_CLIENT_SECRET = ...
SMTP_PASS               = re_... (Resend API key)
CORS_ORIGINS            = https://your-app.onrender.com
```

### 4. Set up Stripe webhook
- Stripe Dashboard → Developers → Webhooks → Add endpoint
- URL: `https://your-app.onrender.com/api/webhooks/stripe`
- Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
- Copy the signing secret → set as `STRIPE_WEBHOOK_SECRET`

### 5. Set up OAuth2

**Google:**
- console.cloud.google.com → Create OAuth 2.0 Client ID
- Authorised redirect URI: `https://your-app.onrender.com/api/auth/google/callback`

**Microsoft:**
- portal.azure.com → App Registrations → New Registration
- Redirect URI: `https://your-app.onrender.com/api/auth/microsoft/callback`

---

## Database Migrations

Migrations run automatically on deploy via `render.yaml` buildCommand.

To run manually:
```bash
npx prisma migrate deploy
npx prisma db seed
```

To create a new migration in development:
```bash
npx prisma migrate dev --name your_migration_name
```

---

## Local Development

```bash
cp .env.example .env
# Fill in .env values

npm install
npx prisma generate
npx prisma migrate dev

npm run dev
# App runs at http://localhost:3000
```

---

## API Reference

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/auth/register | — | Create account |
| POST | /api/auth/login | — | Sign in |
| POST | /api/auth/logout | ✓ | Sign out |
| POST | /api/auth/refresh | — | Refresh access token |
| POST | /api/auth/forgot-password | — | Request reset email |
| POST | /api/auth/reset-password | — | Set new password |
| GET | /api/auth/google | — | Google OAuth2 |
| GET | /api/auth/microsoft | — | Microsoft OAuth2 |
| POST | /api/auth/mfa/setup | ✓ | Start MFA enrollment |
| POST | /api/auth/mfa/verify | ✓ | Confirm MFA + enable |
| POST | /api/auth/mfa/disable | ✓ | Disable MFA |
| POST | /api/ai/generate | ✓ | Generate AI content |
| GET | /api/ai/usage | ✓ | Daily usage stats |
| POST | /api/subscriptions/checkout | ✓ | Create Stripe checkout |
| POST | /api/subscriptions/portal | ✓ | Open billing portal |
| GET | /api/subscriptions/status | ✓ | Current plan status |
| GET | /api/users/me | ✓ | Get profile |
| PUT | /api/users/me | ✓ | Update profile |
| PUT | /api/users/me/password | ✓ | Change password |
| GET | /api/compliance/privacy-notice | — | Privacy policy data |
| POST | /api/compliance/data-export | ✓ | GDPR data export |
| POST | /api/compliance/delete-account | ✓ | GDPR erasure request |
| PUT | /api/compliance/consent | ✓ | Update marketing consent |
| GET | /api/compliance/audit-log | ✓ | User's audit trail |
| GET | /api/health | — | Health check |

---

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for full SOC 2, GDPR, CCPA and FERPA compliance documentation.

**Governing Law:** State of Delaware, United States  
**Support:** support@corverxis.com  
**Security:** security@corverxis.com
