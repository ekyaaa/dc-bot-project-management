import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EmbedBuilder } from 'discord.js';
import { PaginationManager } from '../../src/interfaces/discord/pagination.js';
import {
  createMockButtonInteraction,
} from '../mocks/MockDiscordInteraction.js';

describe('Discord Button-Based Pagination (PaginationManager)', () => {
  let paginationManager: PaginationManager;

  beforeEach(() => {
    paginationManager = new PaginationManager();
  });

  afterEach(() => {
    paginationManager.destroy();
  });

  it('creates a pagination session with correct total pages and boundary button states', () => {
    const items = Array.from({ length: 25 }, (_, i) => `Item #${i + 1}`);

    const renderPage = (pageItems: string[], pageIndex: number, totalPages: number) => {
      return new EmbedBuilder()
        .setTitle(`Page ${pageIndex + 1}/${totalPages}`)
        .setDescription(pageItems.join('\n'));
    };

    const { firstPageEmbed, actionRow, totalPages } = paginationManager.createSession(
      'user_123',
      items,
      renderPage,
      10, // 10 per page -> 3 pages
    );

    expect(totalPages).toBe(3);
    expect(firstPageEmbed.data.title).toBe('Page 1/3');
    expect(firstPageEmbed.data.description).toContain('Item #1');
    expect(firstPageEmbed.data.description).toContain('Item #10');
    expect(firstPageEmbed.data.description).not.toContain('Item #11');

    // Action row components
    const components = actionRow.components;
    expect(components).toHaveLength(5);
    // First button (⏮ First) disabled on page 0
    expect((components[0] as any).data.disabled).toBe(true);
    // Prev button (◀ Prev) disabled on page 0
    expect((components[1] as any).data.disabled).toBe(true);
    // Counter button (Page 1/3) disabled always
    expect((components[2] as any).data.disabled).toBe(true);
    expect((components[2] as any).data.label).toBe('Page 1/3');
    // Next button (Next ▶) enabled on page 0
    expect((components[3] as any).data.disabled).toBe(false);
    // Last button (⏭ Last) enabled on page 0
    expect((components[4] as any).data.disabled).toBe(false);
  });

  it('navigates forward with next button and updates page items', async () => {
    const items = Array.from({ length: 25 }, (_, i) => `Item #${i + 1}`);

    const renderPage = (pageItems: string[], pageIndex: number, totalPages: number) => {
      return new EmbedBuilder()
        .setTitle(`Page ${pageIndex + 1}/${totalPages}`)
        .setDescription(pageItems.join('\n'));
    };

    const { actionRow } = paginationManager.createSession(
      'user_123',
      items,
      renderPage,
      10,
    );

    // Extract session ID from button customId: page:<sessionId>:next
    const nextBtnCustomId = (actionRow.components[3] as any).data.custom_id;
    const interaction = createMockButtonInteraction(nextBtnCustomId, {
      id: 'user_123',
      username: 'caller',
    });

    const handled = await paginationManager.handleButtonInteraction(interaction as any);
    expect(handled).toBe(true);
    expect(interaction.updated).toBe(true);
    expect(interaction.updatePayload.embeds[0].data.title).toBe('Page 2/3');
    expect(interaction.updatePayload.embeds[0].data.description).toContain('Item #11');

    // On page 2 (index 1), First and Prev buttons should be enabled
    const updatedButtons = interaction.updatePayload.components[0].components;
    expect(updatedButtons[0].data.disabled).toBe(false); // First enabled
    expect(updatedButtons[1].data.disabled).toBe(false); // Prev enabled
    expect(updatedButtons[2].data.label).toBe('Page 2/3'); // Counter
    expect(updatedButtons[3].data.disabled).toBe(false); // Next enabled
    expect(updatedButtons[4].data.disabled).toBe(false); // Last enabled
  });

  it('navigates to last page and disables Next and Last buttons', async () => {
    const items = Array.from({ length: 25 }, (_, i) => `Item #${i + 1}`);

    const renderPage = (pageItems: string[], pageIndex: number, totalPages: number) => {
      return new EmbedBuilder()
        .setTitle(`Page ${pageIndex + 1}/${totalPages}`)
        .setDescription(pageItems.join('\n'));
    };

    const { actionRow } = paginationManager.createSession(
      'user_123',
      items,
      renderPage,
      10,
    );

    const lastBtnCustomId = (actionRow.components[4] as any).data.custom_id;
    const interaction = createMockButtonInteraction(lastBtnCustomId, {
      id: 'user_123',
      username: 'caller',
    });

    await paginationManager.handleButtonInteraction(interaction as any);
    expect(interaction.updated).toBe(true);
    expect(interaction.updatePayload.embeds[0].data.title).toBe('Page 3/3');
    expect(interaction.updatePayload.embeds[0].data.description).toContain('Item #25');

    const updatedButtons = interaction.updatePayload.components[0].components;
    expect(updatedButtons[0].data.disabled).toBe(false); // First enabled
    expect(updatedButtons[1].data.disabled).toBe(false); // Prev enabled
    expect(updatedButtons[2].data.label).toBe('Page 3/3');
    expect(updatedButtons[3].data.disabled).toBe(true); // Next disabled
    expect(updatedButtons[4].data.disabled).toBe(true); // Last disabled
  });

  it('navigates backwards with prev button and first button', async () => {
    const items = Array.from({ length: 30 }, (_, i) => `Item #${i + 1}`);

    const renderPage = (pageItems: string[], pageIndex: number, totalPages: number) => {
      return new EmbedBuilder()
        .setTitle(`Page ${pageIndex + 1}/${totalPages}`)
        .setDescription(pageItems.join('\n'));
    };

    const { actionRow } = paginationManager.createSession(
      'user_123',
      items,
      renderPage,
      10,
    );

    const sessionId = (actionRow.components[0] as any).data.custom_id.split(':')[1];

    // Jump to last page first
    const lastInteraction = createMockButtonInteraction(`page:${sessionId}:last`, {
      id: 'user_123',
      username: 'caller',
    });
    await paginationManager.handleButtonInteraction(lastInteraction as any);
    expect(lastInteraction.updatePayload.embeds[0].data.title).toBe('Page 3/3');

    // Click Prev -> should go to Page 2/3
    const prevInteraction = createMockButtonInteraction(`page:${sessionId}:prev`, {
      id: 'user_123',
      username: 'caller',
    });
    await paginationManager.handleButtonInteraction(prevInteraction as any);
    expect(prevInteraction.updatePayload.embeds[0].data.title).toBe('Page 2/3');

    // Click First -> should go to Page 1/3
    const firstInteraction = createMockButtonInteraction(`page:${sessionId}:first`, {
      id: 'user_123',
      username: 'caller',
    });
    await paginationManager.handleButtonInteraction(firstInteraction as any);
    expect(firstInteraction.updatePayload.embeds[0].data.title).toBe('Page 1/3');
  });

  it('rejects foreign users with ephemeral notice (Actor Lock)', async () => {
    const items = ['A', 'B', 'C'];
    const { actionRow } = paginationManager.createSession(
      'user_authorized_123',
      items,
      () => new EmbedBuilder().setTitle('Test'),
      1,
    );

    const nextCustomId = (actionRow.components[3] as any).data.custom_id;
    // Foreign user clicks
    const foreignInteraction = createMockButtonInteraction(nextCustomId, {
      id: 'user_intruder_999',
      username: 'intruder',
    });

    const handled = await paginationManager.handleButtonInteraction(foreignInteraction as any);
    expect(handled).toBe(true);
    expect(foreignInteraction.replied).toBe(true);
    expect(foreignInteraction.ephemeral).toBe(true);
    expect(foreignInteraction.replyPayload.content).toContain('Hanya pengguna yang menjalankan perintah');
    expect(foreignInteraction.updated).toBe(false);
  });

  it('rejects expired sessions with friendly ephemeral notice', async () => {
    const interaction = createMockButtonInteraction('page:expired_session_id:next', {
      id: 'user_123',
      username: 'caller',
    });

    const handled = await paginationManager.handleButtonInteraction(interaction as any);
    expect(handled).toBe(true);
    expect(interaction.replied).toBe(true);
    expect(interaction.ephemeral).toBe(true);
    expect(interaction.replyPayload.content).toContain('kedaluwarsa');
  });

  it('ignores non-pagination customIds', async () => {
    const interaction = createMockButtonInteraction('confirm:status:100:user1:123');
    const handled = await paginationManager.handleButtonInteraction(interaction as any);
    expect(handled).toBe(false);
    expect(interaction.replied).toBe(false);
    expect(interaction.updated).toBe(false);
  });
});
