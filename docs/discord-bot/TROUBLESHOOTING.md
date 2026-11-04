# Panduan Pemecahan Masalah (Troubleshooting Guide)

Daftar masalah umum, pesan error yang sering dijumpai, penyebab utama, serta langkah-langkah solutif untuk mengatasinya.

---

## 1. Masalah Otentikasi & Koneksi Discord

### Gejala: Bot tidak muncul online di Discord
* **Penyebab**: Token bot salah atau bot tidak dapat terhubung ke Gateway WebSocket Discord.
* **Solusi**:
  1. Periksa log: `docker compose logs bot | grep DiscordGateway`.
  2. Pastikan `DISCORD_BOT_TOKEN` di file `.env` tidak memiliki spasi ekstra atau karakter kutip yang tidak perlu.
  3. Pastikan VPS memiliki koneksi internet outbound ke `gateway.discord.gg:443`.

### Gejala: Slash command tidak muncul di Server Discord
* **Penyebab**: Registrasi slash command guild membutuhkan waktu atau Guild ID tidak sesuai.
* **Solusi**:
  1. Pastikan `DISCORD_GUILD_ID` pada `.env` persis sama dengan ID Server Discord tempat bot berada.
  2. Periksa log bot saat startup: cari baris `[CommandRegistry] Successfully registered 4 commands to guild...`.
  3. Refresh aplikasi Discord (tekan `Ctrl+R` di desktop atau restart aplikasi Discord di mobile).

### Gejala: "This interaction failed" pada Discord
* **Penyebab**: Bot tidak melakukan penundaan respons (`deferReply`) dalam batas waktu 3 detik Discord saat memproses request ke GitHub.
* **Solusi**:
  1. Seluruh handler telah dilengkapi mekanisme deferral otomatis. Jika error ini terjadi, periksa log: `docker compose logs bot | grep InteractionRouter`.
  2. Pastikan waktu jam sistem VPS sinkron (NTP active): `timedatectl`.

---

## 2. Masalah GitHub App & Webhook

### Gejala: Webhook merespons `HTTP 401 Unauthorized`
* **Penyebab**: Signature HMAC `X-Hub-Signature-256` tidak cocok dengan secret yang terpasang di bot.
* **Solusi**:
  1. Bandingkan nilai **Webhook Secret** di GitHub Developer Settings dengan variabel `GITHUB_WEBHOOK_SECRET` di `.env`. Keduanya wajib persis sama.
  2. Jika menggunakan Nginx / Caddy, pastikan reverse proxy tidak memodifikasi atau men-decode ulang request body raw Buffer.

### Gejala: Webhook tidak pernah sampai ke server bot
* **Penyebab**: Port firewall tertutup, DNS belum propagasi, atau sertifikat SSL tidak valid.
* **Solusi**:
  1. Buka tab **Recent Deliveries** pada pengaturan Webhook GitHub App Anda untuk melihat kode status respons HTTP.
  2. Uji endpoint secara manual dari luar VPS:
     ```bash
     curl -i -X POST https://bot.example.com/webhooks/github
     ```
     Jika mengembalikan `HTTP 401: Invalid signature`, artinya rute HTTPS berfungsi normal.

### Gejala: Error `Resource not accessible by integration` saat query GitHub Projects v2
* **Penyebab**: GitHub App belum diberikan izin membaca/menulis Projects di level Organisasi, atau belum diinstal ke repositori target.
* **Solusi**:
  1. Buka GitHub App ➔ Permissions ➔ Organization permissions ➔ ubah `Projects` menjadi `Read and write`.
  2. Buka Installed GitHub Apps ➔ Configure ➔ pastikan repositori yang bersangkutan sudah dicentang.

---

## 3. Masalah Database & Kunci SQLite

### Gejala: `SqliteError: database is locked`
* **Penyebab**: Dua proses mencoba menulis ke database SQLite secara bersamaan di luar transaksi pool atau ada backup manual yang memblokir file.
* **Solusi**:
  1. Arsitektur bot dirancang single-writer dalam mode WAL dengan `busyTimeout: 5000ms`.
  2. Pastikan tidak ada lebih dari 1 instance container bot yang aktif bersamaan: `docker compose ps`.
  3. Jika melakukan backup manual, selalu gunakan `./scripts/deploy/backup.sh` yang memakai perintah non-blocking `VACUUM INTO`.

---

## 4. Masalah Penautan Akun (OAuth PKCE)

### Gejala: Callback OAuth mengembalikan `Invalid or expired OAuth state`
* **Penyebab**: Pengguna menunggu lebih dari 10 menit sebelum menyetujui di GitHub, atau mencoba me-refresh link callback yang sudah pernah digunakan.
* **Solusi**:
  1. Minta pengguna mengetik ulang `/account connect` di Discord untuk mendapatkan tautan otorisasi baru.
  2. State hanya berlaku satu kali pakai demi mencegah serangan CSRF.
