import {
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
  type SlashCommandOptionsOnlyBuilder,
} from 'discord.js';

export const projectCommand: SlashCommandSubcommandsOnlyBuilder = new SlashCommandBuilder()
  .setName('project')
  .setDescription('Perintah kueri dan pemantauan GitHub Projects v2')
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Ringkasan status proyek kanonikal dan metrik Pull Request terbuka'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('issues')
      .setDescription('Daftar issue dengan filter status, assignee, dan batas jumlah')
      .addStringOption((opt) =>
        opt
          .setName('status')
          .setDescription('Filter status kanonikal')
          .setRequired(false)
          .addChoices(
            { name: 'Backlog', value: 'Backlog' },
            { name: 'Ready', value: 'Ready' },
            { name: 'In Progress', value: 'In Progress' },
            { name: 'In Review', value: 'In Review' },
            { name: 'Done', value: 'Done' },
            { name: 'Blocked', value: 'Blocked' },
          ),
      )
      .addStringOption((opt) =>
        opt
          .setName('assignee')
          .setDescription('Filter berdasarkan username GitHub')
          .setRequired(false),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('limit')
          .setDescription('Batas maksimal issue yang diambil (1-50)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(50),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('mine')
      .setDescription('Daftar issue dan review request yang ditugaskan ke Anda (ephemeral)'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('blocked')
      .setDescription('Daftar issue yang berstatus Blocked beserta alasan kendala'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unassigned')
      .setDescription('Daftar issue terbuka yang belum memiliki assignee (diurutkan prioritas)'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reviews')
      .setDescription('Daftar Pull Request terbuka yang menunggu code review'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('digest')
      .setDescription('Pratinjau ringkasan proyek harian secara on-demand'));

export const issueCommand: SlashCommandSubcommandsOnlyBuilder = new SlashCommandBuilder()
  .setName('issue')
  .setDescription('Perintah pengelolaan dan inspeksi issue GitHub')
  .addSubcommand((sub) =>
    sub
      .setName('view')
      .setDescription('Tampilkan kartu detail lengkap dari sebuah issue')
      .addIntegerOption((opt) =>
        opt
          .setName('number')
          .setDescription('Nomor issue GitHub')
          .setRequired(true)
          .setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Buat issue baru (membuka modal untuk deskripsi & acceptance criteria)')
      .addStringOption((opt) =>
        opt
          .setName('title')
          .setDescription('Judul issue')
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(256),
      )
      .addStringOption((opt) =>
        opt
          .setName('type')
          .setDescription('Tipe issue')
          .setRequired(false)
          .addChoices(
            { name: 'Task', value: 'task' },
            { name: 'Bug', value: 'bug' },
            { name: 'Feature', value: 'feature' },
            { name: 'Documentation', value: 'documentation' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('assign')
      .setDescription('Tugaskan issue ke developer (dengan konfirmasi 2-fase)')
      .addIntegerOption((opt) =>
        opt
          .setName('number')
          .setDescription('Nomor issue')
          .setRequired(true)
          .setMinValue(1),
      )
      .addStringOption((opt) =>
        opt
          .setName('developer')
          .setDescription('Username GitHub atau mention Discord pengembang')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Ubah status kanonikal issue pada GitHub Project v2')
      .addIntegerOption((opt) =>
        opt
          .setName('number')
          .setDescription('Nomor issue')
          .setRequired(true)
          .setMinValue(1),
      )
      .addStringOption((opt) =>
        opt
          .setName('status')
          .setDescription('Status target kanonikal')
          .setRequired(true)
          .addChoices(
            { name: 'Backlog', value: 'Backlog' },
            { name: 'Ready', value: 'Ready' },
            { name: 'In Progress', value: 'In Progress' },
            { name: 'In Review', value: 'In Review' },
            { name: 'Done', value: 'Done' },
            { name: 'Blocked', value: 'Blocked' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('priority')
      .setDescription('Atur tingkat prioritas issue pada Project v2')
      .addIntegerOption((opt) =>
        opt
          .setName('number')
          .setDescription('Nomor issue')
          .setRequired(true)
          .setMinValue(1),
      )
      .addStringOption((opt) =>
        opt
          .setName('priority')
          .setDescription('Tingkat prioritas')
          .setRequired(true)
          .addChoices(
            { name: 'Urgent', value: 'Urgent' },
            { name: 'High', value: 'High' },
            { name: 'Medium', value: 'Medium' },
            { name: 'Low', value: 'Low' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('block')
      .setDescription('Tandai issue sebagai Blocked dengan alasan kendala wajib')
      .addIntegerOption((opt) =>
        opt
          .setName('number')
          .setDescription('Nomor issue')
          .setRequired(true)
          .setMinValue(1),
      )
      .addStringOption((opt) =>
        opt
          .setName('reason')
          .setDescription('Alasan pemblokiran (minimal 3 karakter)')
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(500),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('comment')
      .setDescription('Tambahkan komentar tersanitasi ke issue GitHub')
      .addIntegerOption((opt) =>
        opt
          .setName('number')
          .setDescription('Nomor issue')
          .setRequired(true)
          .setMinValue(1),
      )
      .addStringOption((opt) =>
        opt
          .setName('text')
          .setDescription('Teks komentar (maks 2000 karakter)')
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(2000),
      ),
  );

export const accountCommand: SlashCommandSubcommandsOnlyBuilder = new SlashCommandBuilder()
  .setName('account')
  .setDescription('Manajemen penautan identitas Discord dan akun GitHub')
  .addSubcommand((sub) =>
    sub
      .setName('connect')
      .setDescription('Tautkan akun Discord ke GitHub melalui OAuth 2.0 PKCE yang aman (ephemeral)'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Periksa status penautan akun GitHub dan peran hak akses Anda'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('disconnect')
      .setDescription('Putuskan penautan akun GitHub dari sistem bot'));

export const helpCommand: SlashCommandOptionsOnlyBuilder = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Direktori panduan penggunaan perintah bot dan kebijakan keamanan')
  .addStringOption((opt) =>
    opt
      .setName('category')
      .setDescription('Filter kategori panduan')
      .setRequired(false)
      .addChoices(
        { name: 'General & Read-Only Queries', value: 'general' },
        { name: 'Write Operations & Workflows', value: 'write' },
        { name: 'Account Management', value: 'account' },
        { name: 'Access Policies & Security', value: 'policies' },
      ),
  );

export const ALL_COMMAND_DEFINITIONS = [
  projectCommand,
  issueCommand,
  accountCommand,
  helpCommand,
];
