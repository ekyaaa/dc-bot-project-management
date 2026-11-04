# Panduan & Kebijakan Keamanan (Security Policy)

Dokumen ini menjelaskan postur keamanan, mitigasi vektor serangan umum (*threat mitigation*), perlindungan rahasia (*secrets hygiene*), dan praktik audit keamanan yang diterapkan pada Discord Project Management Bot.

---

## 1. Perlindungan Rahasia & Kredensial

* **Kunci Terisolasi dari Git**: File `.env` dan direktori `secrets/` diatur dalam `.gitignore` dan `.dockerignore`.
* **Zero Hardcoded Secrets**: Pengujian unit dan integrasi menggunakan fixtures dan mock transports. Tidak ada token bot atau private key nyata di dalam source code repositori.
* **Redaksi Log Otomatis**: Audit trail menyaring string otentikasi, bearer tokens, dan private key sebelum dicatat ke database SQLite.
* **Enkripsi Data at Rest**: Token akses GitHub pengguna disimpan dalam tabel `account_links` dengan enkripsi **AES-256-GCM** menggunakan kunci independen yang dimount melalui Docker secret file terpisah.

---

## 2. Pertahanan Vektor Serangan Webhook GitHub

* **HMAC SHA-256 Signature Verification**: Header `X-Hub-Signature-256` wajib ada pada setiap request webhook.
* **Raw Body Buffer Comparison**: Digest dihitung dari byte mentah Buffer asli (sebelum di-parse oleh parser JSON Fastify) untuk mencegah ketidakcocokan serialisasi.
* **Constant-Time Comparison**: Komparasi signature menggunakan `crypto.timingSafeEqual` untuk mencegah serangan analisis waktu (*timing attack*).
* **Idempotency & Replay Protection**: Header `X-GitHub-Delivery` unik disimpan dalam tabel SQLite `outbox_events` dengan constraint `UNIQUE`. Upaya pengiriman ulang payload yang sama ditolak/diabaikan secara idempoten (HTTP 200).

---

## 3. Pertahanan Alur OAuth 2.0 & Identity Linking

* **RFC 7636 PKCE (Proof Key for Code Exchange)**: Menggunakan `code_challenge` SHA-256 dan `code_verifier` acak dengan entropi tinggi (64 byte hex) untuk memvalidasi pertukaran kode otorisasi.
* **Anti-CSRF State**: Parameter `state` acak dibuat dengan TTL pendek (10 menit) dan dicatat dalam tabel `oauth_states`.
* **Single-Use State**: State dihapus seketika setelah pertama kali diverifikasi. Upaya memutar ulang callback OAuth yang sama akan langsung ditolak (*replay protection*).
* **Strict Redirect URL Matching**: Callback hanya diterima pada path resmi `/auth/github/callback` dengan domain dasar yang dikonfigurasi pada `PUBLIC_BASE_URL`.

---

## 4. Keamanan Antarmuka Discord

* **Guild Allowlisting**: Bot secara aktif mengabaikan interaksi dan event yang berasal dari luar Guild ID yang diizinkan (`DISCORD_GUILD_ID`).
* **Mention Sanitization Fail-Closed**: Pesan notifikasi Discord menetapkan `allowedMentions: { parse: [] }`. Bot dilarang keras melakukan ping `@everyone`, `@here`, atau mention role massal yang berpotensi menjadi celah spam atau eskalasi izin.
* **Actor-Bound Confirmation Buttons**: Tombol interaksi untuk mutasi data dikunci pada `actor_discord_id` pemanggil. Pengguna lain di server tidak dapat memicu aksi dengan menekan tombol orang lain.

---

## 5. Keamanan Container & Runtime

* **Non-Root Execution**: Container berjalan sebagai user tidak berhak istimewa `node:node` (UID 1000).
* **Minimal Attack Surface**: Menggunakan image base Debian Bookworm Slim, tanpa compiler di layer final runner, dan tanpa dependensi dev.
* **Supervisi Sinyal PID 1**: Menggunakan `dumb-init` untuk menangani sinyal sistem (`SIGTERM`, `SIGINT`) dan mencegah proses zombie di dalam container.
