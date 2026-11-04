import type { AllowedMentions } from '../../domain/types.js';

export interface DiscordNotificationPayload {
  channelId: string;
  content?: string;
  embeds?: unknown[];
  allowedMentions: AllowedMentions;
}

export interface IDiscordNotificationSender {
  sendNotification(payload: DiscordNotificationPayload): Promise<{ messageId: string }>;
  verifyChannel(channelId: string): Promise<boolean>;
}
