# NexGen Study — Security & Compliance

**Corverxis Technologies Ltd**  
Governing Law: State of Delaware, United States

---

## Standards & Frameworks

| Standard | Status | Notes |
|---|---|---|
| **SOC 2 Type II** | In Progress | CC6, CC7, CC8 controls implemented |
| **GDPR** | Compliant | EU data subject rights fully implemented |
| **CCPA** | Compliant | California consumer privacy rights implemented |
| **FERPA** | Aligned | Student data protections applied |
| **ISO 27001** | Aligned | Information security management practices followed |
| **OWASP Top 10** | Mitigated | Controls implemented for all Top 10 risks |

---

## SOC 2 Control Implementation

### CC6 — Logical and Physical Access Controls
- JWT-based authentication with httpOnly secure cookies
- bcrypt password hashing (12 rounds minimum)
- Account lockout after 5 failed login attempts (15-minute lockout)
- TOTP Multi-Factor Authentication (RFC 6238)
- MFA secrets encrypted at rest using AES-256-GCM
- OAuth2 via Google and Microsoft (OpenID Connect)
- Role-based access control (TRIAL / SCHOLAR / RESEARCHER / ADMIN)
- Session tokens never stored in localStorage (httpOnly cookies only)

### CC6.6 — Network and Communication Security
- HTTPS enforced in production (Render TLS)
- HSTS with 1-year max-age, includeSubDomains, preload
- Content Security Policy restricting script/style/connect sources
- CORS restricted to approved origins only
- All API endpoints rate-limited (global + AI-specific limits)
- X-Frame-Options: DENY (clickjacking prevention)
- X-Content-Type-Options: nosniff

### CC7 — System Operations
- Structured audit logs for all significant actions (365-day retention)
- Unique request IDs on all API responses
- Health check endpoint for monitoring
- Graceful shutdown handling
- Error messages sanitised in production (no stack traces exposed)

### CC8 — Change Management
- All environment secrets externally managed (Render env vars, never in code)
- Prisma migrations for all schema changes (versioned, reviewed)
- Dependency audit: `npm audit --audit-level=high` in CI pipeline

---

## GDPR Compliance

| Right | Article | Implementation |
|---|---|---|
| Right to Access | Art. 15 | `GET /api/compliance/data-export` |
| Right to Rectification | Art. 16 | `PUT /api/users/me` |
| Right to Erasure | Art. 17 | `POST /api/compliance/delete-account` |
| Right to Portability | Art. 20 | JSON export via `/api/compliance/data-export` |
| Right to Object | Art. 21 | `PUT /api/compliance/consent` |
| Privacy Notice | Art. 13-14 | `GET /api/compliance/privacy-notice` |

**Data minimisation:** Prompt content is not stored. Only token counts, tool metadata and timestamps are retained.

**Data retention:** 365 days default. Users can request deletion at any time. Deleted accounts are anonymised immediately and hard-purged within 30 days.

**International transfers:** Data may be processed in the United States (Render, Anthropic API). Standard Contractual Clauses (SCCs) apply for EU/UK data subjects.

---

## CCPA Compliance

- No sale of personal information to third parties
- Opt-out of marketing communications: `PUT /api/compliance/consent { marketing: false }`
- Data deletion available to California residents via `/api/compliance/delete-account`
- Privacy notice discloses all data categories collected and purposes

---

## FERPA Alignment

- Student education records (generation history) are not shared with third parties
- School officials accessing the platform are bound by Terms of Service
- De-identification applied: prompt content not retained after session

---

## Encryption

| Data | At Rest | In Transit |
|---|---|---|
| Passwords | bcrypt (12+ rounds) | TLS 1.2+ |
| MFA secrets | AES-256-GCM | TLS 1.2+ |
| MFA backup codes | AES-256-GCM | TLS 1.2+ |
| Database | Render PostgreSQL encrypted storage | SSL required |
| Session cookies | httpOnly, Secure, SameSite=Strict | TLS 1.2+ |

---

## Responsible Disclosure

To report a security vulnerability, email **security@corverxis.com** with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment

We acknowledge reports within 48 hours and aim to resolve critical issues within 7 days.

**Do not** publicly disclose vulnerabilities before we have had the opportunity to address them.
