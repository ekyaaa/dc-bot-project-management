import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type {
  CanonicalStatus,
  CanonicalPriority,
  IssueSummary,
  IssueDetail,
  ProjectSummary,
  ReviewRequestSummary,
  BlockedIssueSummary,
} from '../../domain/types.js';
import { MentionPolicy } from '../../domain/policies.js';
import { DomainError } from '../../domain/errors.js';

export const EMBED_COLORS = {
  BRAND: 0x5865F2,       // Blurple
  SUCCESS: 0x57F287,     // Green - Done, Healthy, No Blockers
  IN_PROGRESS: 0xFEE75C, // Amber / Yellow - In Progress, Unassigned
  BLOCKED: 0xED4245,     // Red - Blocked, Urgent, Error
  READY: 0x3498DB,       // Blue - Ready
  IN_REVIEW: 0x9B59B6,   // Purple - In Review, PRs
  BACKLOG: 0x95A5A6,     // Slate / Gray - Backlog
  NEUTRAL: 0x2F3136,     // Dark Gray
  DIFF_PREVIEW: 0xF39C12,// Amber / Warning for Confirmations
} as const;

export const STATUS_EMOJIS: Record<CanonicalStatus, string> = {
  Backlog: '📥',
  Ready: '📋',
  'In Progress': '🔄',
  'In Review': '🔍',
  Done: '✅',
  Blocked: '🚫',
};

export const PRIORITY_EMOJIS: Record<CanonicalPriority, string> = {
  Urgent: '🔴',
  High: '🟠',
  Medium: '🟡',
  Low: '⚪',
};

export function getStatusColor(status?: CanonicalStatus): number {
  switch (status) {
    case 'Done':
      return EMBED_COLORS.SUCCESS;
    case 'In Progress':
      return EMBED_COLORS.IN_PROGRESS;
    case 'Blocked':
      return EMBED_COLORS.BLOCKED;
    case 'Ready':
      return EMBED_COLORS.READY;
    case 'In Review':
      return EMBED_COLORS.IN_REVIEW;
    case 'Backlog':
      return EMBED_COLORS.BACKLOG;
    default:
      return EMBED_COLORS.BRAND;
  }
}

/**
 * Sanitizes markdown against mention injection attacks (@everyone, @here, role pings)
 * and truncates to the specified character limit with ellipsis.
 */
export function sanitizeAndTruncate(text: string | null | undefined, maxLength: number): string {
  if (!text) return '';
  const sanitized = MentionPolicy.sanitizeDiscordMentions(text);
  if (sanitized.length <= maxLength) return sanitized;
  return sanitized.slice(0, Math.max(0, maxLength - 3)) + '...';
}

/**
 * /project status Embed
 */
export function buildProjectStatusEmbed(summary: ProjectSummary): EmbedBuilder {
  const hasBlockers = (summary.statusCounts.Blocked ?? 0) > 0;
  const embedColor = hasBlockers ? EMBED_COLORS.BLOCKED : EMBED_COLORS.BRAND;

  return new EmbedBuilder()
    .setTitle(`📊 Status Proyek: ${sanitizeAndTruncate(summary.title, 200)}`)
    .setColor(embedColor)
    .setDescription('Ringkasan status proyek GitHub Projects v2 dan metrik Pull Request aktif.')
    .addFields(
      { name: '📥 Backlog', value: `${summary.statusCounts.Backlog ?? 0}`, inline: true },
      { name: '📋 Ready', value: `${summary.statusCounts.Ready ?? 0}`, inline: true },
      { name: '🔄 In Progress', value: `${summary.statusCounts['In Progress'] ?? 0}`, inline: true },
      { name: '🔍 In Review', value: `${summary.statusCounts['In Review'] ?? 0}`, inline: true },
      { name: '✅ Done', value: `${summary.statusCounts.Done ?? 0}`, inline: true },
      { name: '🚫 Blocked', value: `${summary.statusCounts.Blocked ?? 0}`, inline: true },
      {
        name: '📈 Total Metrik',
        value: `🎯 **Issue Terbuka**: ${summary.totalOpenIssues}  •  🔀 **Pull Request Terbuka**: ${summary.totalOpenPullRequests}`,
        inline: false,
      },
    )
    .setFooter({
      text: `Project #${summary.projectNumber} • Sinkronisasi: ${new Date(summary.lastSyncedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`,
    })
    .setTimestamp();
}

