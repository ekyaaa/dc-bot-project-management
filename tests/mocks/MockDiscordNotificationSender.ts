import type {
  IDiscordNotificationSender,
  DiscordNotificationPayload,
} from '../../src/application/ports/IDiscordNotificationSender.js';

export class MockDiscordNotificationSender implements IDiscordNotificationSender {
  public sentNotifications: DiscordNotificationPayload[] = [];
  public shouldFail = false;
  public failureError: Error = new Error('Simulated Discord API failure');

  public async sendNotification(
    payload: DiscordNotificationPayload,
  ): Promise<{ messageId: string }> {
    if (this.shouldFail) {
      throw this.failureError;
    }
    this.sentNotifications.push(payload);
    return { messageId: `mock_msg_${this.sentNotifications.length}` };
  }

  public async verifyChannel(_channelId: string): Promise<boolean> {
    return !this.shouldFail;
  }

  public reset(): void {
    this.sentNotifications = [];
    this.shouldFail = false;
    this.failureError = new Error('Simulated Discord API failure');
  }
}
