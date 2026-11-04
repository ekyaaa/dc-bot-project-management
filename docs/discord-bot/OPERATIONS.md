# Panduan Operasional & Pemeliharaan (Operations Manual)

Panduan operasional harian bagi operator sistem untuk memantau performa, memeriksa log aktivitas, melakukan rotasi kredensial, dan menangani insiden.

---

## 1. Pemantauan Kesehatan (Healthchecks)

Bot menyediakan dua probe kesehatan HTTP:

### 1.1 Liveness Probe (`GET /health/live`)
* **URL**: `http://127.0.0.1:3000/health/live`
* **Status**: Mengembalikan `HTTP 200 OK` jika server HTTP aktif dan event loop Node.js responsif.
* **Payload**:
  ```json
  {
    "status": "ok",
    "uptimeSeconds": 1420.5,
    "timestamp": "2026-11-04T09:00:00.000Z"
  }
  ```

### 1.2 Readiness Probe (`GET /health/ready`)
* **URL**: `http://127.0.0.1:3000/health/ready`
* **Status**: Mengembalikan `HTTP 200 OK` jika koneksi database SQLite terbuka, tabel termigrasi, dan bot siap menerima trafik. Jika database terkunci atau korup, mengembalikan `HTTP 503 Service Unavailable`.
* **Payload**:
  ```json
  {
    "status": "ready",
    "database": "connected",
    "pendingOutboxCount": 0,
    "timestamp": "2026-11-04T09:00:00.000Z"
  }
  ```

Jalankan script pemeriksaan kapan saja:
```bash
./scripts/deploy/health.sh
```

---

## 2. Manajemen & Analisis Log

Untuk melihat log aktivitas real-time bot:

```bash
# Pantau log aktif
docker compose logs -f bot

# Tampilkan 100 baris log terakhir
docker compose logs --tail=100 bot

# Cari event error tertentu
docker compose logs bot | grep -i "error"
```

Semua log ditulis dalam format teks terstruktur dengan penanda modul:
* `[Main]`: Lifecycle aplikasi dan inisialisasi.
* `[DiscordGateway]`: Koneksi Gateway Discord, event shard, dan reconnect.
* `[InteractionRouter]`: Routing slash command, submit modal, dan klik button.
* `[NotificationService]`: Eksekusi pengiriman webhook event dan antrean outbox.
* `[DigestScheduler]`: Triggering ringkasan harian proyek.

---

## 3. Penanganan Insiden & Antrean Outbox Macet (Dead-Letter)

Jika pengiriman notifikasi ke Discord mengalami kegagalan berulang (misal: Discord API downtime):
1. Event akan dicoba ulang dengan mekanisme *exponential backoff*.
2. Jika mencapai batas percobaan maksimum (5 kali percobaan), status event diubah menjadi `DEAD_LETTER`.
3. Event dead-letter tidak akan memblokir antrean outbox event baru lainnya.
4. Operator dapat memeriksa jumlah event dead-letter melalui query SQLite lokal:
   ```bash
   sqlite3 /opt/dc-bot/data/bot.db "SELECT id, event_type, error_message FROM outbox_events WHERE status = 'DEAD_LETTER';"
   ```

---

## 4. Prosedur Rotasi Kredensial (Credential Rotation)

### 4.1 Rotasi Discord Bot Token
1. Kunjungi Discord Developer Portal ➔ Bot ➔ Klik **Reset Token**.
2. Perbarui nilai `DISCORD_BOT_TOKEN` pada file `.env` di VPS.
3. Jalankan restart container:
   ```bash
   ./scripts/deploy/up.sh
   ```

### 4.2 Rotasi GitHub App Private Key PEM
1. Di GitHub App settings ➔ Generate private key baru.
2. Tempatkan file PEM baru di `secrets/github-app-private-key.pem` pada VPS (`chmod 600`).
3. Jalankan restart container:
   ```bash
   ./scripts/deploy/up.sh
   ```
4. Setelah bot berhasil terhubung kembali, hapus private key lama di GitHub Developer Portal.

### 4.3 Rotasi Webhook Secret
1. Ubah secret webhook di GitHub App settings.
2. Perbarui `GITHUB_WEBHOOK_SECRET` di `.env`.
3. Jalankan restart container:
   ```bash
   ./scripts/deploy/up.sh
   ```
