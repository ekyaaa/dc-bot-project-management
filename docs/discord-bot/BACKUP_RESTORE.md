# Panduan Pencadangan & Pemulihan Database (Backup & Restore)

Database bot menggunakan SQLite dalam mode WAL (*Write-Ahead Logging*). Dokumen ini menguraikan prosedur pencadangan konsisten tanpa downtime (*online zero-downtime backup*), rotasi retensi, dan pemulihan (*disaster recovery*).

---

## 1. Mekanisme Backup Konsisten (`VACUUM INTO`)

Untuk mencegah kerusakan data (*data corruption*) akibat meng-copy file `.db` yang sedang memiliki transaksi aktif di file `.db-wal`, pencadangan dilakukan melalui perintah bawaan SQLite:

```sql
VACUUM INTO '/path/to/backup.db';
```

Perintah ini menghasilkan snapshot database baru yang utuh, terkompresi, dan konsisten secara transaksional tanpa mengunci pembaca (*readers*) maupun penulis (*writers*).

---

## 2. Menjalankan Backup Manual

Gunakan script automasi yang telah disediakan:

```bash
# Melakukan backup default ke data/backups/
./scripts/deploy/backup.sh

# Melakukan backup dengan direktori kustom dan retensi 14 hari
./scripts/deploy/backup.sh --backup-dir /mnt/storage/backups --retention-days 14
```

Hasil backup disimpan dengan format nama:
`sqlite-backup-YYYYMMDD-HHMMSS.db` dengan izin file aman `chmod 600`.

---

## 3. Otomasi Backup Harian via Crontab Host

Untuk menjalankan backup otomatis setiap hari pada pukul 02:00 pagi:

1. Buka crontab pengguna di VPS:
   ```bash
   crontab -e
   ```
2. Tambahkan baris jadwal berikut:
   ```cron
   0 2 * * * /opt/dc-bot/scripts/deploy/backup.sh --backup-dir /opt/dc-bot/data/backups --retention-days 7 >> /var/log/dc-bot-backup.log 2>&1
   ```

Script otomatis menghapus backup yang lebih lama dari jumlah hari retensi yang ditentukan.

---

## 4. Prosedur Pemulihan Database (Restore / Disaster Recovery)

### 4.1 Simulasi Aman (Dry-Run Verification)
Sebelum menimpa database aktif, selalu jalankan verifikasi integritas backup terlebih dahulu:

```bash
./scripts/deploy/restore.sh --backup-file data/backups/sqlite-backup-20261104-090000.db --dry-run
```
Script akan menjalankan `PRAGMA integrity_check;` untuk memastikan file backup tidak korup dan valid.

### 4.2 Eksekusi Pemulihan Nyata
Jika integritas terkonfirmasi aman:

```bash
# 1. Hentikan container bot terlebih dahulu agar database tidak terkunci
docker compose stop bot

# 2. Jalankan restore
./scripts/deploy/restore.sh --backup-file data/backups/sqlite-backup-20261104-090000.db --force

# 3. Nyalakan kembali container bot
docker compose up -d bot

# 4. Verifikasi status kesehatan
./scripts/deploy/health.sh
```

> **Catatan Keamanan**: Script `restore.sh` secara otomatis membuat cadangan darurat (*safety pre-restore backup*) dari database aktif yang ada sebelum menimpanya dengan file backup (`bot.db.pre-restore-TIMESTAMP.bak`).
