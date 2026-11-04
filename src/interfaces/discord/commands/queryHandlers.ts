import type { ChatInputCommandInteraction } from 'discord.js';
import type { IGitHubService } from '../../../application/ports/IGitHubService.js';
import type { IAuthorizationService } from '../../../application/ports/IAuthorizationService.js';
import {
  buildProjectStatusEmbed,
  buildIssueListEmbed,
  buildMyWorkEmbed,
  buildBlockedIssuesEmbed,
  buildUnassignedIssuesEmbed,
  buildReviewsEmbed,
  buildDigestEmbed,
  buildIssueDetailEmbed,
} from '../embeds.js';
import { PaginationManager } from '../pagination.js';

export interface QueryHandlerDeps {
  gitHubService: IGitHubService;
  authService: IAuthorizationService;
  paginationManager: PaginationManager;
}

/**
 * Handles all /project query subcommands:
 * status, issues, mine, blocked, unassigned, reviews, digest
 */
export async function handleProjectQueryCommand(
  interaction: ChatInputCommandInteraction,
  deps: QueryHandlerDeps,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const principal = await deps.authService.resolvePrincipal(
    interaction.user.id,
    interaction.guildId ?? '',
    interaction.channelId,
  );

  switch (subcommand) {
    case 'status': {
      const decision = deps.authService.authorizeRead(principal, 'view_status');
      if (!decision.allowed) throw new Error(decision.reason ?? 'Read unauthorized');

      const summary = await deps.gitHubService.getProjectSummary();
      const embed = buildProjectStatusEmbed(summary);
      await interaction.editReply({ embeds: [embed], components: [] });
      break;
    }

    case 'issues': {
      const decision = deps.authService.authorizeRead(principal, 'list_issues');
      if (!decision.allowed) throw new Error(decision.reason ?? 'Read unauthorized');

      const status = interaction.options.getString('status') ?? undefined;
      const assignee = interaction.options.getString('assignee') ?? undefined;
      const limit = interaction.options.getInteger('limit') ?? 50;

      const issues = await deps.gitHubService.listIssues({ status, assignee, limit });

      if (issues.length <= 10) {
        const embed = buildIssueListEmbed(
          issues,
          { status, assignee },
          0,
          Math.max(1, Math.ceil(issues.length / 10)),
        );
        await interaction.editReply({ embeds: [embed], components: [] });
      } else {
        const { firstPageEmbed, actionRow } = deps.paginationManager.createSession(
          interaction.user.id,
          issues,
          (pageItems, pageIdx, totalPages) =>
            buildIssueListEmbed(pageItems, { status, assignee }, pageIdx, totalPages),
        );
        await interaction.editReply({
          embeds: [firstPageEmbed],
          components: [actionRow],
        });
      }
      break;
    }

    case 'mine': {
      // Must have verified linked GitHub account
      deps.authService.requireVerifiedIdentity(principal);

      const [myIssues, myReviews] = await Promise.all([
        deps.gitHubService.listMyIssues(principal.identity.githubUserId),
        deps.gitHubService.listReviewRequests(principal.identity.githubUserId),
      ]);

      const embed = buildMyWorkEmbed(
        principal.identity.githubLogin,
        myIssues,
        myReviews,
      );
      await interaction.editReply({ embeds: [embed], components: [] });
      break;
    }

    case 'blocked': {
      const decision = deps.authService.authorizeRead(principal, 'view_blocked');
      if (!decision.allowed) throw new Error(decision.reason ?? 'Read unauthorized');

      const blocked = await deps.gitHubService.listBlockedIssues();

      if (blocked.length <= 10) {
        const embed = buildBlockedIssuesEmbed(
          blocked,
          0,
          Math.max(1, Math.ceil(blocked.length / 10)),
        );
        await interaction.editReply({ embeds: [embed], components: [] });
      } else {
        const { firstPageEmbed, actionRow } = deps.paginationManager.createSession(
          interaction.user.id,
          blocked,
          (pageItems, pageIdx, totalPages) =>
            buildBlockedIssuesEmbed(pageItems, pageIdx, totalPages),
        );
        await interaction.editReply({
          embeds: [firstPageEmbed],
          components: [actionRow],
        });
      }
      break;
    }

    case 'unassigned': {
      const decision = deps.authService.authorizeRead(principal, 'view_unassigned');
      if (!decision.allowed) throw new Error(decision.reason ?? 'Read unauthorized');

      const unassigned = await deps.gitHubService.listUnassignedIssues();

      // Deterministic sort by canonical priority: Urgent (1) > High (2) > Medium (3) > Low (4) > None (5)
      const priorityOrder: Record<string, number> = {
        Urgent: 1,
        High: 2,
        Medium: 3,
        Low: 4,
      };

      unassigned.sort((a, b) => {
        const scoreA = a.projectPriority ? (priorityOrder[a.projectPriority] ?? 5) : 5;
        const scoreB = b.projectPriority ? (priorityOrder[b.projectPriority] ?? 5) : 5;
        if (scoreA !== scoreB) {
          return scoreA - scoreB;
        }
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

      if (unassigned.length <= 10) {
        const embed = buildUnassignedIssuesEmbed(
          unassigned,
          0,
          Math.max(1, Math.ceil(unassigned.length / 10)),
        );
        await interaction.editReply({ embeds: [embed], components: [] });
      } else {
        const { firstPageEmbed, actionRow } = deps.paginationManager.createSession(
          interaction.user.id,
          unassigned,
          (pageItems, pageIdx, totalPages) =>
            buildUnassignedIssuesEmbed(pageItems, pageIdx, totalPages),
        );
        await interaction.editReply({
          embeds: [firstPageEmbed],
          components: [actionRow],
        });
      }
      break;
    }

    case 'reviews': {
      const decision = deps.authService.authorizeRead(principal, 'view_reviews');
      if (!decision.allowed) throw new Error(decision.reason ?? 'Read unauthorized');

      const reviews = await deps.gitHubService.listReviewRequests();

      if (reviews.length <= 10) {
        const embed = buildReviewsEmbed(
          reviews,
          0,
          Math.max(1, Math.ceil(reviews.length / 10)),
        );
        await interaction.editReply({ embeds: [embed], components: [] });
      } else {
        const { firstPageEmbed, actionRow } = deps.paginationManager.createSession(
          interaction.user.id,
          reviews,
          (pageItems, pageIdx, totalPages) =>
            buildReviewsEmbed(pageItems, pageIdx, totalPages),
        );
        await interaction.editReply({
          embeds: [firstPageEmbed],
          components: [actionRow],
        });
      }
      break;
    }

    case 'digest': {
      const decision = deps.authService.authorizeRead(principal, 'view_digest');
      if (!decision.allowed) throw new Error(decision.reason ?? 'Read unauthorized');

      const [summary, blocked, reviews] = await Promise.all([
        deps.gitHubService.getProjectSummary(),
        deps.gitHubService.listBlockedIssues(),
        deps.gitHubService.listReviewRequests(),
      ]);

      const embed = buildDigestEmbed(summary, blocked, reviews);
      await interaction.editReply({ embeds: [embed], components: [] });
      break;
    }

    default:
      throw new Error(`Subcommand /project '${subcommand}' tidak dikenal.`);
  }
}

/**
 * Handles /issue view <number>
 */
export async function handleIssueViewCommand(
  interaction: ChatInputCommandInteraction,
  deps: QueryHandlerDeps,
): Promise<void> {
  const issueNumber = interaction.options.getInteger('number', true);
  const principal = await deps.authService.resolvePrincipal(
    interaction.user.id,
    interaction.guildId ?? '',
    interaction.channelId,
  );

  const decision = deps.authService.authorizeRead(principal, 'view_issue');
  if (!decision.allowed) throw new Error(decision.reason ?? 'Read unauthorized');

  const issueDetail = await deps.gitHubService.getIssue(issueNumber);
  const { embed, components } = buildIssueDetailEmbed(issueDetail);

  await interaction.editReply({
    embeds: [embed],
    components,
  });
}