/**
 * /project issues List Embed (single page of up to 10 items)
 */
export function buildIssueListEmbed(
  issues: IssueSummary[],
  filter: { status?: string; assignee?: string },
  pageIndex: number,
  totalPages: number,
): EmbedBuilder {
  const filterDesc: string[] = [];
  if (filter.status) filterDesc.push(`Status: \`${filter.status}\``);
  if (filter.assignee) filterDesc.push(`Assignee: \`@${filter.assignee}\``);

  const descriptionHeader =
    filterDesc.length > 0 ? `**Filter Aktif**: ${filterDesc.join(' | ')}\n\n` : '';

  if (issues.length === 0) {
    return new EmbedBuilder()
      .setTitle(`📋 Daftar Issue Proyek (0 item)`)
      .setColor(EMBED_COLORS.BRAND)
      .setDescription(
        descriptionHeader + '_Tidak ada issue yang sesuai dengan kriteria filter saat ini._',
      )
      .setFooter({ text: 'Gunakan filter berbeda untuk mencari issue lain.' })
      .setTimestamp();
  }

  const issueLines = issues.map((issue) => {
    const statusEmoji = issue.projectStatus ? (STATUS_EMOJIS[issue.projectStatus] ?? '▫️') : '▫️';
    const priorityEmoji = issue.projectPriority ? (PRIORITY_EMOJIS[issue.projectPriority] ?? '') : '';
    const assigneeStr = issue.assignees.length > 0 ? `@${issue.assignees.join(', @')}` : 'Unassigned';
    return (
      `${statusEmoji} [**#${issue.number} ${sanitizeAndTruncate(issue.title, 60)}**](${issue.htmlUrl})\n` +
      `   ${priorityEmoji ? `${priorityEmoji} ` : ''}\`${issue.projectStatus ?? 'No Status'}\` • 👤 ${assigneeStr} • 💬 ${issue.commentsCount}`
    );
  });

  return new EmbedBuilder()
    .setTitle(`📋 Daftar Issue Proyek (Halaman ${pageIndex + 1} dari ${totalPages})`)
    .setColor(EMBED_COLORS.BRAND)
    .setDescription(descriptionHeader + issueLines.join('\n\n'))
    .setFooter({ text: `Halaman ${pageIndex + 1}/${totalPages} • Menampilkan ${issues.length} issue` })
    .setTimestamp();
}

/**
 * /project mine Embed (Strictly Ephemeral personal dashboard)
 */
export function buildMyWorkEmbed(
  githubLogin: string,
  issues: IssueSummary[],
  reviews: ReviewRequestSummary[],
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`👤 Dasbor Tugas Saya (@${githubLogin})`)
    .setColor(EMBED_COLORS.BRAND)
    .setDescription('Daftar pekerjaan aktif yang memerlukan tindakan atau review dari Anda.')
    .setTimestamp();

  if (issues.length === 0) {
    embed.addFields({
      name: '📌 Issue Ditugaskan',
      value: '_Tidak ada issue terbuka yang sedang ditugaskan kepada Anda._',
      inline: false,
    });
  } else {
    const issueLines = issues.map((i) => {
      const statusEmoji = i.projectStatus ? (STATUS_EMOJIS[i.projectStatus] ?? '▫️') : '▫️';
      const pEmoji = i.projectPriority ? ` ${PRIORITY_EMOJIS[i.projectPriority]}` : '';
      return `${statusEmoji} [**#${i.number} ${sanitizeAndTruncate(i.title, 50)}**](${i.htmlUrl}) • \`${i.projectStatus ?? 'Open'}\`${pEmoji}`;
    });
    embed.addFields({
      name: `📌 Issue Ditugaskan (${issues.length})`,
      value: issueLines.join('\n'),
      inline: false,
    });
  }

  if (reviews.length === 0) {
    embed.addFields({
      name: '🔍 Permintaan Review PR',
      value: '_Tidak ada Pull Request yang menunggu review Anda saat ini._',
      inline: false,
    });
  } else {
    const reviewLines = reviews.map((r) => {
      const draftBadge = r.draft ? ' 📝 *[Draft]*' : '';
      return `🔀 [**#${r.pullNumber} ${sanitizeAndTruncate(r.title, 50)}**](${r.htmlUrl}) oleh @${r.author}${draftBadge}`;
    });
    embed.addFields({
      name: `🔍 Permintaan Review PR (${reviews.length})`,
      value: reviewLines.join('\n'),
      inline: false,
    });
  }

  embed.setFooter({ text: 'Informasi ini hanya terlihat oleh Anda (ephemeral).' });
  return embed;
}

