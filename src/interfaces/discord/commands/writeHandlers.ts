import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type {
  CanonicalStatus,
  CanonicalPriority,
} from '../../../domain/types.js';
import type { IAuthorizationService } from '../../../application/ports/IAuthorizationService.js';
import type { IGitHubService } from '../../../application/ports/IGitHubService.js';
import type { AuditService } from '../../../application/services/AuditService.js';
import {
  ConfirmationStore,
  type PendingConfirmationSession,
} from '../confirmations.js';
import {
  buildDiffPreviewEmbed,
  buildIssueDetailEmbed,
  EMBED_COLORS,
} from '../embeds.js';
import { ValidationError, ConflictError } from '../../../domain/errors.js';
import {
  StatusTransitionPolicy,
  MentionPolicy,
} from '../../../domain/policies.js';

export interface WriteHandlerDeps {
  authService: IAuthorizationService;
  gitHubService: IGitHubService;
  auditService: AuditService;
  confirmationStore: ConfirmationStore;
}

function buildConfirmationButtons(
  action: string,
  issueNumber: number,
  callerDiscordId: string,
  timestamp: number,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm:${action}:${issueNumber}:${callerDiscordId}:${timestamp}`)
      .setLabel('Konfirmasi')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`cancel:${action}:${issueNumber}:${callerDiscordId}:${timestamp}`)
      .setLabel('Batalkan')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('❌'),
  );
}

/**
 * Initiates /issue create by rendering a Discord Modal dialog.
 * Discord requires showModal to be invoked immediately without prior deferral.
 */
export async function handleIssueCreateInitiate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const selectedType = interaction.options.getString('type') ?? 'task';
  const prefillTitle = interaction.options.getString('title') ?? '';

  const modal = new ModalBuilder()
    .setCustomId(`modal:issue_create:${selectedType}`)
    .setTitle('Buat Issue GitHub Baru');

  const titleInput = new TextInputBuilder()
    .setCustomId('issue_title')
    .setLabel('Judul Issue')
    .setStyle(TextInputStyle.Short)
    .setValue(prefillTitle)
    .setMinLength(3)
    .setMaxLength(256)
    .setPlaceholder('Ringkasan singkat masalah atau tugas')
    .setRequired(true);

  const descInput = new TextInputBuilder()
    .setCustomId('issue_description')
    .setLabel('Deskripsi Lengkap')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(10)
    .setMaxLength(4000)
    .setPlaceholder('Jelaskan konteks, latar belakang, dan detail teknis masalah...')
    .setRequired(true);

  const criteriaInput = new TextInputBuilder()
    .setCustomId('issue_criteria')
    .setLabel('Kriteria Penerimaan (Acceptance Criteria)')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(0)
    .setMaxLength(2000)
    .setPlaceholder('- [ ] Unit tests lulus 100%\n- [ ] Clean Architecture terpenuhi')
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(descInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(criteriaInput),
  );

  await interaction.showModal(modal);
}

/**
 * Handles submission of the /issue create modal dialog.
 */
export async function handleIssueCreateModalSubmit(
  interaction: ModalSubmitInteraction,
  deps: WriteHandlerDeps,
): Promise<void> {
  const principal = await deps.authService.resolvePrincipal(
    interaction.user.id,
    interaction.guildId ?? '',
  );
  const verifiedPrincipal = await deps.authService.assertAuthorizedWrite(principal, 'create_issue');

  const title = interaction.fields.getTextInputValue('issue_title').trim();
  const description = interaction.fields.getTextInputValue('issue_description').trim();
  const criteria = interaction.fields.getTextInputValue('issue_criteria')?.trim();

  if (title.length < 3) {
    throw new ValidationError('Judul issue minimal 3 karakter.');
  }

  let body = description;
  if (criteria && criteria.length > 0) {
    body += `\n\n### Acceptance Criteria\n${criteria}`;
  }

  // Extract type from customId modal:issue_create:<type>
  const parts = interaction.customId.split(':');
  const issueType = parts[2] ?? 'task';

  const newIssue = await deps.gitHubService.createIssue({
    title,
    body,
    type: issueType,
    actorGithubUserId: verifiedPrincipal.identity.githubUserId,
  });

  await deps.auditService.logMutation({
    actorDiscordId: interaction.user.id,
    actorGithubId: verifiedPrincipal.identity.githubUserId,
    actorGithubLogin: verifiedPrincipal.identity.githubLogin,
    action: 'ISSUE_CREATE',
    targetIssueNumber: newIssue.number,
    beforeState: null,
    afterState: {
      number: newIssue.number,
      title: newIssue.title,
      htmlUrl: newIssue.htmlUrl,
      type: issueType,
    },
    outcome: 'SUCCESS',
    correlationId: interaction.id,
  });

  const { embed, components } = buildIssueDetailEmbed(newIssue);
  await interaction.editReply({
    embeds: [embed],
    components,
  });
}

