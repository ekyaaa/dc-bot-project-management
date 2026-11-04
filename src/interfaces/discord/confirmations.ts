import {
  EmbedBuilder,
  type ButtonInteraction,
} from 'discord.js';
import type {
  CanonicalStatus,
  CanonicalPriority,
  AuditAction,
} from '../../domain/types.js';
import type { IAuthorizationService } from '../../application/ports/IAuthorizationService.js';
import type { IGitHubService } from '../../application/ports/IGitHubService.js';
import type { AuditService } from '../../application/services/AuditService.js';
import { ValidationError } from '../../domain/errors.js';

export interface PendingConfirmationSession {
  action: 'assign' | 'status' | 'priority' | 'block';
  issueNumber: number;
  callerDiscordId: string;
  timestamp: number;
  expiresAt: number; // timestamp + 60_000
  payload: {
    targetAssignee?: string;
    expectedPreviousAssignees?: string[];
    targetStatus?: CanonicalStatus;
    expectedPreviousStatus?: CanonicalStatus;
    targetPriority?: CanonicalPriority;
    expectedPreviousPriority?: CanonicalPriority;
    blockerReason?: string;
  };
}

export class ConfirmationStore {
  private static instance: ConfirmationStore;
  private readonly store = new Map<string, PendingConfirmationSession>();
  private readonly maxEntries = 1000;
  private cleanupTimer: NodeJS.Timeout | null = null;
  public static readonly TTL_MS = 60 * 1000; // 60 seconds

  constructor() {
    this.startCleanupInterval();
  }

  public static getInstance(): ConfirmationStore {
    if (!ConfirmationStore.instance) {
      ConfirmationStore.instance = new ConfirmationStore();
    }
    return ConfirmationStore.instance;
  }

  private startCleanupInterval(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.pruneExpired();
    }, 15 * 1000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  public set(key: string, session: PendingConfirmationSession): void {
    if (this.store.size >= this.maxEntries) {
      this.pruneExpired();
    }
    this.store.set(key, session);
  }

  public get(key: string): PendingConfirmationSession | undefined {
    return this.store.get(key);
  }

  public delete(key: string): boolean {
    return this.store.delete(key);
  }

