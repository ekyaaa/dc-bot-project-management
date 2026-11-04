# Katalog Slash Commands — Discord Project Management Bot

Dokumen ini mendokumentasikan seluruh perintah slash (*application slash commands*), hak akses yang diperlukan, parameter, alur interaksi, serta format respons.

---

## 1. Perintah Kueri (Read-Only)

Semua perintah kueri bersifat aman (*non-destructive*), mendukung penundaan interaksi otomatis (*automatic deferral*), dan menampilkan daftar panjang menggunakan navigasi halaman tombol interaktif (*interactive pagination*).

| Perintah | Deskripsi | Parameter | Tingkat Akses | Respons Default |
|---|---|---|---|---|
| `/project status` | Menampilkan ringkasan status backlog, task in-progress, review, dan blockers pada GitHub Project. | — | Viewer | Publik di channel |
| `/project issues` | Menampilkan daftar issue proyek dengan filter status dan assignee. | `status` (opsional), `assignee` (opsional), `limit` (1-25) | Viewer | Publik di channel |
| `/project mine` | Menampilkan seluruh task yang ditugaskan kepada akun GitHub pemanggil. | — | Developer (Linked) | **Ephemeral** (Hanya pemanggil yang melihat) |
| `/project blocked` | Menampilkan seluruh issue yang sedang berstatus Blocked beserta alasannya. | — | Viewer | Publik di channel |
| `/project unassigned` | Menampilkan issue open yang belum memiliki assignee untuk segera diambil. | — | Viewer | Publik di channel |
| `/project reviews` | Menampilkan daftar Pull Request yang membutuhkan tinjauan code review. | — | Viewer | Publik di channel |
| `/project digest` | Memunculkan ringkasan metrik proyek harian secara langsung (*on-demand*). | — | Viewer | Publik di channel |
| `/issue view` | Melihat detail lengkap suatu issue, status Project, label, dan link GitHub resmi. | `number` (Wajib, Integer) | Viewer | Publik di channel |
| `/help` | Menampilkan panduan penggunaan perintah bot, alur kerja, dan informasi otorisasi. | — | Semua Member | Ephemeral |

---

## 2. Perintah Penautan Akun (Identity Linking)

| Perintah | Deskripsi | Alur Kerja | Respons |
|---|---|---|---|
| `/account connect` | Menghubungkan akun Discord pemanggil dengan identitas GitHub terverifikasi via OAuth 2.0 PKCE. | Bot membuat state satu kali pakai, menyimpan `code_verifier`, dan mengembalikan tautan otorisasi unik dengan TTL 10 menit. | Ephemeral |
| `/account status` | Memeriksa status koneksi akun GitHub, username login terhubung, ID numerik stabil, dan perizinan. | Mengecek database SQLite lokal dan memverifikasi token yang tersimpan di rest. | Ephemeral |
| `/account disconnect` | Memutuskan tautan akun Discord dengan GitHub dan menghapus token lokal terenkripsi secara permanen. | Membatalkan relasi identitas di SQLite dan mencatat log audit pemutusan. | Ephemeral |

---

## 3. Perintah Tulis Terkendali (Controlled Write)

Setiap perintah tulis mewajibkan akun penaut terverifikasi, mengecek izin repository melalui GitHub App, dan menampilkan **modal dialog / pratinjau diff konfirmasi dua langkah** (*two-step confirmation*) sebelum data dimutasi di GitHub.

### 3.1 `/issue create`
* **Deskripsi**: Membuka modal dialog interaktif Discord untuk membuat issue baru di repository.
* **Input Modal**:
  * Judul Task (Maks. 256 karakter).
  * Deskripsi & Acceptance Criteria (Format markdown terstruktur).
  * Tipe Issue (Bug, Feature, Task, Chore).
* **Konfirmasi**: Pratinjau issue ditampilkan dengan tombol konfirmasi sebelum di-publish ke GitHub API.

### 3.2 `/issue assign`
* **Deskripsi**: Menugaskan issue kepada developer yang terdaftar.
* **Parameter**: `number` (Nomor issue), `developer` (Username GitHub atau mention Discord user yang sudah terhubung).
* **Validasi**: Memverifikasi bahwa developer tujuan benar-benar terdaftar sebagai kolaborator repositori.

### 3.3 `/issue status`
* **Deskripsi**: Mengubah kolom status kanonikal pada GitHub Projects v2.
* **Parameter**: `number` (Nomor issue), `status` (`Backlog`, `Ready`, `In Progress`, `In Review`, `Done`).
* **Aturan State Machine**: Transisi status ilegal (seperti melompati review langsung ke *Done*) akan ditolak dengan penjelasan kesalahan.

### 3.4 `/issue priority`
* **Deskripsi**: Mengubah tingkat urgensi/prioritas task pada GitHub Projects v2.
* **Parameter**: `number` (Nomor issue), `priority` (`P0 - Critical`, `P1 - High`, `P2 - Medium`, `P3 - Low`).

### 3.5 `/issue block`
* **Deskripsi**: Menandai issue sebagai terhambat (*Blocked*) dan mewajibkan catatan kendala.
* **Parameter**: `number` (Nomor issue), `reason` (Alasan blocker secara jelas).
* **Efek**: Status diubah ke `Blocked` dan alasan dicatat sebagai komentar terstruktur pada issue GitHub.

### 3.6 `/issue comment`
* **Deskripsi**: Menambahkan komentar teks pada issue GitHub langsung dari Discord.
* **Parameter**: `number` (Nomor issue), `text` (Isi komentar, dibatasi maks. 2000 karakter dan disanitasi).

---

## 4. Perilaku Tombol Konfirmasi (Confirmation Buttons UX)

Pada setiap operasi tulis:
1. Bot mengirimkan pesan pratinjau diff dengan dua tombol: **"Konfirmasi"** (Warna Hijau) dan **"Batalkan"** (Warna Abu-abu).
2. **Actor-Bound**: Hanya pengguna Discord yang memicu perintah awal yang diizinkan mengklik tombol. Jika pengguna lain mengklik, bot merespons: *"Interaksi ini hanya dapat dikonfirmasi oleh pemohon asli."*
3. **Masa Berlaku (TTL 60 Detik)**: Tombol otomatis kedaluwarsa setelah 60 detik untuk mencegah mutasi state yang sudah basi (*stale state*).
4. **Optimistic Locking**: Sebelum mutasi dieksekusi, bot mengambil kembali data terbaru dari GitHub untuk memastikan data tidak diubah oleh orang lain di GitHub web UI.
