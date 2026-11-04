# Arsitektur Sistem — Discord Project Management Bot

Dokumen ini menjelaskan arsitektur perangkat lunak, pemisahan layer (*Clean Architecture*), aliran data (*data flow*), dan diagram urutan (*sequence diagrams*) untuk bot Discord terintegrasi GitHub.

---

## 1. Pemisahan Layer (Clean Architecture)

Struktur kode sumber di `src/` menerapkan prinsip isolasi dependensi secara ketat:

```text
src/
├── domain/                      # Aturan bisnis murni, entitas, dan custom errors (tanpa dependensi eksternal)
│   ├── types.ts                 # Domain models (Task, Project, AccountLink, Role, AuditEntry, dll.)
│   ├── policies.ts              # State machine (StatusTransitionPolicy, ConcurrencyPolicy)
│   └── errors.ts                # Hierarchy custom domain errors (ConflictError, UnauthorizedError, dll.)
│
├── application/                 # Use cases, ports (interfaces), dan layanan aplikasi
│   ├── ports/                   # Kontrak interface (IRepositories, IGitHubService, ICryptoService, dll.)
│   ├── services/                # AuthorizationService (RBAC), AuditService, NotificationService
│   └── usecases/                # Use cases spesifik (OAuth link, disconnect, daily digest, dll.)
│
├── infrastructure/              # Implementasi teknis dependensi eksternal & framework
│   ├── crypto/                  # Enkripsi AES-256-GCM & HMAC hashing
│   ├── persistence/             # Koneksi better-sqlite3, migrator, dan implementasi repository
│   ├── github/                  # Adapter Octokit REST, App JWT Auth, GraphQL Projects v2, Error Mapper
│   ├── http/                    # Server Fastify, endpoint webhook (/webhooks/github) & OAuth callback
│   └── scheduling/              # DigestScheduler berbasis Croner dengan SQLite lease locks
│
├── interfaces/                  # Adapter antarmuka interaksi pengguna
│   └── discord/                 # Gateway client, registry slash command, interaction router, paginators, modals
│
├── config/                      # Validasi environment & secrets resolver via Zod
└── main.ts                      # Composition root & lifecycle management (startup & graceful shutdown)
```

---

## 2. Aliran Data & Diagram Interaksi

### 2.1 Alur Penautan Akun (OAuth 2.0 PKCE Account Linking)

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer (Discord)
    participant Bot as Discord Gateway & Router
    participant DB as SQLite Storage
    participant Web as Fastify Server
    participant GH as GitHub OAuth Server

    Dev->>Bot: Jalankan /account connect
    Bot->>DB: Buat OAuth State (CSRF state, code_verifier PKCE, Discord UID, TTL 10m)
    Bot-->>Dev: Kirim URL otorisasi GitHub (Ephemeral Message)
    Dev->>GH: Buka link otorisasi di browser & setujui izin
    GH->>Web: Redirect ke GET /auth/github/callback?code=...&state=...
    Web->>DB: Verifikasi & hapus state (Single-use, constant-time compare)
    Web->>GH: Tukar authorization code + code_verifier dengan user token
    GH-->>Web: Kembalikan access token & user profile
    Web->>DB: Simpan relasi discord_user_id <-> numeric github_user_id & token terenkripsi AES-256-GCM
    Web-->>Dev: Tampilkan halaman sukses di browser
    Dev->>Bot: Jalankan /account status
    Bot-->>Dev: Tampilkan status terverifikasi (GitHub Login & Numeric ID)
```

### 2.2 Alur Ingesti Webhook GitHub → Discord Notification

```mermaid
sequenceDiagram
    autonumber
    participant GH as GitHub Webhooks
    participant Web as Fastify Server (/webhooks/github)
    participant Outbox as SQLite Outbox Queue
    participant Worker as NotificationService Worker
    participant DC as Discord Channel

    GH->>Web: POST /webhooks/github (Headers: X-Hub-Signature-256, X-GitHub-Delivery)
    Web->>Web: Verifikasi HMAC SHA-256 raw buffer (crypto.timingSafeEqual)
    alt Signature tidak valid
        Web-->>GH: HTTP 401 Unauthorized
    else Signature Valid
        Web->>Outbox: Simpan event (INSERT OR IGNORE deduplication)
        alt Event duplikat
            Web-->>GH: HTTP 200 OK (Duplicate ignored)
        else Event baru
            Web-->>GH: HTTP 202 Accepted (Enqueued)
            Web->>Worker: Trigger proses outbox asinkron
        end
    end

    Worker->>Outbox: Ambil batch event PENDING
    Worker->>Worker: Normalisasi event & cek allowedMentions
    Worker->>DC: Kirim embed notifikasi ke Discord channel
    Worker->>Outbox: Tandai event PROCESSED (atau FAILED / DEAD_LETTER jika error)
```

---

## 3. Ketahanan Sistem & Graceful Shutdown

Saat sinyal `SIGINT` atau `SIGTERM` diterima:
1. Penjadwal cron (`DigestScheduler`) dan worker outbox dihentikan agar tidak mengambil task baru.
2. Server HTTP Fastify ditutup secara tertib (`httpServer.close()`).
3. Koneksi WebSocket Discord Gateway diputus secara aman (`discordGateway.destroy()`).
4. Database SQLite melakukan checkpoint commit WAL sebelum koneksi ditutup (`dbManager.close()`).