/**
 * Phase 1 for /issue assign:
 * Verifies live permissions, creates 60s confirmation session, renders Diff Preview.
 */
export async function handleIssueAssignCommand(
  interaction: ChatInputCommandInteraction,
  deps: WriteHandlerDeps,
): Promise<void> {
  const issueNumber = interaction.options.getInteger('number', true);
  let developer = interaction.options.getString('developer', true).trim();

  // Strip mention wrappers if input like <@12345678> or @user
  if (developer.startsWith('@')) {
    developer = developer.slice(1);
  }

  const principal = await deps.authService.resolvePrincipal(
    interaction.user.id,
    interaction.guildId ?? '',
  );
  const verifiedPrincipal = await deps.authService.assertAuthorizedWrite(principal, 'assign_issue', {
    targetAssigneeGithubLogin: developer,
  });

  const [issue, targetPermission] = await Promise.all([
    deps.gitHubService.getIssue(issueNumber),
    deps.gitHubService.getUserRepoPermission(developer),
  ]);

  if (targetPermission === 'none') {
    throw new ValidationError(
      `Pengguna '@${developer}' bukan kolaborator repository yang valid atau tidak ditemukan di GitHub.`,
    );
  }

  const isAlreadyAssigned = issue.assignees
    .map((a) => a.toLowerCase())
    .includes(developer.toLowerCase());

  if (isAlreadyAssigned) {
    throw new ConflictError(
      `Issue #${issueNumber} sudah ditugaskan kepada @${developer}.`,
    );
  }

  const timestamp = Date.now();
  const sessionKey = `assign:${issueNumber}:${interaction.user.id}:${timestamp}`;

  const session: PendingConfirmationSession = {
    action: 'assign',
    issueNumber,
    callerDiscordId: interaction.user.id,
    timestamp,
    expiresAt: timestamp + ConfirmationStore.TTL_MS,
    payload: {
      targetAssignee: developer,
      expectedPreviousAssignees: [...issue.assignees],
    },
  };

  deps.confirmationStore.set(sessionKey, session);

  const oldAssignee = issue.assignees.length > 0 ? issue.assignees.join(', ') : 'Unassigned';
  const previewEmbed = buildDiffPreviewEmbed({
    action: 'Penugasan Issue',
    issueNumber,
    issueTitle: issue.title,
    issueUrl: issue.htmlUrl,
    diffField: 'Assignee',
    diffOld: oldAssignee,
    diffNew: `@${developer}`,
    actorLogin: verifiedPrincipal.identity.githubLogin,
    expiresAt: session.expiresAt,
  });

  const actionRow = buildConfirmationButtons('assign', issueNumber, interaction.user.id, timestamp);

  await interaction.editReply({
    embeds: [previewEmbed],
    components: [actionRow],
  });
}

/**
 * Phase 1 for /issue status:
 * Verifies transition policy, creates 60s confirmation session, renders Diff Preview.
 */