/**
 * /project blocked Embed
 */
export function buildBlockedIssuesEmbed(
  blocked: BlockedIssueSummary[],
  pageIndex: number,
  totalPages: number,
): EmbedBuilder {
  if (blocked.length === 0) {
    return new EmbedBuilder()
      .setTitle('🚫 Issue Terblokir (0)')
      .setColor(EMBED_COLORS.SUCCESS)
      .setDescription('🎉 **Tidak ada issue terblokir!** Semua jalur kerja proyek berjalan lancar tanpa hambatan.')
      .setTimestamp();
  }

  const lines = blocked.map((b) => {
    const assigneeStr = b.assignees.length > 0 ? `@${b.assignees.join(', @')}` : 'Unassigned';
    return (
      `🚫 [**#${b.number} ${sanitizeAndTruncate(b.title, 60)}**](${b.htmlUrl})\n` +
      `   👤 **Assignee**: ${assigneeStr}\n` +
      `   ⚠️ **Kendala**: ${sanitizeAndTruncate(b.blockedReason, 140)}\n` +
      `   🕒 **Waktu Terblokir**: ${new Date(b.blockedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`
    );
  });

  return new EmbedBuilder()
    .setTitle(`🚫 Issue Terblokir (${blocked.length})`)
    .setColor(EMBED_COLORS.BLOCKED)
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: `Halaman ${pageIndex + 1}/${totalPages} • Memerlukan eskalasi & tindak lanjut` })
    .setTimestamp();
}

/**
 * /project unassigned Embed
 */
export function buildUnassignedIssuesEmbed(
  issues: IssueSummary[],
  pageIndex: number,
  totalPages: number,
): EmbedBuilder {
  if (issues.length === 0) {
    return new EmbedBuilder()
      .setTitle('📋 Issue Belum Ditugaskan (0)')
      .setColor(EMBED_COLORS.SUCCESS)
      .setDescription('✨ **Semua issue telah memiliki pemilik!** Tidak ada backlog terbuka yang belum ditugaskan.')
      .setTimestamp();
  }

  const lines = issues.map((i) => {
    const pEmoji = i.projectPriority ? (PRIORITY_EMOJIS[i.projectPriority] ?? '▫️') : '▫️';
    return (
      `${pEmoji} [**#${i.number} ${sanitizeAndTruncate(i.title, 60)}**](${i.htmlUrl})\n` +
      `   Prioritas: **${i.projectPriority ?? 'None'}** • Pembuat: @${i.author} • Dibuat: ${new Date(i.createdAt).toLocaleDateString('id-ID')}`
    );
  });

  return new EmbedBuilder()
    .setTitle(`📋 Issue Terbuka Belum Ditugaskan (${issues.length})`)
    .setColor(EMBED_COLORS.IN_PROGRESS)
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: `Halaman ${pageIndex + 1}/${totalPages} • Diurutkan berdasarkan prioritas` })
    .setTimestamp();
}

/**
 * /project reviews Embed
 */
