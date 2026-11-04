# Panduan Konfigurasi GitHub App

Integrasi bot dengan repositori dan GitHub Projects v2 menggunakan **GitHub App**, bukan token personal (*Personal Access Token* / PAT). Panduan langkah demi langkah ini menjelaskan pembuatan dan pengaturannya.

---

## 1. Pembuatan GitHub App

1. Masuk ke GitHub, buka **Settings** akun atau organisasi Anda:
   * Akun Personal: `https://github.com/settings/apps`
   * Akun Organisasi: `https://github.com/organizations/<YOUR_ORG>/settings/apps`
2. Klik tombol **"New GitHub App"**.
3. Isi kolom identitas dasar:
   * **GitHub App name**: `discord-project-management-bot` (atau nama unik pilihan Anda).
   * **Homepage URL**: URL domain publik bot Anda (misal: `https://bot.example.com`).
   * **Callback URL**: `https://<YOUR_DOMAIN>/auth/github/callback` (Wajib HTTPS).
   * **Request user authorization (OAuth) during installation**: Centang opsi ini.

---

## 2. Pengaturan Webhook

1. Pada bagian **Webhook**:
   * Centang **Active**.
   * **Webhook URL**: `https://<YOUR_DOMAIN>/webhooks/github`
   * **Webhook secret**: Buat string acak berkekuatan tinggi (minimal 32 karakter). Simpan nilai ini untuk variabel `GITHUB_WEBHOOK_SECRET` di file `.env`.
   * **SSL verification**: Pilih **Enable SSL verification**.

---

## 3. Konfigurasi Izin (Permissions)

Pilih hak akses seminimal mungkin (*Least Privilege Principle*):

### Repository Permissions
* **Issues**: `Read and write` (Untuk membaca, membuat, assign, dan memberi komentar issue).
* **Pull requests**: `Read-only` (Untuk memantau permintaan review PR).
* **Metadata**: `Read-only` (Otomatis aktif, untuk informasi dasar repositori).

### Organization Permissions (Jika terpasang di tingkat organisasi)
* **Projects**: `Read and write` (Untuk membaca dan memperbarui kolom status/prioritas di GitHub Projects v2).

### Subscribe to Events (Webhook Events)
Centang event berikut:
* `Issues` (Untuk event opened, closed, assigned, labeled)
* `Issue comment` (Untuk diskusi komentar)
* `Pull request` (Untuk review requested, ready for review)
* `Workflow run` / `Check suite` (Untuk alert kegagalan CI)
* `Projects v2 item` (Untuk sinkronisasi perubahan status Project)

---

## 4. Pembuatan Private Key & Credential

1. Setelah GitHub App dibuat, catat:
   * **App ID**: Salin angka App ID (misal: `123456`) ➔ `GITHUB_APP_ID`.
   * **Client ID**: Salin Client ID ➔ `GITHUB_APP_CLIENT_ID`.
2. Pada bagian **Client secrets**:
   * Klik **"Generate a new client secret"**.
   * Salin secret yang muncul ➔ `GITHUB_APP_CLIENT_SECRET`.
3. Pada bagian **Private keys**:
   * Klik **"Generate a private key"**.
   * File `.pem` akan otomatis terunduh ke komputer Anda (misal: `discord-bot.2026-11-04.private-key.pem`).
   * **PENTING**: Jangan pernah commit file `.pem` ke repositori Git! Simpan file ini di server pada path aman (misal: `secrets/github-app-private-key.pem`) dengan izin `chmod 600`.

---

## 5. Instalasi GitHub App ke Repositori Target

1. Di menu sebelah kiri GitHub App, klik **"Install App"**.
2. Pilih akun atau organisasi tujuan.
3. Pilih opsi **"Only select repositories"** dan pilih repositori yang ingin dikelola.
4. Klik **Install**.
5. Setelah instalasi selesai, perhatikan URL browser:
   `https://github.com/settings/installations/<INSTALLATION_ID>`
   * Angka di akhir URL adalah **Installation ID** Anda ➔ `GITHUB_APP_INSTALLATION_ID`.
