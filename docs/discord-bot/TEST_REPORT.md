# Laporan Komprehensif Pengujian Sistem (Test & Verification Report)

Dokumen ini mencatat bukti verifikasi empiris, metrik pengujian, cakupan kode (*code coverage*), dan hasil pengujian adversarial pada **Discord Project Management Bot**.

---

## 1. Ringkasan Eksekutif Hasil Pengujian

| Metrik | Hasil Verifikasi | Status |
|---|:---:|:---:|
| **Total Test Suites** | 27 File Suite | LULUS (100%) |
| **Total Tests Dijalankan** | 504 Tests | LULUS (100%) |
| **Tes Gagal / Regresi** | 0 Tests | LULUS |
| **Kompilasi TypeScript (`tsc --noEmit`)** | 0 Type Errors | LULUS |
| **Kompilasi Produksi (`npm run build`)** | Output bersih ke `dist/` | LULUS |
| **Statement Code Coverage** | > 91.5% | LULUS |

---

## 2. Rincian 27 Test Suite Berdasarkan Modul

### 2.1 Domain & Aturan Inti
1. `tests/unit/domain.test.ts` (24 tests): Validasi entitas task, aturan transisi state kanonikal, validasi field custom project, dan deteksi transisi ilegal.
2. `tests/unit/config.test.ts` (10 tests): Validasi parsing variabel lingkungan dengan Zod, fallback nilai default, dan pemetaan file secret (`_FILE` / `_PATH`).
3. `tests/unit/crypto.test.ts` (16 tests): Enkripsi dan dekripsi token AES-256-GCM, verifikasi otentikasi tag GCM, dan pencegahan manipulasi ciphertext.
4. `tests/unit/persistence.test.ts` (8 tests): Migrasi skema SQLite v1-v3, operasi CRUD repository (`Identity`, `OAuthState`, `Outbox`, `Audit`, `Schedule`), dan transaksi WAL mode.
5. `tests/unit/health.test.ts` (5 tests): Endpoint Fastify `/health/live` dan `/health/ready`, status readiness saat database terkoneksi atau error.

### 2.2 Integrasi GitHub App & OAuth Identity Linking
6. `tests/unit/github.test.ts` (30 tests): Otentikasi JWT GitHub App, rotasi token instalasi, operasi REST Issues & Comments, query GraphQL GitHub Projects v2, dan mapping error API.
7. `tests/unit/oauth.test.ts` (20 tests): Siklus lengkap OAuth 2.0 PKCE, pembuatan `code_challenge`, validasi `state` satu kali pakai, pertukaran authorization code, dan route callback HTTP.
8. `tests/unit/authorization.test.ts` (21 tests): Penegakan hak akses berbasis peran (RBAC fail-closed), pengecekan izin kolaborator repositori, dan pembatasan mutasi task antar-user.
9. `tests/unit/audit.test.ts` (4 tests): Pencatatan audit trail mutasi data, pemfilteran token rahasia dari log, dan integritas urutan waktu kejadian.

### 2.3 Antarmuka Discord Slash Commands & Interaksi
10. `tests/unit/discord_commands.test.ts` (44 tests): Registrasi slash command ke guild target, deferral interaksi instan (< 3 detik), routing command kueri dan tulis.
11. `tests/unit/discord_confirmations.test.ts` (12 tests): Tombol konfirmasi dua langkah terikat identitas pemanggil (*actor-bound*), kedaluwarsa TTL 60 detik, dan pencegahan klik dari pengguna lain.
12. `tests/unit/discord_pagination.test.ts` (7 tests): Navigasi halaman tombol interaktif (`Next` / `Previous`), penonaktifan tombol di batas halaman, dan batas 25 item per embed.
13. `tests/unit/discord_embeds.test.ts` (11 tests): Pembuatan rich embeds Discord yang rapi, pemformatan badge status/prioritas, tautan GitHub resmi, dan sanitasi teks.