export function buildReviewsEmbed(
  reviews: ReviewRequestSummary[],
  pageIndex: number,
  totalPages: number,
): EmbedBuilder {
  if (reviews.length === 0) {
    return new EmbedBuilder()
      .setTitle('🔍 Antrean Code Review (0)')
      .setColor(EMBED_COLORS.SUCCESS)
      .setDescription('✨ **Antrean bersih!** Tidak ada Pull Request yang sedang menunggu code review.')
      .setTimestamp();
  }

  const lines = reviews.map((r) => {
    const statusText = r.draft ? '📝 *Draft*' : '🚀 *Ready for Review*';
    const reviewers = r.requestedReviewers.length > 0 ? `@${r.requestedReviewers.join(', @')}` : 'Belum Ditentukan';
    return (
      `🔀 [**#${r.pullNumber} ${sanitizeAndTruncate(r.title, 60)}**](${r.htmlUrl})\n` +
      `   ${statusText} • Pembuat: @${r.author} • Reviewer: ${reviewers}`
    );
  });

  return new EmbedBuilder()
    .setTitle(`🔍 Antrean Code Review PR (${reviews.length})`)
    .setColor(EMBED_COLORS.IN_REVIEW)
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: `Halaman ${pageIndex + 1}/${totalPages} • Menunggu persetujuan kolaborator` })
    .setTimestamp();
}

export interface DigestEmbedOptions {
  isScheduled?: boolean;
  dateStr?: string;
}

/**
 * /project digest Embed (On-demand preview or scheduled daily digest)
 */
export function buildDigestEmbed(
  summary: ProjectSummary,
  blocked: BlockedIssueSummary[],
  reviews: ReviewRequestSummary[],
  unassigned?: IssueSummary[],
  options?: DigestEmbedOptions,
): EmbedBuilder {
  const isScheduled = options?.isScheduled ?? false;
  const embedColor = isScheduled && blocked.length > 0 ? EMBED_COLORS.BLOCKED : EMBED_COLORS.BRAND;

  const embed = new EmbedBuilder()
    .setTitle(`🌅 Ringkasan Harian Proyek: ${sanitizeAndTruncate(summary.title, 100)}`)
    .setColor(embedColor)
    .setDescription(
      isScheduled
        ? 'Ringkasan status proyek GitHub Projects v2 dan metrik alur kerja harian.'
        : 'Pratinjau kesehatan alur kerja, pipa status, dan peringatan kendala proyek.',
    )
    .addFields(
      {
        name: '📊 Alur Kerja Pipa Status',
        value:
          `📥 Backlog: \`${summary.statusCounts.Backlog ?? 0}\`  |  📋 Ready: \`${summary.statusCounts.Ready ?? 0}\`\n` +
          `🔄 In Progress: \`${summary.statusCounts['In Progress'] ?? 0}\`  |  🔍 In Review: \`${summary.statusCounts['In Review'] ?? 0}\`\n` +
          `✅ Done: \`${summary.statusCounts.Done ?? 0}\`  |  🚫 Blocked: \`${summary.statusCounts.Blocked ?? 0}\``,
        inline: false,
      },
      {
        name: '📈 Metrik Total Terbuka',
        value: `Total Issue: **${summary.totalOpenIssues}**  •  Total Pull Request: **${summary.totalOpenPullRequests}**`,
        inline: false,
      },
    );

  if (blocked.length > 0) {
    const topBlocked = blocked
      .slice(0, 5)
      .map((b) => `• [#${b.number}](${b.htmlUrl}): ${sanitizeAndTruncate(b.blockedReason, 60)}`)
      .join('\n');
    embed.addFields({
      name: `⚠️ Perhatian Diperlukan: ${blocked.length} Issue Terblokir`,
      value: topBlocked,
      inline: false,
    });
  }

  if (unassigned && unassigned.length > 0) {
    const topUnassigned = unassigned
      .slice(0, 5)
      .map(
        (u) =>
          `• [#${u.number}](${u.htmlUrl}): ${sanitizeAndTruncate(u.title, 60)} (${u.projectPriority ? `Prioritas: ${u.projectPriority}` : 'Tanpa Prioritas'})`,
      )
      .join('\n');
    embed.addFields({
      name: `📋 Issue Belum Ditugaskan (${unassigned.length})`,
      value: topUnassigned,
      inline: false,
    });
  }

  if (reviews.length > 0) {
    const topReviews = reviews
      .slice(0, 5)
      .map(
        (r) =>
          `• [#${r.pullNumber}](${r.htmlUrl}) oleh @${r.author} (${r.requestedReviewers.map((u) => '@' + u).join(', ') || 'Pending'})`,
      )
      .join('\n');
    embed.addFields({
      name: `🔍 Menunggu Review: ${reviews.length} Pull Request`,
      value: topReviews,
      inline: false,
    });
  }

  if (isScheduled) {
    const dateDisplay = options?.dateStr ?? 'Hari Ini';
    embed.setFooter({
      text: `Project #${summary.projectNumber} • Ringkasan Harian Terjadwal • ${dateDisplay} • 09:00 WIB`,
    });
    embed.setTimestamp();
  } else {
    embed.setFooter({
      text: 'Pratinjau on-demand • Digest otomatis terjadwal setiap hari kerja pukul 09:00 WIB',
    });
  }

  return embed;
}

