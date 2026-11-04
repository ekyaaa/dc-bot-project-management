# Panduan Deployment di VPS Linux dengan Docker Compose

Panduan teknis bagi operator untuk melakukan deployment, update versi (*rolling update*), monitoring kontainer, dan manajemen resource di server VPS berbasis Linux (Ubuntu, Debian, dsb).

---

## 1. Persyaratan Sistem VPS

* **Sistem Operasi**: Linux x86_64 / arm64 (Ubuntu 22.04 LTS / 24.04 LTS atau Debian 12 direkomendasikan).
* **Resource Minimum**: 1 vCPU, 1 GB RAM, 10 GB Disk SSD.
* **Perangkat Lunak Terpasang**:
  * Docker Engine v24+ & Docker Compose v2 (plugin `docker compose`).
  * Reverse proxy HTTPS (Caddy atau Nginx).
  * Port 80 & 443 terbuka ke internet publik; port 3000 **hanya boleh diakses oleh localhost / reverse proxy**.

---

## 2. Struktur Direktori Deployment di VPS

Struktur tata letak file di server VPS yang disarankan:

```text
/opt/dc-bot/
├── compose.yaml                 # Spesifikasi Docker Compose
├── .env                         # Konfigurasi lingkungan (chmod 600)
├── secrets/                     # Direktori file rahasia (chmod 700)
│   ├── github-app-private-key.pem   (chmod 600)
│   └── token-encryption-key.txt     (chmod 600)
├── data/                        # Volume data persisten host jika tidak pakai named volume
│   └── backups/                 # Arsip snapshot backup database
└── scripts/
    └── deploy/                  # Script automasi preflight, build, up, health, backup, restore
```

---

## 3. Alur Deployment Pertama Kali

```bash
# 1. Masuk ke direktori aplikasi di VPS
cd /opt/dc-bot

# 2. Pastikan file secret dan .env sudah siap
ls -la .env secrets/

# 3. Jalankan preflight check
./scripts/deploy/preflight.sh

# 4. Build image lokal
./scripts/deploy/build.sh

# 5. Jalankan container
./scripts/deploy/up.sh

# 6. Pantau status container
docker compose ps
docker compose logs -f bot
```

---

## 4. Alur Pembaruan Versi (Update / Re-deploy)

Untuk mengupdate kode bot ke versi terbaru tanpa kehilangan data SQLite yang tersimpan:

```bash
# 1. Buat backup database terlebih dahulu demi keamanan
./scripts/deploy/backup.sh

# 2. Tarik kode terbaru dari git
git pull origin main

# 3. Build image baru
./scripts/deploy/build.sh

# 4. Restart container secara tertib (graceful shutdown WAL checkpoint flush)
./scripts/deploy/up.sh

# 5. Verifikasi kesehatan bot setelah update
./scripts/deploy/health.sh
```

---

## 5. Konfigurasi Resource Limits & Log Rotation

Pada `compose.yaml`, resource container telah dibatasi untuk menjamin stabilitas VPS:
* **Memory Limit**: 512 MB (Reservation: 128 MB). Mencegah bot memicu Out-Of-Memory (OOM) killer yang dapat memengaruhi service lain di VPS.
* **CPU Limit**: 1.0 vCPU (Reservation: 0.25 vCPU).
* **Log Rotation**: Maksimal 3 file log berukuran masing-masing 10 MB (`max-size: "10m"`, `max-file: "3"`). Log Docker tidak akan pernah memenuhi ruang penyimpanan disk VPS.
