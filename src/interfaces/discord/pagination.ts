import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type EmbedBuilder,
} from 'discord.js';
import crypto from 'node:crypto';

export interface PaginationSession<T = unknown> {
  sessionId: string;
  callerDiscordUserId: string;
  items: T[];
  pageSize: number;
  currentPage: number;
  renderPage: (pageItems: T[], pageIndex: number, totalPages: number) => EmbedBuilder;
  expiresAt: number;
}

export class PaginationManager {
  private static instance: PaginationManager;
  private readonly sessions = new Map<string, PaginationSession<unknown>>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  public static readonly TTL_MS = 15 * 60 * 1000; // 15 minutes TTL
  public static readonly DEFAULT_PAGE_SIZE = 10;

  constructor() {
    this.startCleanupInterval();
  }

  public static getInstance(): PaginationManager {
    if (!PaginationManager.instance) {
      PaginationManager.instance = new PaginationManager();
    }
    return PaginationManager.instance;
  }

  private startCleanupInterval(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions.entries()) {
        if (now > session.expiresAt) {
          this.sessions.delete(id);
        }
      }
    }, 60 * 1000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  public createSession<T>(
    callerDiscordUserId: string,
    items: T[],
    renderPage: (pageItems: T[], pageIndex: number, totalPages: number) => EmbedBuilder,
    pageSize: number = PaginationManager.DEFAULT_PAGE_SIZE,
  ): {
    firstPageEmbed: EmbedBuilder;
    actionRow: ActionRowBuilder<ButtonBuilder>;
    totalPages: number;
  } {
    const sessionId = crypto.randomBytes(4).toString('hex');
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));

    const session: PaginationSession<T> = {
      sessionId,
      callerDiscordUserId,
      items,
      pageSize,
      currentPage: 0,
      renderPage,
      expiresAt: Date.now() + PaginationManager.TTL_MS,
    };

    this.sessions.set(sessionId, session as PaginationSession<unknown>);

    const firstPageItems = items.slice(0, pageSize);
    const firstPageEmbed = renderPage(firstPageItems, 0, totalPages);
    const actionRow = this.buildActionRow(sessionId, 0, totalPages);

    return { firstPageEmbed, actionRow, totalPages };
  }

  public buildActionRow(
    sessionId: string,
    currentPage: number,
    totalPages: number,
  ): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`page:${sessionId}:first`)
        .setLabel('⏮ First')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId(`page:${sessionId}:prev`)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId(`page:${sessionId}:counter`)
        .setLabel(`Page ${currentPage + 1}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`page:${sessionId}:next`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId(`page:${sessionId}:last`)
        .setLabel('⏭ Last')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= totalPages - 1),
    );
  }

  public async handleButtonInteraction(
    interaction: ButtonInteraction,
  ): Promise<boolean> {
    if (!interaction.customId.startsWith('page:')) {
      return false;
    }

    const parts = interaction.customId.split(':');
    if (parts.length < 3) {
      return false;
    }

    const sessionId = parts[1]!;
    const action = parts[2]!;

    const session = this.sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        content: '⚠️ Sesi paginasi telah kedaluwarsa. Silakan jalankan perintah kembali untuk memuat data terbaru.',
        ephemeral: true,
      });
      return true;
    }

    // Actor lock check: only caller can flip pages
    if (interaction.user.id !== session.callerDiscordUserId) {
      await interaction.reply({
        content: `🔒 Hanya pengguna yang menjalankan perintah ini (<@${session.callerDiscordUserId}>) yang dapat mengendalikan navigasi paginasi.`,
        ephemeral: true,
      });
      return true;
    }

    const totalPages = Math.ceil(session.items.length / session.pageSize);
    let newPage = session.currentPage;

    switch (action) {
      case 'first':
        newPage = 0;
        break;
      case 'prev':
        newPage = Math.max(0, session.currentPage - 1);
        break;
      case 'next':
        newPage = Math.min(totalPages - 1, session.currentPage + 1);
        break;
      case 'last':
        newPage = Math.max(0, totalPages - 1);
        break;
      case 'counter':
        return true;
      default:
        return true;
    }

    session.currentPage = newPage;
    session.expiresAt = Date.now() + PaginationManager.TTL_MS;

    const pageItems = session.items.slice(
      newPage * session.pageSize,
      (newPage + 1) * session.pageSize,
    );

    const embed = session.renderPage(pageItems, newPage, totalPages);
    const updatedRow = this.buildActionRow(sessionId, newPage, totalPages);

    await interaction.update({
      embeds: [embed],
      components: [updatedRow],
    });

    return true;
  }

  public getSession(sessionId: string): PaginationSession<unknown> | undefined {
    return this.sessions.get(sessionId);
  }

  public destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}