export async function handleIssueStatusCommand(
  interaction: ChatInputCommandInteraction,
  deps: WriteHandlerDeps,
): Promise<void> {
  const issueNumber = interaction.options.getInteger('number', true);
  const targetStatus = interaction.options.getString('status', true) as CanonicalStatus;

  const principal = await deps.authService.resolvePrincipal(
    interaction.user.id,
    interaction.guildId ?? '',
  );

  const issue = await deps.gitHubService.getIssue(issueNumber);
  const verifiedPrincipal = await deps.authService.assertAuthorizedWrite(principal, 'update_status', {
    currentAssigneeGithubLogin: issue.assignees[0],
  });

  const currentStatus = issue.projectStatus ?? 'Backlog';
  StatusTransitionPolicy.assertValidTransition(currentStatus, targetStatus);

  const timestamp = Date.now();
  const sessionKey = `status:${issueNumber}:${interaction.user.id}:${timestamp}`;

  const session: PendingConfirmationSession = {
    action: 'status',
    issueNumber,
    callerDiscordId: interaction.user.id,
    timestamp,
    expiresAt: timestamp + ConfirmationStore.TTL_MS,
    payload: {
      targetStatus,
      expectedPreviousStatus: currentStatus,
    },
  };

  deps.confirmationStore.set(sessionKey, session);

  const previewEmbed = buildDiffPreviewEmbed({
    action: 'Pembaruan Status Project v2',
    issueNumber,
    issueTitle: issue.title,
    issueUrl: issue.htmlUrl,
    diffField: 'Canonical Status',
    diffOld: currentStatus,
    diffNew: targetStatus,
    actorLogin: verifiedPrincipal.identity.githubLogin,
    expiresAt: session.expiresAt,
  });

  const actionRow = buildConfirmationButtons('status', issueNumber, interaction.user.id, timestamp);

  await interaction.editReply({
    embeds: [previewEmbed],
    components: [actionRow],
  });
}

/**
 * Phase 1 for /issue priority:
 * Verifies priority difference, creates 60s confirmation session, renders Diff Preview.
 */
export async function handleIssuePriorityCommand(
  interaction: ChatInputCommandInteraction,
  deps: WriteHandlerDeps,
): Promise<void> {
  const issueNumber = interaction.options.getInteger('number', true);
  const targetPriority = interaction.options.getString('priority', true) as CanonicalPriority;

  const principal = await deps.authService.resolvePrincipal(
    interaction.user.id,
    interaction.guildId ?? '',
  );

  const issue = await deps.gitHubService.getIssue(issueNumber);
  const verifiedPrincipal = await deps.authService.assertAuthorizedWrite(principal, 'update_priority', {
    currentAssigneeGithubLogin: issue.assignees[0],
  });

  const currentPriority = issue.projectPriority;
  if (currentPriority === targetPriority) {
    throw new ConflictError(
      `Issue #${issueNumber} sudah memiliki tingkat prioritas '${targetPriority}'.`,
    );
  }

  const timestamp = Date.now();
  const sessionKey = `priority:${issueNumber}:${interaction.user.id}:${timestamp}`;

  const session: PendingConfirmationSession = {
    action: 'priority',
    issueNumber,
    callerDiscordId: interaction.user.id,
    timestamp,
    expiresAt: timestamp + ConfirmationStore.TTL_MS,
    payload: {
      targetPriority,
      expectedPreviousPriority: currentPriority,
    },
  };

  deps.confirmationStore.set(sessionKey, session);

  const previewEmbed = buildDiffPreviewEmbed({
    action: 'Pembaruan Tingkat Prioritas',
    issueNumber,
    issueTitle: issue.title,
    issueUrl: issue.htmlUrl,
    diffField: 'Priority',
    diffOld: currentPriority ?? 'None',
    diffNew: targetPriority,
    actorLogin: verifiedPrincipal.identity.githubLogin,
    expiresAt: session.expiresAt,
  });

  const actionRow = buildConfirmationButtons('priority', issueNumber, interaction.user.id, timestamp);

  await interaction.editReply({
    embeds: [previewEmbed],
    components: [actionRow],
  });
}

/**
 * Phase 1 for /issue block:
 * Enforces mandatory blocker reason (min 3 chars), creates 60s confirmation session.
 */
