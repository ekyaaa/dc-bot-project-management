import { EmbedBuilder } from 'discord.js';

export const HELP_COLORS = {
  BRAND: 0x5865F2,
  GENERAL: 0x3498DB,
  WRITE: 0xE67E22,
  ACCOUNT: 0x2ECC71,
  POLICIES: 0x9B59B6,
} as const;

export function buildHelpEmbed(category?: string | null): EmbedBuilder {
  const normCategory = category?.toLowerCase();

  switch (normCategory) {
    case 'general':
      return new EmbedBuilder()
        .setTitle('📋 Panduan Perintah: Kueri Proyek & Read-Only')
        .setColor(HELP_COLORS.GENERAL)
        .setDescription(
          'Daftar perintah untuk memantau status proyek, daftar issue, backlog, dan Pull Request terbuka.',
        )
        .addFields(
          {
            name: '`/project status`',
            value:
              'Menampilkan ringkasan metrik proyek: jumlah issue pada setiap status kanonikal (Backlog, Ready, In Progress, In Review, Done, Blocked) dan total PR terbuka.',
            inline: false,
          },
          {
            name: '`/project issues [status] [assignee] [limit]`',
            value:
              'Daftar issue terfilter dengan paginasi interaktif jika hasil > 10 items. Opsi limit antara 1 hingga 50.',
            inline: false,
          },
          {
            name: '`/project mine`',
            value:
              'Menampilkan tugas yang ditugaskan kepada Anda dan permintaan review aktif. *Otomatis bersifat ephemeral (hanya Anda yang melihat) & memerlukan akun tertaut.*',
            inline: false,
          },
          {
            name: '`/project blocked`',
            value:
              'Menampilkan seluruh issue yang sedang terhambat (Blocked) beserta alasan kendala dan penanggung jawabnya.',
            inline: false,
          },
          {
            name: '`/project unassigned`',
            value:
              'Menampilkan backlog issue terbuka yang belum memiliki assignee, diurutkan berdasarkan prioritas (Urgent > High > Medium > Low).',
            inline: false,
          },
          {
            name: '`/project reviews`',
            value:
              'Menampilkan daftar Pull Request terbuka yang sedang menunggu code review beserta status draft/ready.',
            inline: false,
          },
          {
            name: '`/project digest`',
            value:
              'Pratinjau ringkasan komprehensif harian proyek secara on-demand.',
            inline: false,
          },
          {
            name: '`/issue view <number>`',
            value:
              'Menampilkan kartu detail lengkap dari sebuah issue spesifik dilengkapi tautan langsung ke GitHub.',
            inline: false,
          },
        )
        .setFooter({ text: 'Gunakan /help category:write untuk panduan operasi modifikasi data.' });

    case 'write':
      return new EmbedBuilder()
        .setTitle('✍️ Panduan Perintah: Operasi Tulis & Workflow')
        .setColor(HELP_COLORS.WRITE)
        .setDescription(
          'Perintah modifikasi data GitHub dengan konfirmasi 2-fase, verifikasi hak akses fail-closed, dan anti-stale concurrency check.',
        )
        .addFields(
          {
            name: '`/issue create <title> [type]`',
            value:
              'Membuka modal formulir interaktif di Discord untuk mengisi deskripsi detail dan kriteria penerimaan (Acceptance Criteria).',
            inline: false,
          },
          {
            name: '`/issue assign <number> <developer>`',
            value:
              'Menugaskan issue ke kolaborator repository. Menampilkan pratinjau diff dan tombol konfirmasi yang terikat pemanggil (TTL 60 detik). *Developer hanya dapat menugaskan ke diri sendiri; Maintainer/Admin dapat menugaskan siapa saja.*',
            inline: false,
          },
          {
            name: '`/issue status <number> <status>`',
            value:
              'Memperbarui kolom status kanonikal GitHub Project v2 (`Backlog`, `Ready`, `In Progress`, `In Review`, `Done`, `Blocked`). Memeriksa aturan transisi status kanonikal.',
            inline: false,
          },
          {
            name: '`/issue priority <number> <priority>`',
            value:
              'Mengubah tingkat prioritas issue (`Urgent`, `High`, `Medium`, `Low`) dengan pratinjau diff.',
            inline: false,
          },
          {
            name: '`/issue block <number> <reason>`',
            value:
              'Menandai status issue menjadi `Blocked` dengan alasan kendala wajib (minimal 3 karakter) dan memposting komentar otomatis ke GitHub issue.',
            inline: false,
          },
          {
            name: '`/issue comment <number> <text>`',
            value:
              'Menambahkan komentar tersanitasi ke GitHub issue dari Discord dengan perlindungan anti-mention injection.',
            inline: false,
          },
          {
            name: '🛡️ Batasan MVP (Non-Goals)',
            value:
              'Perintah penutupan issue (`close`), merge Pull Request (`merge`), deploy ke server, atau eksekusi autonomous agent sengaja **tidak disediakan** pada bot demi menjaga keamanan workflow manual tim.',
            inline: false,
          },
        )
        .setFooter({ text: 'Semua operasi tulis dicatat dalam audit log database secara permanen.' });

    case 'account':
      return new EmbedBuilder()
        .setTitle('🔗 Panduan Perintah: Manajemen Akun & Identitas')
        .setColor(HELP_COLORS.ACCOUNT)
        .setDescription(
          'Hubungkan akun Discord Anda dengan identitas GitHub secara aman untuk mendapatkan otorisasi perintah tulis.',
        )
        .addFields(
          {
            name: '`/account connect`',
            value:
              'Memulai otentikasi OAuth 2.0 PKCE dengan GitHub. Bot memberikan tautan otorisasi pribadi (ephemeral, berlaku 10 menit) untuk memetakan Discord ID Anda ke GitHub User ID numerik.',
            inline: false,
          },
          {
            name: '`/account status`',
            value:
              'Menampilkan status akun GitHub tertaut, peran sistem (`Viewer`, `Developer`, `Maintainer`, `Admin`), dan hak akses repository saat ini.',
            inline: false,
          },
          {
            name: '`/account disconnect`',
            value:
              'Memutuskan tautan akun Discord Anda dan menghapus token terenkripsi dari penyimpanan bot.',
            inline: false,
          },
        )
        .setFooter({ text: 'Token OAuth disimpan dengan enkripsi AES-256-GCM di media penyimpanan SQLite.' });

    case 'policies':
      return new EmbedBuilder()
        .setTitle('🛡️ Panduan: Kebijakan Keamanan & Hak Akses (RBAC)')
        .setColor(HELP_COLORS.POLICIES)
        .setDescription(
          'Prinsip keamanan fail-closed, pembatasan hak akses berbasis peran, dan perlindungan integritas data bot.',
        )
        .addFields(
          {
            name: '1. Model Peran RBAC (Role-Based Access Control)',
            value:
              '• **Viewer**: Kueri kueri baca saja.\n• **Developer**: Mengubah issue yang ditugaskan ke diri sendiri dan menugaskan issue ke diri sendiri.\n• **Maintainer / Admin**: Hak modifikasi penuh pada semua issue.',
            inline: false,
          },
          {
            name: '2. Verifikasi Izin Kolaborator Real-Time',
            value:
              'Setiap aksi tulis memeriksa ulang izin collaborator GitHub Anda secara langsung ke API GitHub sesaat sebelum aksi diterapkan.',
            inline: false,
          },
          {
            name: '3. Perlindungan Konkurensi & Anti-Stale',
            value:
              'Jika status issue pada GitHub berubah saat Anda sedang melihat pratinjau konfirmasi, bot membatalkan mutasi secara otomatis untuk mencegah overwriting tidak sengaja.',
            inline: false,
          },
          {
            name: '4. Keamanan Mention Discord',
            value:
              'Bot strictly melarang mention massal (`@everyone`, `@here`, role ping) dengan sanitasi zero-width space dan kebijakan `allowedMentions: { parse: [] }`.',
            inline: false,
          },
          {
            name: '5. Server Allowlisting',
            value:
              'Bot hanya merespons interaksi yang berasal dari server Discord resmi yang telah ditentukan dalam konfigurasi.',
            inline: false,
          },
        )
        .setFooter({ text: 'Keamanan deterministik tanpa ketergantungan pada model probabilistik/LLM.' });

    default:
      return new EmbedBuilder()
        .setTitle('📖 Direktori Panduan Perintah Bot Proyek')
        .setColor(HELP_COLORS.BRAND)
        .setDescription(
          'Selamat datang di bot manajemen proyek Discord terintegrasi GitHub Issues, Projects v2, dan Pull Requests.\nPilih kategori untuk melihat informasi spesifik:',
        )
        .addFields(
          {
            name: '📋 `/help category:general`',
            value: 'Kueri pemantauan proyek, daftar issue, PR review, dan detail tugas.',
            inline: false,
          },
          {
            name: '✍️ `/help category:write`',
            value: 'Pembuatan issue via modal dialog, assignment 2-fase, mutasi status, prioritas, dan blocker.',
            inline: false,
          },
          {
            name: '🔗 `/help category:account`',
            value: 'Penautan akun Discord ke GitHub melalui OAuth 2.0 PKCE terenkripsi.',
            inline: false,
          },
          {
            name: '🛡️ `/help category:policies`',
            value: 'Informasi model keamanan RBAC, izin kolaborator, dan anti-stale concurrency check.',
            inline: false,
          },
        )
        .setFooter({ text: 'Ketik /help category:<pilihan> untuk membuka panduan lengkap.' });
  }
}