/**
 * Webhook Notification: Issues Event Embed
 */
export function buildIssueWebhookEmbed(
  action: 'opened' | 'assigned' | 'reopened' | 'closed',
  issue: {
    number: number;
    title: string;
    htmlUrl: string;
    body?: string | null;
    author: string;
    assigneeLogin?: string;
  },
): EmbedBuilder {
  const safeTitle = sanitizeAndTruncate(issue.title, 100);

  let title = '';
  let color: number = EMBED_COLORS.BRAND;
  let description = `[#${issue.number}](${issue.htmlUrl}) **${safeTitle}**`;

  switch (action) {
    case 'opened':
      title = `📌 Issue Baru Dibuka: #${issue.number}`;
      color = EMBED_COLORS.READY;
      if (issue.body && issue.body.trim().length > 0) {
        description += `\n\n${sanitizeAndTruncate(issue.body, 250)}`;
      }
      break;
    case 'assigned':
      title = `👤 Penugasan Issue: #${issue.number}`;
      color = EMBED_COLORS.IN_PROGRESS;
      break;
    case 'reopened':
      title = `🔄 Issue Dibuka Kembali: #${issue.number}`;
      color = EMBED_COLORS.READY;
      break;
    case 'closed':
      title = `✅ Issue Ditutup: #${issue.number}`;
      color = EMBED_COLORS.SUCCESS;
      break;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setURL(issue.htmlUrl)
    .setDescription(description)
    .addFields({
      name: 'Pembuat',
      value: `@${issue.author}`,
      inline: true,
    });

  if (action === 'assigned' && issue.assigneeLogin) {
    embed.addFields({
      name: 'Ditugaskan Kepada',
      value: `@${issue.assigneeLogin}`,
      inline: true,
    });
  }

  embed.setTimestamp();
  return embed;
}

/**
 * Webhook Notification: Pull Request Event Embed
 */
export function buildPullRequestWebhookEmbed(
  action: 'review_requested' | 'ready_for_review' | 'merged' | 'closed',
  pr: {
    number: number;
    title: string;
    htmlUrl: string;
    author: string;
    headRef?: string;
    baseRef?: string;
    requestedReviewerLogin?: string;
  },
): EmbedBuilder {
  const safeTitle = sanitizeAndTruncate(pr.title, 100);

  let title = '';
  let color: number = EMBED_COLORS.IN_REVIEW;

  switch (action) {
    case 'review_requested':
      title = `🔍 Permintaan Code Review PR: #${pr.number}`;
      color = EMBED_COLORS.IN_REVIEW;
      break;
    case 'ready_for_review':
      title = `🚀 PR Siap Ditinjau: #${pr.number}`;
      color = EMBED_COLORS.IN_REVIEW;
      break;
    case 'merged':
      title = `🔀 Pull Request Digabungkan: #${pr.number}`;
      color = EMBED_COLORS.SUCCESS;
      break;
    case 'closed':
      title = `🛑 Pull Request Ditutup: #${pr.number}`;
      color = EMBED_COLORS.BACKLOG;
      break;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setURL(pr.htmlUrl)
    .setDescription(`[#${pr.number}](${pr.htmlUrl}) **${safeTitle}**`)
    .addFields({
      name: 'Penulis',
      value: `@${pr.author}`,
      inline: true,
    });

  if (action === 'review_requested' && pr.requestedReviewerLogin) {
    embed.addFields({
      name: 'Reviewer Diminta',
      value: `@${pr.requestedReviewerLogin}`,
      inline: true,
    });
  }

  if (pr.headRef && pr.baseRef) {
    embed.addFields({
      name: 'Branch',
      value: `\`${sanitizeAndTruncate(pr.headRef, 30)}\` ➔ \`${sanitizeAndTruncate(pr.baseRef, 30)}\``,
      inline: false,
    });
  }

  embed.setTimestamp();
  return embed;
}

/**
 * Webhook Notification: CI Failure Event Embed
 */
export function buildCiFailureWebhookEmbed(run: {
  name: string;
  htmlUrl: string;
  headBranch: string;
  headSha: string;
  conclusion: string;
  actorLogin: string;
  repoFullName: string;
}): EmbedBuilder {
  const safeName = sanitizeAndTruncate(run.name, 100);
  const shortSha = run.headSha ? run.headSha.slice(0, 7) : 'n/a';
  const conclusionIndonesian =
    run.conclusion === 'timed_out' ? 'Waktu Habis (Timed Out)' : 'Gagal (Failure)';

  return new EmbedBuilder()
    .setTitle(`❌ CI Pipeline Gagal: ${safeName}`)
    .setColor(EMBED_COLORS.BLOCKED)
    .setURL(run.htmlUrl)
    .addFields(
      { name: 'Workflow', value: safeName, inline: true },
      { name: 'Branch', value: `\`${sanitizeAndTruncate(run.headBranch, 40)}\``, inline: true },
      { name: 'Commit', value: `\`${shortSha}\``, inline: true },
      { name: 'Hasil', value: `⚠️ ${conclusionIndonesian}`, inline: true },
      { name: 'Pemicu', value: `@${run.actorLogin}`, inline: true },
    )
    .setFooter({ text: `${run.repoFullName} • Asia/Jakarta (WIB)` })
    .setTimestamp();
}

/**
 * /issue view <number> Embed with ActionRow Link Button
 */
export function buildIssueDetailEmbed(detail: IssueDetail): {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const statusEmoji = detail.projectStatus ? (STATUS_EMOJIS[detail.projectStatus] ?? '▫️') : '▫️';
  const priorityEmoji = detail.projectPriority ? (PRIORITY_EMOJIS[detail.projectPriority] ?? '▫️') : '▫️';
  const stateEmoji = detail.state === 'OPEN' ? '🟢' : '🔴';

  const embed = new EmbedBuilder()
    .setTitle(`[#${detail.number}] ${sanitizeAndTruncate(detail.title, 200)}`)
    .setURL(detail.htmlUrl)
    .setColor(getStatusColor(detail.projectStatus))
    .addFields(
      { name: 'State', value: `${stateEmoji} ${detail.state}`, inline: true },
      { name: 'Status', value: `${statusEmoji} ${detail.projectStatus ?? 'None'}`, inline: true },
      { name: 'Prioritas', value: `${priorityEmoji} ${detail.projectPriority ?? 'None'}`, inline: true },
      {
        name: 'Assignee',
        value: detail.assignees.length > 0 ? `@${detail.assignees.join(', @')}` : 'Unassigned',
        inline: true,
      },
      { name: 'Pembuat', value: `@${detail.author}`, inline: true },
      { name: 'Komentar', value: `💬 ${detail.commentsCount}`, inline: true },
    );

  if (detail.labels && detail.labels.length > 0) {
    embed.addFields({
      name: 'Label',
      value: detail.labels.map((l) => `\`${l}\``).join(', '),
      inline: false,
    });
  }

  if (detail.blockedReason) {
    embed.addFields({
      name: '🚫 Alasan Kendala (Blocker)',
      value: `⚠️ ${sanitizeAndTruncate(detail.blockedReason, 1000)}`,
      inline: false,
    });
  }

  if (detail.body && detail.body.trim().length > 0) {
    embed.addFields({
      name: 'Pratinjau Deskripsi',
      value: sanitizeAndTruncate(detail.body, 400),
      inline: false,
    });
  }

  embed.setFooter({
    text: `Dibuat: ${new Date(detail.createdAt).toLocaleDateString('id-ID')} • Diperbarui: ${new Date(detail.updatedAt).toLocaleDateString('id-ID')}`,
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Buka di GitHub')
      .setURL(detail.htmlUrl)
      .setEmoji('🔗'),
  );

  return { embed, components: [row] };
}

/**
 * Diff Preview Embed for 2-phase Write Confirmations
 */
export function buildDiffPreviewEmbed(options: {
  action: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  diffField: string;
  diffOld: string;
  diffNew: string;
  actorLogin: string;
  expiresAt: number;
  notice?: string;
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`📋 Konfirmasi Diperlukan: ${options.action} pada Issue #${options.issueNumber}`)
    .setColor(EMBED_COLORS.DIFF_PREVIEW)
    .setDescription(
      `Periksa perubahan di bawah ini sebelum mengonfirmasi. Sesi konfirmasi berlaku selama 60 detik.`,
    )
    .addFields(
      {
        name: 'Target Issue',
        value: `[#${options.issueNumber}: ${sanitizeAndTruncate(options.issueTitle, 100)}](${options.issueUrl})`,
        inline: false,
      },
      {
        name: `Pratinjau Perubahan (${options.diffField})`,
        value: `\`${options.diffOld}\` ➔ **\`${options.diffNew}\`**`,
        inline: false,
      },
      {
        name: 'Inisiator',
        value: `@${options.actorLogin}`,
        inline: true,
      },
      {
        name: 'Kedaluwarsa',
        value: `<t:${Math.floor(options.expiresAt / 1000)}:R>`,
        inline: true,
      },
    );

  if (options.notice) {
    embed.addFields({
      name: '⚠️ Catatan Penting',
      value: sanitizeAndTruncate(options.notice, 400),
      inline: false,
    });
  }

  embed.setFooter({ text: 'Hanya pengguna yang menjalankan perintah yang dapat menekan tombol konfirmasi.' });
  return embed;
}

/**
 * Standardized User-Facing Error Embed
 */
export function buildErrorEmbed(error: unknown): EmbedBuilder {
  let message = 'Terjadi kesalahan internal yang tidak diharapkan. Silakan hubungi administrator jika masalah berlanjut.';
  let code = 'ERROR';
  let title = '❌ Permintaan Gagal (System Error)';
  let color: number = EMBED_COLORS.BLOCKED;

  if (error instanceof DomainError) {
    code = error.code;
    message = error.message;

    switch (error.code) {
      case 'UNAUTHORIZED':
        title = '🚫 Akses Ditolak (Unauthorized)';
        color = 0xED4245;
        break;
      case 'VALIDATION_ERROR':
        title = '⚠️ Validasi Tidak Sesuai (Validation Error)';
        color = 0xFEE75C;
        break;
      case 'CONFLICT':
        title = '⚡ Terjadi Konflik Status (Concurrency Conflict)';
        color = 0xE67E22;
        break;
      case 'NOT_FOUND':
        title = '🔍 Data Tidak Ditemukan (Not Found)';
        color = 0x95A5A6;
        break;
      case 'PENDING_PERMISSION':
        title = '🔒 Izin Proyek Belum Diberikan (Pending Permission)';
        color = 0x992D22;
        break;
      case 'RATE_LIMIT_EXCEEDED':
        title = '⏳ Batas Permintaan Terlampaui (Rate Limit Exceeded)';
        color = 0xF1C40F;
        break;
      case 'EXTERNAL_API_ERROR':
        title = '🌐 Layanan Eksternal Mengalami Gangguan (External API Error)';
        color = 0xED4245;
        break;
      default:
        title = `❌ Permintaan Gagal (${code})`;
        color = 0xED4245;
        break;
    }
  } else if (error instanceof Error) {
    message = error.message;
    title = '❌ Permintaan Gagal';
  }

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(sanitizeAndTruncate(message, 1500))
    .setTimestamp();
}
