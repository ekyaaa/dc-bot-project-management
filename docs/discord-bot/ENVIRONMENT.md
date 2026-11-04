# Referensi Variabel Lingkungan (Environment Variables)

Dokumen ini mendokumentasikan seluruh variabel konfigurasi yang didukung oleh bot, tipe data, nilai default, validasi Zod, dan cara pemetaan file secret (`_FILE` / `_PATH`).

---

## 1. Tabel Variabel Konfigurasi

| Nama Variabel | Tipe Data | Wajib | Nilai Default | Deskripsi |
|---|:---:|:---:|:---:|---|
| `NODE_ENV` | `string` | Tidak | `production` | Lingkungan runtime (`development`, `production`, `test`). |
| `PORT` | `number` | Tidak | `3000` | Port listening HTTP Fastify (health endpoints, webhook, OAuth callback). |
| `TZ` | `string` | Tidak | `Asia/Jakarta` | Zona waktu sistem untuk cron daily digest dan timestamp audit. |
| `PUBLIC_BASE_URL` | `url` | Ya | — | URL publik HTTPS reverse proxy (misal: `https://bot.example.com`). |
| `DATABASE_PATH` | `string` | Tidak | `/data/bot.db` | Path file database SQLite lokal atau mounted volume container. |
| `DISCORD_APPLICATION_ID` | `string` | Ya | — | ID Aplikasi Discord dari Developer Portal. |
| `DISCORD_GUILD_ID` | `string` | Ya | — | ID Server Discord (Guild) yang diizinkan (*allowlisted*). |
| `DISCORD_NOTIFICATION_CHANNEL_ID` | `string` | Ya | — | ID Channel Discord tujuan pengiriman notifikasi event dan digest. |
| `DISCORD_BOT_TOKEN` | `string` | Ya | — | Token autentikasi Bot Discord. |
| `GITHUB_APP_ID` | `number` | Ya | — | App ID GitHub App (misal: `123456`). |
| `GITHUB_APP_CLIENT_ID` | `string` | Ya | — | Client ID OAuth GitHub App. |
| `GITHUB_APP_CLIENT_SECRET` | `string` | Ya | — | Client Secret OAuth GitHub App. |
| `GITHUB_APP_INSTALLATION_ID` | `number` | Ya | — | Installation ID GitHub App pada repositori. |
| `GITHUB_WEBHOOK_SECRET` | `string` | Ya | — | Secret string HMAC SHA-256 untuk memvalidasi webhook payload. |
| `GITHUB_APP_PRIVATE_KEY` | `string` | Ya | — | Konten teks Private Key PEM GitHub App. |
| `GITHUB_OWNER` | `string` | Ya | — | Akun atau organisasi GitHub pemilik repositori. |
| `GITHUB_REPOSITORY` | `string` | Ya | — | Nama repositori target. |
| `GITHUB_PROJECT_NUMBER` | `number` | Tidak | — | Nomor GitHub Projects v2 (opsional jika hanya memakai Issues). |
| `TOKEN_ENCRYPTION_KEY` | `string` | Ya | — | Kunci enkripsi 32-bytes hex string (64 karakter) untuk AES-256-GCM. |
| `DIGEST_ENABLED` | `boolean` | Tidak | `true` | Mengaktifkan/menonaktifkan penjadwal otomatis daily digest. |
| `DIGEST_CRON_EXPRESSION` | `string` | Tidak | `0 9 * * 1-5` | Pola cron penjadwal (default: Senin-Jumat pukul 09:00 WIB). |
| `BOT_WRITE_ACTIONS_ENABLED`| `boolean` | Tidak | `true` | Feature flag untuk mematikan aksi tulis jika dalam masa darurat. |

---

## 2. Dukungan File Secret (`_FILE` dan `_PATH`)

Untuk mencegah secret berdampak tinggi (seperti Private Key PEM multi-line) diekspos melalui command line atau Docker inspect, bot secara otomatis mendukung pembacaan secret dari file disk:

* `GITHUB_APP_PRIVATE_KEY_FILE` atau `GITHUB_APP_PRIVATE_KEY_PATH`: Path file ke kunci PEM (misal: `/run/secrets/github_app_private_key`).
* `TOKEN_ENCRYPTION_KEY_FILE` atau `TOKEN_ENCRYPTION_KEY_PATH`: Path file ke file teks kunci enkripsi token.
* `DISCORD_BOT_TOKEN_FILE`: Path file ke token bot Discord.
* `GITHUB_APP_CLIENT_SECRET_FILE`: Path file ke client secret GitHub App.
* `GITHUB_WEBHOOK_SECRET_FILE`: Path file ke webhook secret.

Saat file tersebut ada, konten teksnya otomatis dimuat ke dalam memori aplikasi sebelum validasi skema Zod dijalankan.

---

## 3. Template `.env.example`

File `.env.example` yang di-track di Git berisi placeholder tanpa secret nyata:

```dotenv
NODE_ENV=production
PORT=3000
TZ=Asia/Jakarta
PUBLIC_BASE_URL=https://bot.example.com
DATABASE_PATH=/data/bot.db

DISCORD_APPLICATION_ID=REPLACE_ME
DISCORD_GUILD_ID=REPLACE_ME
DISCORD_NOTIFICATION_CHANNEL_ID=REPLACE_ME
DISCORD_BOT_TOKEN=REPLACE_ME

GITHUB_APP_ID=123456
GITHUB_APP_CLIENT_ID=REPLACE_ME
GITHUB_APP_CLIENT_SECRET=REPLACE_ME
GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_WEBHOOK_SECRET=REPLACE_ME_MIN_32_CHARS
GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github_app_private_key

GITHUB_OWNER=REPLACE_ME_OWNER
GITHUB_REPOSITORY=REPLACE_ME_REPO
GITHUB_PROJECT_NUMBER=1

TOKEN_ENCRYPTION_KEY_FILE=/run/secrets/token_encryption_key

DIGEST_ENABLED=true
DIGEST_CRON_EXPRESSION=0 9 * * 1-5
BOT_WRITE_ACTIONS_ENABLED=true
```
