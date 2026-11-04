# Ringkasan Penemuan Awal & Keputusan Arsitektur (Discovery)

Dokumen ini mencatat audit awal repositori, pemetaan dependensi, konvensi kode, batasan sistem, serta keputusan arsitektur yang diambil sebelum implementasi **Discord Project Management Bot**.

---

## 1. Audit Kondisi Repositori Awal

* **Struktur Repositori**: Repositori mandiri (*dedicated repository*) untuk project management bot.
* **Bahasa & Toolchain**:
  * Runtime: Node.js v22 LTS (ESM `"type": "module"`).
  * Bahasa: TypeScript 5.7+ dengan `strict: true`.
  * Package Manager: `npm` dengan dependency lockfile (`package-lock.json`).
  * Test Runner: `vitest` v3 dengan coverage tool `@vitest/coverage-v8`.
* **State Git & Keamanan**:
  * `.gitignore` dikonfigurasi untuk mencegah commit file sensitif (`.env`, `.env.*`, direktori `secrets/`, database SQLite `*.db`, `*.db-wal`, `*.db-shm`, dan direktori `data/`).
  * `.dockerignore` mengecualikan seluruh artefak build dev, git history, dan secrets agar image Docker minimal dan aman.

---

## 2. Pilihan Teknologi Inti

Berdasarkan brief mandat proyek pada `DISCORD_PROJECT_BOT.md`:

| Komponen | Pilihan Teknologi | Alasan Pemilihan |
|---|---|---|
| **Discord Client** | `discord.js` v14 | Library standar industri dengan dukungan Gateway WebSocket v10, typed Application Commands, Interaction Modals, dan Button Components. |
| **GitHub Integration** | `@octokit/app`, `@octokit/rest`, `@octokit/graphql` | Otentikasi formal GitHub App via JWT & Installation Token rotasi otomatis; GraphQL untuk GitHub Projects v2. PAT tidak diizinkan. |
| **HTTP Framework** | `fastify` v5 + `fastify-raw-body` | Server performa tinggi dengan overhead minimal, mendukung parsing Buffer mentah untuk verifikasi HMAC SHA-256 signature webhook. |
| **Database** | `better-sqlite3` v11 | SQLite synchronous disk I/O tercepat di ekosistem Node.js, transaksi ACID lokal, WAL mode, cocok untuk deployment single-instance di VPS. |
| **Kriptografi** | Node.js `crypto` native | AES-256-GCM authenticated encryption untuk OAuth token, HMAC SHA-256 `timingSafeEqual` untuk webhook GitHub. |
| **Scheduler** | `croner` v9 | Scheduler cron in-process dengan dukungan zona waktu (`Asia/Jakarta`), dipadukan dengan lease lock di SQLite untuk menjamin idempotensi restart. |
| **Validasi Skema** | `zod` v3 | Validasi boundary fail-closed untuk variabel environment, payload webhook, dan opsi interaksi Discord. |
| **Containerization** | Docker Multi-stage + Compose | Base `node:22-bookworm-slim`, non-root user `node` (UID 1000), `dumb-init` PID 1, volume SQLite persisten, dan Docker secrets. |

---

## 3. Batasan Desain & Non-Goals MVP

1. **Tanpa LLM (Deterministic Execution)**: Bot tidak menggunakan model bahasa besar, tidak memanggil API AI eksternal, dan tidak menghasilkan pengeluaran per-token yang tidak terkendali.
2. **Tanpa Operasi Destruktif**: Operasi seperti *close issue*, *pull request merge*, penghapusan branch, atau trigger deploy tidak tersedia pada MVP.
3. **Pemisahan Sumber Kebenaran (Single Source of Truth)**:
   * GitHub Issues = Sumber kebenaran task & diskusi.
   * GitHub Projects v2 = Status kanonikal project (`Backlog`, `Ready`, `In Progress`, `In Review`, `Done`, `Blocked`).
   * SQLite = Hanya menyimpan relasi identitas Discord ↔ GitHub, token terenkripsi, outbox queue/dedup, lease lock scheduler, dan audit trail.
4. **Keamanan Interaksi**:
   * Immediate interaction deferral (`deferReply({ flags: MessageFlags.Ephemeral })`) untuk mencegah timeout 3 detik Discord saat menunggu API GitHub.
   * Tombol konfirmasi dua langkah terikat ke actor pemanggil (*actor-bound*) dengan TTL 60 detik.
   * Mention safety fail-closed: menekan `@everyone`, `@here`, dan role ping massal secara eksplisit.
