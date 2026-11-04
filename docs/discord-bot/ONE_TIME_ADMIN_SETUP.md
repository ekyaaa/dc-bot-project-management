# Panduan Administrasi Awal Satu Kali (One-Time Admin Setup)

Panduan praktis berurutan (*checklist*) bagi operator atau tim DevOps untuk mengonfigurasi credential, domain, reverse proxy HTTPS, dan deployment pertama bot di server VPS Linux.

---

## Ringkasan Checklist Cepat

- [ ] 1. Discord Application dibuat & token bot tersimpan.
- [ ] 2. Bot diundang ke Server Discord target dengan scope `bot` & `applications.commands`.
- [ ] 3. GitHub App dibuat, diinstal ke repositori target, dan private key PEM diunduh.
- [ ] 4. Domain / Subdomain publik telah mengarah (DNS A Record) ke IP VPS.
- [ ] 5. Reverse proxy HTTPS (Nginx / Caddy / Traefik) dikonfigurasi untuk mem-forward traffic ke port 3000.
- [ ] 6. File `.env` dan direktori `secrets/` diisi di server VPS dengan izin `chmod 600`.
- [ ] 7. Menjalankan script `./scripts/deploy/preflight.sh` untuk validasi menyeluruh.
- [ ] 8. Menjalankan `./scripts/deploy/up.sh` untuk menyalakan container.
- [ ] 9. Uji coba fungsionalitas di channel Discord target.

---

## Langkah 1: Persiapan Domain & Reverse Proxy HTTPS

Webhook GitHub dan alur OAuth 2.0 PKCE mewajibkan endpoint HTTPS publik yang valid.

### Contoh Konfigurasi Caddyfile (Rekomendasi Caddy - Otomatis SSL Let's Encrypt):
```caddy
bot.example.com {
    reverse_proxy 127.0.0.1:3000

    # Batasi ukuran body webhook maksimum 5 MB
    request_body {
        max_size 5MB
    }

    # Security headers
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
    }
}
```

### Contoh Konfigurasi Nginx:
```nginx
server {
    server_name bot.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    listen 443 ssl;
    # SSL certificates via certbot
}
```

---

## Langkah 2: Setup File Secrets & Kunci Enkripsi di VPS

Di server VPS Anda, buat direktori rahasia dengan izin ketat:

```bash
mkdir -p secrets data
chmod 700 secrets data

# 1. Tempatkan Private Key PEM GitHub App
cp /path/to/github-app.private-key.pem secrets/github-app-private-key.pem
chmod 600 secrets/github-app-private-key.pem

# 2. Buat Kunci Enkripsi Token AES-256 (32 Bytes acak berupa string hex 64 karakter)
openssl rand -hex 32 > secrets/token-encryption-key.txt
chmod 600 secrets/token-encryption-key.txt
```

---

## Langkah 3: Konfigurasi File `.env` di VPS

Salin template placeholder `.env.example` ke `.env`:

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Isi nilai-nilai variabel yang diperlukan:
* `PUBLIC_BASE_URL`: URL domain HTTPS Anda (misal: `https://bot.example.com`).
* `DISCORD_APPLICATION_ID`: ID Aplikasi Discord Anda.
* `DISCORD_GUILD_ID`: ID Server Discord target.
* `DISCORD_NOTIFICATION_CHANNEL_ID`: ID Channel Discord tempat notifikasi diposting.
* `DISCORD_BOT_TOKEN`: Token Bot Discord.
* `GITHUB_APP_ID`: App ID GitHub App.
* `GITHUB_APP_CLIENT_ID`: Client ID GitHub App.
* `GITHUB_APP_CLIENT_SECRET`: Client Secret GitHub App.
* `GITHUB_APP_INSTALLATION_ID`: Installation ID GitHub App pada repositori.
* `GITHUB_WEBHOOK_SECRET`: Secret webhook yang sama dengan yang diisi di GitHub Developer portal.
* `GITHUB_OWNER`: Nama akun/organisasi pemilik repositori (misal: `mashupsoat`).
* `GITHUB_REPOSITORY`: Nama repositori GitHub (misal: `dc-bot-project-management`).
* `GITHUB_PROJECT_NUMBER`: Nomor GitHub Projects v2 (misal: `1`).

---

## Langkah 4: Validasi & Peluncuran

Jalankan script pemeriksaan pra-deploy:

```bash
./scripts/deploy/preflight.sh
```

Jika semua status `[OK]`, jalankan container:

```bash
./scripts/deploy/build.sh
./scripts/deploy/up.sh
```

Periksa status kesehatan container:

```bash
./scripts/deploy/health.sh
```

---

## Langkah 5: Smoke Test Interaksi Pertama

1. Buka channel Discord terdaftar.
2. Ketik `/help` ➔ Pastikan bot merespons daftar perintah lengkap.
3. Ketik `/account connect` ➔ Buka tautan untuk menautkan akun GitHub Anda.
4. Ketik `/project status` ➔ Pastikan data GitHub Projects v2 tampil dengan benar.
5. Buat komentar uji coba di salah satu issue GitHub ➔ Pastikan notifikasi muncul di channel Discord.
