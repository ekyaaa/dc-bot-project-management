# Kebijakan Akses & Otorisasi (Access Policy & RBAC)

Dokumen ini menguraikan model otorisasi berbasis peran (*Role-Based Access Control* / RBAC), pembatasan channel, verifikasi identitas, dan prinsip keamanan *fail-closed*.

---

## 1. Prinsip Dasar Keamanan

1. **Fail-Closed (Default Deny)**: Semua permintaan ditolak secara default kecuali ada aturan yang secara eksplisit mengizinkan.
2. **Guild & Channel Allowlist**: Bot hanya melayani interaksi dari Discord Guild ID dan Channel ID yang telah didaftarkan pada konfigurasi environment (`DISCORD_GUILD_ID` & `DISCORD_NOTIFICATION_CHANNEL_ID`).
3. **Identitas Terverifikasi**: Hak tulis tidak pernah diberikan hanya berdasarkan nama Discord atau role Discord lokal. Pengguna wajib menghubungkan akun GitHub melalui alur OAuth 2.0 PKCE resmi.
4. **ID Numerik Stabil**: Pemetaan identitas menggunakan **Numeric GitHub User ID** (misal: `12345678`), bukan username login, karena username GitHub dapat diubah oleh pengguna sewaktu-waktu.

---

## 2. Hirarki Peran Aplikasi (Application Roles)

| Peran | Deskripsi | Hak Akses yang Diizinkan |
|---|---|---|
| **Viewer** | Anggota tim read-only | Membaca status project, melihat daftar issue, filter issue, melihat detail issue, dan membaca daily digest. |
| **Developer** | Kontributor aktif dengan akun GitHub terhubung | Semua hak Viewer + membuat issue (`/issue create`), mengubah status task miliknya, menandai blocker, dan menambahkan komentar issue. |
| **Maintainer** | Pimpinan teknis atau lead tim | Semua hak Developer + mengubah status task anggota lain, mengubah prioritas issue (`/issue priority`), dan menugaskan kembali assignee (`/issue assign`). |
| **Admin** | Administrator sistem | Semua hak Maintainer + administrasi penautan akun, konfigurasi webhook, dan akses maintenance database. |

---

## 3. Matriks Matched Permissions

| Operasi | Viewer | Developer | Maintainer | Admin |
|---|:---:|:---:|:---:|:---:|
| `/project *` (Read Queries) | ✅ | ✅ | ✅ | ✅ |
| `/project mine` | ❌ (Wajib Link) | ✅ | ✅ | ✅ |
| `/issue view` | ✅ | ✅ | ✅ | ✅ |
| `/account connect / status` | ✅ | ✅ | ✅ | ✅ |
| `/issue create` | ❌ | ✅ | ✅ | ✅ |
| `/issue comment` | ❌ | ✅ | ✅ | ✅ |
| `/issue block` (Task Sendiri) | ❌ | ✅ | ✅ | ✅ |
| `/issue block` (Task Orang Lain) | ❌ | ❌ | ✅ | ✅ |
| `/issue status` (Task Sendiri) | ❌ | ✅ | ✅ | ✅ |
| `/issue status` (Task Orang Lain) | ❌ | ❌ | ✅ | ✅ |
| `/issue assign` | ❌ | ❌ | ✅ | ✅ |
| `/issue priority` | ❌ | ❌ | ✅ | ✅ |

---

## 4. Kebijakan Transisi Status (State Machine Policy)

Kanonikal status task mengikuti alur workflow pengembangan yang teratur:

```text
Backlog ───► Ready ───► In Progress ───► In Review ───► Done
                           ▲     │
                           │     ▼
                        Blocked
```

* **Aturan Transisi Valid**:
  * `Backlog` ➔ `Ready`
  * `Ready` ➔ `In Progress`
  * `In Progress` ➔ `In Review` atau `Blocked`
  * `Blocked` ➔ `In Progress` (Unblocking)
  * `In Review` ➔ `Done` (Hanya setelah review / PR siap)
  * `In Review` ➔ `In Progress` (Revisi diminta)
* **Transisi Ilegal (Ditolak Otomatis)**:
  * Melompat langsung dari `In Progress` ke `Done` (Bypass review).
  * Melompat dari `Backlog` langsung ke `Done`.

---

## 5. Audit Trail & Pencatatan Mutasi

Setiap mutasi data (status, prioritas, komentar, penugasan, penautan akun) dicatat dalam tabel `audit_logs` di SQLite dengan metadata:
* `id`: UUID unik event mutasi.
* `action`: Jenis aksi (misal: `ISSUE_STATUS_UPDATE`, `ACCOUNT_LINKED`).
* `actor_discord_id`: ID pengguna Discord.
* `actor_github_id`: ID numerik GitHub terverifikasi.
* `target_resource`: Identitas sumber daya (misal: `issue#42`).
* `payload_diff`: Ringkasan JSON before/after perubahan (**secret/token selalu disaring dan tidak pernah dicatat**).
* `created_at`: Waktu eksekusi UTC ISO 8601.