### 2.4 Webhook, Notifikasi & Penjadwal Digest
14. `tests/unit/webhooks.test.ts` (12 tests): Endpoint Fastify `POST /webhooks/github`, verifikasi signature HMAC SHA-256 waktu konstan, penolakan payload tanpa signature (401), dan penanganan event ping.
15. `tests/unit/notification_routing.test.ts` (21 tests): Perutean event GitHub (issue assigned, review requested, workflow failure) ke format embed Discord yang tepat.
16. `tests/unit/mention_security.test.ts` (19 tests): Penegakan `allowedMentions` ketat, supresi total `@everyone` / `@here`, dan pembatasan ping hanya ke pengguna GitHub yang terhubung.
17. `tests/unit/digest_scheduler.test.ts` (11 tests): Penjadwal Croner hari kerja pukul 09:00 WIB, verifikasi zona waktu `Asia/Jakarta`, dan pemanggilan use case digest.
18. `tests/integration/notification_outbox.test.ts` (6 tests): Worker outbox asinkron, pemrosesan antrean per batch, *exponential backoff*, dan pengalihan ke status `DEAD_LETTER`.
19. `tests/integration/daily_digest_dedup.test.ts` (8 tests): Mekanisme *distributed lease lock* di SQLite, pencegahan pengiriman ganda digest saat container di-restart.

### 2.5 Containerization, Deployment & Runbooks
20. `tests/unit/runbooks.test.ts` (3 tests): Validasi seluruh script shell `scripts/deploy/*.sh` memiliki opsi `--help`, serta uji round-trip pencadangan konsisten `backup.sh` dan pemulihan `restore.sh` lengkap dengan dry-run dan verifikasi integritas SQLite.
21. `tests/unit/compose_validation.test.ts` (3 tests): Validasi spesifikasi `Dockerfile` multi-stage (Node 22, user `node`, dumb-init, healthcheck) dan `compose.yaml` (volume data, secrets mounts, memory limits, log rotation).

### 2.6 Pengujian Ketahanan Adversarial (Adversarial Suites)
22. `tests/adversarial/oauth.adversarial.test.ts` (34 tests): Serangan pemalsuan parameter `state`, eksploitasi replay callback OAuth, bypass PKCE verifier, dan validasi header keamanan HTTP (X-Frame-Options, CSP, HSTS).
23. `tests/adversarial/rbac_concurrency_audit.adversarial.test.ts` (52 tests): Eskalasi hak akses tidak sah, race condition pada mutasi status simultan (*optimistic locking conflict detection*), dan percobaan injeksi secret ke dalam audit log.
24. `tests/adversarial/discord_gateway_security.adversarial.test.ts` (37 tests): Panggilan command dari luar guild allowlist, injeksi karakter kontrol terminal pada modal issue, dan manipulasi interaction custom_id.
25. `tests/adversarial/m3_confirmations_concurrency.adversarial.test.ts` (23 tests): Pembajakan klik tombol konfirmasi oleh pengguna lain, klik ganda (*double-click race condition*), dan klik tombol setelah TTL 60 detik kedaluwarsa.
26. `tests/adversarial/m4_webhook_outbox_stress.test.ts` (27 tests): Manipulasi single-byte pada payload webhook HMAC, banjir replay 50-concurrency pengiriman event yang sama, dan penanganan backoff HTTP 429 Discord rate limit.
27. `tests/adversarial/m4_mention_digest_stress.test.ts` (36 tests): Vektor injeksi mention tersembunyi pada judul/body issue, serta simulasi restart container pada pukul 09:05 WIB yang membuktikan digest tidak dikirim dua kali.

---

## 3. Perintah Eksekusi Mandiri

Untuk memverifikasi seluruh laporan di atas secara mandiri:

```bash
# Jalankan seluruh 504 unit & integration test
npm test

# Jalankan pengujian beserta laporan coverage lengkap
npm run test:coverage

# Jalankan typecheck statis TypeScript
npm run typecheck

# Jalankan build kompilasi TypeScript
npm run build
```
Semua perintah di atas dipastikan lulus dengan **status exit code 0**.
