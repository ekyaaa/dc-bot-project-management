import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type {
  InitiateAccountLinkUseCase,
  GetAccountStatusUseCase,
  DisconnectAccountUseCase,
} from '../../../application/usecases/index.js';
import { EMBED_COLORS } from '../embeds.js';

export interface AccountHandlerDeps {
  initiateAccountLinkUseCase: InitiateAccountLinkUseCase;
  getAccountStatusUseCase: GetAccountStatusUseCase;
  disconnectAccountUseCase: DisconnectAccountUseCase;
}

export async function handleAccountCommand(
  interaction: ChatInputCommandInteraction,
  deps: AccountHandlerDeps,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const discordUserId = interaction.user.id;
  const guildId = interaction.guildId ?? '';

  switch (subcommand) {
    case 'connect': {
      const result = await deps.initiateAccountLinkUseCase.execute({
        discordUserId,
        guildId,
      });

      const embed = new EmbedBuilder()
        .setTitle('🔗 Tautkan Akun Discord ke GitHub')
        .setColor(EMBED_COLORS.BRAND)
        .setDescription(
          'Klik tombol atau tautan di bawah ini untuk mengotorisasi penautan akun Discord Anda dengan GitHub via OAuth 2.0 PKCE yang aman.\n\n' +
            `🔒 Tautan ini hanya dapat digunakan satu kali dan akan kedaluwarsa dalam **${Math.floor(result.expiresInSeconds / 60)} menit**.`,
        )
        .addFields(
          {
            name: 'State Nonce',
            value: `\`${result.stateNonce.slice(0, 16)}...\``,
            inline: true,
          },
          {
            name: 'Privasi',
            value: 'Hanya meminta izin profil publik (`read:user`). Token disimpan terenkripsi (AES-256-GCM).',
            inline: false,
          },
        )
        .setFooter({ text: 'Pesan ini bersifat ephemeral (hanya Anda yang dapat melihat).' })
        .setTimestamp();

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Otorisasi dengan GitHub')
          .setURL(result.authorizationUrl)
          .setEmoji('🐙'),
      );

      await interaction.editReply({
        embeds: [embed],
        components: [row],
      });
      break;
    }

    case 'status': {
      const status = await deps.getAccountStatusUseCase.execute({
        discordUserId,
        guildId,
      });

      const embed = new EmbedBuilder()
        .setTitle('👤 Status Akun GitHub Tertaut')
        .setColor(status.linked ? EMBED_COLORS.SUCCESS : EMBED_COLORS.IN_PROGRESS)
        .setTimestamp();

      if (status.linked) {
        embed
          .setDescription('Akun Discord Anda telah terhubung ke GitHub dengan verifikasi identitas resmi.')
          .addFields(
            { name: 'GitHub Login', value: `@${status.githubUsername}`, inline: true },
            { name: 'Numeric User ID', value: `\`${status.githubUserId}\``, inline: true },
            { name: 'Peran Aplikasi (RBAC)', value: `**${status.applicationRole ?? 'Viewer'}**`, inline: true },
            {
              name: 'Waktu Penautan',
              value: status.linkedAt
                ? new Date(status.linkedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB'
                : 'Tidak diketahui',
              inline: false,
            },
            {
              name: 'Penyimpanan Token',
              value: status.hasEncryptedToken ? '✅ Terenkripsi (AES-256-GCM)' : 'ℹ️ Tidak ada token tersimpan',
              inline: false,
            },
          )
          .setFooter({ text: 'Gunakan /account disconnect jika ingin memutuskan tautan.' });
      } else {
        embed
          .setDescription(
            '⚠️ Akun Discord Anda **belum tertaut** ke GitHub.\n\n' +
              'Gunakan perintah `/account connect` untuk memulai proses otorisasi.',
          )
          .setFooter({ text: 'Perintah tulis memerlukan akun GitHub yang tertaut.' });
      }

      await interaction.editReply({
        embeds: [embed],
        components: [],
      });
      break;
    }

    case 'disconnect': {
      const result = await deps.disconnectAccountUseCase.execute({
        discordUserId,
        guildId,
      });

      const embed = new EmbedBuilder()
        .setTitle(result.unlinked ? '✅ Tautan Akun Berhasil Diputuskan' : 'ℹ️ Status Penautan Akun')
        .setColor(result.unlinked ? EMBED_COLORS.SUCCESS : EMBED_COLORS.BRAND)
        .setDescription(result.message)
        .setTimestamp();

      if (result.unlinked) {
        embed.addFields({
          name: 'Pencabutan Akses Tambahan (Opsional)',
          value: `Untuk mencabut otorisasi aplikasi dari sisi GitHub, kunjungi [GitHub Applications Settings](${result.revocationUrl}).`,
          inline: false,
        });
      }

      await interaction.editReply({
        embeds: [embed],
        components: [],
      });
      break;
    }

    default:
      throw new Error(`Subcommand /account '${subcommand}' tidak dikenal.`);
  }
}