  public pruneExpired(now: number = Date.now()): void {
    for (const [key, session] of this.store.entries()) {
      if (now > session.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  public destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.store.clear();
  }
}

export interface ConfirmationInteractionDeps {
  authService: IAuthorizationService;
  gitHubService: IGitHubService;
  auditService: AuditService;
  confirmationStore: ConfirmationStore;
}

/**
 * Handles two-phase Confirm/Cancel button interactions with strict actor binding,
 * 60s TTL verification, and anti-stale pre-mutation state re-fetch.
 */
export async function handleConfirmationInteraction(
  interaction: ButtonInteraction,
  deps: ConfirmationInteractionDeps,
): Promise<boolean> {
  const isConfirm = interaction.customId.startsWith('confirm:');
  const isCancel = interaction.customId.startsWith('cancel:');

  if (!isConfirm && !isCancel) {
    return false;
  }

  const parts = interaction.customId.split(':');
  if (parts.length < 5) {
    throw new ValidationError('Format customId tombol konfirmasi tidak valid.');
  }

  const [type, action, resourceIdStr, callerDiscordId, timestampStr] = parts;
  const issueNumber = parseInt(resourceIdStr!, 10);
  const timestamp = parseInt(timestampStr!, 10);
  const sessionKey = `${action}:${issueNumber}:${callerDiscordId}:${timestamp}`;
  const now = Date.now();

  // 1. ACTOR BINDING CHECK: Only the user who ran the command can confirm or cancel
  if (interaction.user.id !== callerDiscordId) {
    await interaction.reply({
      content: `❌ **Akses Ditolak**: Anda tidak berwenang mengonfirmasi atau membatalkan aksi ini. Hanya pemanggil asli (<@${callerDiscordId}>) yang dapat merespons.`,
      ephemeral: true,
    });
    return true; // Leaves original message untouched for the authorized caller
  }

  // 2. CANCELLATION HANDLING
  if (type === 'cancel') {
    deps.confirmationStore.delete(sessionKey);
    const cancelEmbed = new EmbedBuilder()
      .setTitle('🚫 Aksi Dibatalkan')
      .setDescription(
        `Perubahan **${action}** pada Issue #${issueNumber} telah dibatalkan. Tidak ada perubahan yang diterapkan ke GitHub.`,
      )
      .setColor(0x95A5A6)
      .setTimestamp();

    await interaction.update({
      embeds: [cancelEmbed],
      components: [], // Disables and clears buttons
    });
    return true;
  }

  // 3. 60-SECOND TTL EXPIRATION CHECK
  if (now > timestamp + ConfirmationStore.TTL_MS) {
    deps.confirmationStore.delete(sessionKey);
    const expiredEmbed = new EmbedBuilder()
      .setTitle('⚠️ Konfirmasi Kedaluwarsa')
      .setDescription(
        'Sesi konfirmasi telah kedaluwarsa (batas waktu 60 detik). Silakan jalankan perintah kembali untuk memuat data terbaru.',
      )
      .setColor(0xED4245)
      .setTimestamp();

    await interaction.update({
      embeds: [expiredEmbed],
      components: [],
    });
    return true;
  }

  // 4. RETRIEVE ACTIVE SESSION
  const session = deps.confirmationStore.get(sessionKey);
  if (!session) {
    const missingEmbed = new EmbedBuilder()
      .setTitle('⚠️ Sesi Konfirmasi Tidak Ditemukan')
      .setDescription(
        'Sesi konfirmasi ini tidak lagi aktif atau telah dibersihkan. Silakan jalankan perintah kembali.',
      )
      .setColor(0xED4245)
      .setTimestamp();

    await interaction.update({
      embeds: [missingEmbed],
      components: [],
    });
    return true;
  }

  // 5. ANTI-STALE RE-FETCH (Concurrency Conflict Protection)
  const freshIssue = await deps.gitHubService.getIssue(issueNumber);

  if (action === 'status' && session.payload.expectedPreviousStatus) {
    const currentStatus = freshIssue.projectStatus ?? 'Backlog';
    if (currentStatus !== session.payload.expectedPreviousStatus) {
      deps.confirmationStore.delete(sessionKey);
      const conflictEmbed = new EmbedBuilder()
        .setTitle('⚡ Konflik Konkurensi Terdeteksi')
        .setDescription(
          `Status issue telah diubah dari \`${session.payload.expectedPreviousStatus}\` menjadi \`${currentStatus}\` sejak pratinjau dibuat. Aksi dibatalkan untuk mencegah penimpaan perubahan orang lain.`,
        )
        .setColor(0xE67E22)
        .setTimestamp();

      await interaction.update({
        embeds: [conflictEmbed],
        components: [],
      });
      return true;
    }
  }

  if (action === 'priority' && session.payload.expectedPreviousPriority) {
    const currentPriority = freshIssue.projectPriority;
    if (currentPriority !== session.payload.expectedPreviousPriority) {
      deps.confirmationStore.delete(sessionKey);
      const conflictEmbed = new EmbedBuilder()
        .setTitle('⚡ Konflik Konkurensi Terdeteksi')
        .setDescription(
          `Prioritas issue telah diubah dari \`${session.payload.expectedPreviousPriority}\` menjadi \`${currentPriority}\` sejak pratinjau dibuat. Aksi dibatalkan.`,
        )
        .setColor(0xE67E22)
        .setTimestamp();

      await interaction.update({
        embeds: [conflictEmbed],
        components: [],
      });
      return true;
    }
  }

  if (action === 'block' && session.payload.expectedPreviousStatus) {
    const currentStatus = freshIssue.projectStatus ?? 'Backlog';
    if (currentStatus !== session.payload.expectedPreviousStatus) {
      deps.confirmationStore.delete(sessionKey);
      const conflictEmbed = new EmbedBuilder()
        .setTitle('⚡ Konflik Konkurensi Terdeteksi')
        .setDescription(
          `Status issue telah diubah menjadi \`${currentStatus}\` sejak pratinjau dibuat. Aksi pemblokiran dibatalkan.`,
        )
        .setColor(0xE67E22)
        .setTimestamp();

      await interaction.update({
        embeds: [conflictEmbed],
        components: [],
      });
      return true;
    }
  }

  // 6. FRESH AUTHORIZATION CHECK (Live Repo Permissions)
  const principal = await deps.authService.resolvePrincipal(
    interaction.user.id,
    interaction.guildId ?? '',
  );
  deps.authService.requireVerifiedIdentity(principal);

  // 7. EXECUTE REMOTE MUTATION ON GITHUB
  let auditAction: AuditAction = 'ISSUE_STATUS_UPDATE';
  let beforeState: Record<string, unknown> = {};
  let afterState: Record<string, unknown> = {};

  switch (action) {
    case 'assign': {
      auditAction = 'ISSUE_ASSIGN';
      beforeState = { assignees: freshIssue.assignees };
      await deps.gitHubService.assignIssue(
        issueNumber,
        session.payload.targetAssignee!,
        principal.identity.githubUserId,
      );
      afterState = { assignee: session.payload.targetAssignee };
      break;
    }
    case 'status': {
      auditAction = 'ISSUE_STATUS_UPDATE';
      beforeState = { status: session.payload.expectedPreviousStatus };
      await deps.gitHubService.setProjectStatus(
        issueNumber,
        session.payload.targetStatus!,
        principal.identity.githubUserId,
        session.payload.expectedPreviousStatus,
      );
      afterState = { status: session.payload.targetStatus };
      break;
    }
    case 'priority': {
      auditAction = 'ISSUE_PRIORITY_UPDATE';
      beforeState = { priority: session.payload.expectedPreviousPriority };
      await deps.gitHubService.setProjectPriority(
        issueNumber,
        session.payload.targetPriority!,
        principal.identity.githubUserId,
        session.payload.expectedPreviousPriority,
      );
      afterState = { priority: session.payload.targetPriority };
      break;
    }
    case 'block': {
      auditAction = 'ISSUE_BLOCK';
      beforeState = { status: session.payload.expectedPreviousStatus };
      await deps.gitHubService.markBlocked(
        issueNumber,
        session.payload.blockerReason!,
        principal.identity.githubUserId,
        session.payload.expectedPreviousStatus,
      );
      afterState = { status: 'Blocked', reason: session.payload.blockerReason };
      break;
    }
  }

  // 8. LOG PERMANENT AUDIT IN SQLITE
  await deps.auditService.logMutation({
    actorDiscordId: interaction.user.id,
    actorGithubId: principal.identity.githubUserId,
    actorGithubLogin: principal.identity.githubLogin,
    action: auditAction,
    targetIssueNumber: issueNumber,
    beforeState,
    afterState,
    outcome: 'SUCCESS',
    correlationId: interaction.id,
  });

  // 9. CLEAN UP SESSION AND DELIVER SUCCESS EMBED
  deps.confirmationStore.delete(sessionKey);
  const successEmbed = new EmbedBuilder()
    .setTitle(`✅ Issue #${issueNumber} Berhasil Diperbarui`)
    .setDescription(
      `Aksi **${action}** telah berhasil dieksekusi pada [Issue #${issueNumber}: ${freshIssue.title}](${freshIssue.htmlUrl}).`,
    )
    .addFields(
      { name: 'Field Diperbarui', value: `\`${action}\``, inline: true },
      { name: 'Nilai Baru', value: `\`${JSON.stringify(afterState)}\``, inline: true },
      { name: 'Oleh', value: `@${principal.identity.githubLogin}`, inline: true },
    )
    .setColor(0x57F287)
    .setTimestamp();

  await interaction.update({
    embeds: [successEmbed],
    components: [], // Disables/removes buttons
  });

  return true;
}
