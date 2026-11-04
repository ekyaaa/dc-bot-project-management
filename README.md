# Discord Project Management Bot

[![Node Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-504%20passed-success.svg)](docs/discord-bot/TEST_REPORT.md)

Bot Discord deterministik (tanpa ketergantungan LLM) untuk koordinasi alur kerja pengembangan tim, terintegrasi langsung dengan GitHub Issues, GitHub Projects v2, Pull Requests, dan verifikasi identitas pengembang.

Dikemas secara mandiri untuk deployment di Linux VPS menggunakan Docker Compose dengan persistensi SQLite lokal yang aman.

---

## Fitur Utama

- **15 Slash Commands Cepat & Responsif**:
  - **Kueri Baca**: `/project status`, `/project issues`, `/project mine`, `/project blocked`, `/project unassigned`, `/project reviews`, `/project digest`, `/issue view`, `/help`.
  - **Operasi Tulis Terkendali**: `/issue create` (dengan modal interaktif), `/issue assign`, `/issue status`, `/issue priority`, `/issue block`, `/issue comment`.
- **Integrasi GitHub App Resmi**:
  - Otentikasi formal via JWT & Installation Token otomatis (@octokit/app, @octokit/rest, @octokit/graphql). Tidak memerlukan Personal Access Token (PAT).
- **Penautan Akun OAuth 2.0 PKCE (Identity Linking)**:
  - Alur otentikasi mandiri (`/account connect`, `/account status`, `/account disconnect`) yang memetakan identitas Discord ke Numeric GitHub ID stabil.
  - Enkripsi token di rest (*at-rest*) menggunakan **AES-256-GCM**.
- **Otorisasi RBAC Fail-Closed**:
  - Penegakan peran berjenjang (`Viewer`, `Developer`, `Maintainer`, `Admin`) dengan pembatasan channel dan guild allowlist.
  - Tombol konfirmasi dua langkah terikat identitas pemanggil (*actor-bound*) dengan batas waktu TTL 60 detik dan *optimistic locking*.
- **Webhook GitHub & Durable Outbox**:
  - Endpoint `POST /webhooks/github` dengan verifikasi signature HMAC SHA-256 waktu konstan (`crypto.timingSafeEqual`) pada Buffer mentah.
  - Antrean SQLite outbox dengan deduplikasi atomik untuk mencegah spam notifikasi.
  - Penekanan ketat terhadap mention massal (`@everyone` dan `@here`).
- **Penjadwal Ringkasan Harian (Daily Digest)**:
  - Ringkasan metrik proyek otomatis setiap hari kerja pukul 09:00 WIB (`Asia/Jakarta`) yang kebal dari pengiriman ganda saat container di-restart (*distributed lease lock*).
- **Deployment Siap Produksi (VPS & Docker)**:
  - Multi-stage Dockerfile berbasis Debian Bookworm Slim, user non-root `node` (UID 1000), supervisor PID 1 `dumb-init`, dan healthcheck native.
  - Skrip operasional idempoten (`preflight.sh`, `build.sh`, `up.sh`, `health.sh`, `backup.sh`, `restore.sh`).

---

## Panduan Cepat (Quick Start)

### 1. Instalasi & Pengujian Lokal
```bash
# Clone repositori
git clone https://github.com/ekyaaa/dc-bot-project-management.git
cd dc-bot-project-management

# Install dependensi
npm ci

# Jalankan seluruh 504 test suite
npm test

# Jalankan kompilasi TypeScript
npm run build
```

### 2. Deployment Docker Compose di Server VPS
```bash
# 1. Salin konfigurasi environment
cp .env.example .env
chmod 600 .env

# 2. Siapkan folder secrets
mkdir -p secrets
chmod 700 secrets
openssl rand -hex 32 > secrets/token-encryption-key.txt
chmod 600 secrets/token-encryption-key.txt

# 3. Jalankan preflight checks
./scripts/deploy/preflight.sh

# 4. Build dan jalankan container
./scripts/deploy/build.sh
./scripts/deploy/up.sh

# 5. Verifikasi kesehatan
./scripts/deploy/health.sh
```

---

## Dokumentasi Lengkap

Dokumentasi komprehensif dalam Bahasa Indonesia tersedia di direktori [`docs/discord-bot/`](docs/discord-bot/):

| Dokumen | Deskripsi |
|---|---|
| [ONE_TIME_ADMIN_SETUP.md](docs/discord-bot/ONE_TIME_ADMIN_SETUP.md) | Checklist praktis konfigurasi awal satu kali untuk operator. |
| [GITHUB_APP_SETUP.md](docs/discord-bot/GITHUB_APP_SETUP.md) | Panduan pembuatan GitHub App dan izin repositori. |
| [DISCORD_APP_SETUP.md](docs/discord-bot/DISCORD_APP_SETUP.md) | Panduan pembuatan Discord Developer App & Bot Token. |
| [COMMANDS.md](docs/discord-bot/COMMANDS.md) | Daftar lengkap 15 slash command, parameter, dan alur konfirmasi. |
| [ACCESS_POLICY.md](docs/discord-bot/ACCESS_POLICY.md) | Aturan otorisasi RBAC, state machine, dan matriks izin. |
| [ENVIRONMENT.md](docs/discord-bot/ENVIRONMENT.md) | Referensi variabel lingkungan dan dukungan file secret. |
| [DEPLOY_VPS_DOCKER.md](docs/discord-bot/DEPLOY_VPS_DOCKER.md) | Panduan deployment, update versi, dan manajemen container di VPS. |
| [BACKUP_RESTORE.md](docs/discord-bot/BACKUP_RESTORE.md) | Prosedur online backup SQLite (`VACUUM INTO`) dan restore. |
| [SECURITY.md](docs/discord-bot/SECURITY.md) | Kebijakan mitigasi ancaman, anti-CSRF, dan proteksi webhook. |
| [OPERATIONS.md](docs/discord-bot/OPERATIONS.md) | Panduan pemantauan healthcheck, audit log, dan rotasi kredensial. |
| [TROUBLESHOOTING.md](docs/discord-bot/TROUBLESHOOTING.md) | Panduan pemecahan masalah dan kode error umum. |
| [TEST_REPORT.md](docs/discord-bot/TEST_REPORT.md) | Laporan hasil 504 pengujian otomatis dan pengujian adversarial. |

---

## Lisensi

Didistribusikan di bawah lisensi MIT. Lihat `LICENSE` untuk informasi lebih lanjut.
