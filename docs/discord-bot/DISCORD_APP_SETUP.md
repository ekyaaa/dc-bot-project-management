# Panduan Konfigurasi Discord Developer Application & Bot

Panduan ini memandu pembuatan Discord Application, pembuatan Bot Token, registrasi Application Commands, serta pemasangan (*invite*) bot ke server Discord Anda.

---

## 1. Pembuatan Application di Discord Portal

1. Kunjungi **Discord Developer Portal**: `https://discord.com/developers/applications`
2. Login dengan akun Discord Anda.
3. Klik tombol **"New Application"** di pojok kanan atas.
4. Masukkan nama aplikasi (misal: `Project Management Bot`) dan centang persetujuan Terms of Service, lalu klik **Create**.
5. Pada menu **General Information**:
   * Salin **APPLICATION ID** ➔ Simpan untuk variabel `DISCORD_APPLICATION_ID` di `.env`.

---

## 2. Pengaturan Bot & Token

1. Buka menu **Bot** di bilah navigasi kiri.
2. Di bagian **Build-A-Bot**:
   * Ubah username bot atau avatar jika diinginkan.
3. Klik tombol **"Reset Token"** untuk membuat token baru.
4. Salin token yang dihasilkan ➔ Simpan untuk variabel `DISCORD_BOT_TOKEN` di `.env`.
   * **PERINGATAN KEAMANAN**: Token ini memiliki akses penuh ke bot Anda. Jangan pernah membagikannya atau commit ke Git!
5. Pada bagian **Privileged Gateway Intents**:
   * **Message Content Intent**: **TIDAK PERLU DIAKTIFKAN** (Bot MVP beroperasi sepenuhnya via slash commands, modal, dan button interactions).
   * **Server Members Intent**: Opsional / Tidak diperlukan.

---

## 3. Menghasilkan URL Undangan (Bot Invite Link)

1. Buka menu **OAuth2** ➔ **URL Generator** di bilah navigasi kiri.
2. Di bagian **SCOPES**, centang:
   * `bot`
   * `applications.commands`
3. Di bagian **BOT PERMISSIONS** yang muncul di bawah, centang izin minimum:
   * **Send Messages**
   * **Embed Links**
   * **Attach Files**
   * **Read Message History**
   * **Use Slash Commands** (otomatis tercakup dalam `applications.commands`)
4. Salin URL yang dihasilkan di bagian paling bawah halaman:
   `https://discord.com/oauth2/authorize?client_id=<YOUR_APP_ID>&scope=bot%20applications.commands&permissions=277025507328`
5. Buka URL tersebut di browser, pilih server Discord (Guild) tujuan Anda, dan klik **Authorize**.

---

## 4. Mendapatkan Guild ID & Channel ID

1. Di aplikasi Discord Anda, buka **User Settings** ➔ **Advanced** ➔ aktifkan **Developer Mode**.
2. Klik kanan pada nama server Discord Anda di daftar server sebelah kiri, lalu pilih **"Copy Server ID"** ➔ Simpan untuk variabel `DISCORD_GUILD_ID`.
3. Klik kanan pada channel teks khusus yang ingin dijadikan tempat notifikasi proyek (misal: `#project-alerts`), lalu pilih **"Copy Channel ID"** ➔ Simpan untuk variabel `DISCORD_NOTIFICATION_CHANNEL_ID`.