export async function handleIssueBlockCommand(
  interaction: ChatInputCommandInteraction,
  deps: WriteHandlerDeps,
): Promise<void> {
  const issueNumber = interaction.options.getInteger('number', true);
  const blockerReason = interaction.options.getString('reason', true).trim();

  if (!blockerReason || blockerReason.length < 3) {
    throw new ValidationError(
      'Alasan pemblokiran (blocker reason) wajib diisi dengan minimal 3 karakter.',
    );
  }

  const principal = await deps.authService.resolvePrincipal(
    interaction.user.id,
    interaction.guildId ?? '',
  );

  const issue = await deps.gitHubService.getIssue(issueNumber);
  const verifiedPrincipal = await deps.authService.assertAuthorizedWrite(principal, 'mark_blocked', {
    currentAssigneeGithubLogin: issue.assignees[0],
  });

  const currentStatus = issue.projectStatus ?? 'Backlog';
  StatusTransitionPolicy.assertValidTransition(currentStatus, 'Blocked', blockerReason);

  const timestamp = Date.now();
  const sessionKey = `block:${issueNumber}:${interaction.user.id}:${timestamp}`;

  const session: PendingConfirmationSession = {
    action: 'block',
    issueNumber,
    callerDiscordId: interaction.user.id,
    timestamp,
    expiresAt: timestamp + ConfirmationStore.TTL_MS,
    payload: {
      targetStatus: 'Blocked',
      expectedPreviousStatus: currentStatus,
      blockerReason,
    },
  };

  deps.confirmationStore.set(sessionKey, session);

  const previewEmbed = buildDiffPreviewEmbed({
    action: 'Penandaan Issue Terblokir',
    issueNumber,
    issueTitle: issue.title,
    issueUrl: issue.htmlUrl,
    diffField: 'Status',
    diffOld: currentStatus,
    diffNew: 'Blocked',
    actorLogin: verifiedPrincipal.identity.githubLogin,
    expiresAt: session.expiresAt,
    notice: `Komentar otomatis berisi penjelasan kendala ("${blockerReason}") akan dikirimkan ke issue GitHub.`,
  });

  const actionRow = buildConfirmationButtons('block', issueNumber, interaction.user.id, timestamp);

  await interaction.editReply({
    embeds: [previewEmbed],
    components: [actionRow],
  });
}

/**
 * /issue comment:
 * Validates length, sanitizes text against mention injection, posts comment to GitHub.
 */
export async function handleIssueCommentCommand(
  interaction: ChatInputCommandInteraction,
  deps: WriteHandlerDeps,
): Promise<void> {
  const issueNumber = interaction.options.getInteger('number', true);
  const rawText = interaction.options.getString('text', true).trim();

  if (rawText.length < 1 || rawText.length > 2000) {
    throw new ValidationError('Teks komentar harus memiliki panjang antara 1 hingga 2000 karakter.');
  }

  // Neutralize mention injection (@everyone, @here, role pings)
  const sanitizedText = MentionPolicy.sanitizeDiscordMentions(rawText);

  const principal = await deps.authService.resolvePrincipal(
    interaction.user.id,
    interaction.guildId ?? '',
  );
  const verifiedPrincipal = await deps.authService.assertAuthorizedWrite(principal, 'add_comment');

  const issue = await deps.gitHubService.getIssue(issueNumber);

  const commentBody = `${sanitizedText}\n\n*Dikirim dari Discord oleh @${verifiedPrincipal.identity.githubLogin}*`;
  await deps.gitHubService.addComment(
    issueNumber,
    commentBody,
    verifiedPrincipal.identity.githubUserId,
  );

  await deps.auditService.logMutation({
    actorDiscordId: interaction.user.id,
    actorGithubId: verifiedPrincipal.identity.githubUserId,
    actorGithubLogin: verifiedPrincipal.identity.githubLogin,
    action: 'ISSUE_COMMENT',
    targetIssueNumber: issueNumber,
    beforeState: null,
    afterState: { issueNumber, textPreview: sanitizedText.slice(0, 100) },
    outcome: 'SUCCESS',
    correlationId: interaction.id,
  });

  const commentEmbed = new EmbedBuilder()
    .setTitle(`💬 Komentar Berhasil Ditambahkan ke Issue #${issueNumber}`)
    .setURL(issue.htmlUrl)
    .setColor(EMBED_COLORS.BRAND)
    .setDescription(sanitizedText)
    .setFooter({ text: `Dikomentari oleh @${verifiedPrincipal.identity.githubLogin}` })
    .setTimestamp();

  await interaction.editReply({
    embeds: [commentEmbed],
    components: [],
  });
}
