export interface MockInteractionUser {
  id: string;
  username: string;
}

export interface MockChatInputOptions {
  commandName: string;
  subcommand?: string | null;
  options?: Record<string, string | number | boolean | null | undefined>;
  guildId?: string | null;
  channelId?: string | null;
  user?: MockInteractionUser;
}

export class MockChatInputCommandInteraction {
  public readonly commandName: string;
  public readonly subcommand: string | null;
  public readonly guildId: string | null;
  public readonly channelId: string | null;
  public readonly user: MockInteractionUser;
  public readonly member: { user: MockInteractionUser };
  public readonly id: string;

  public deferred = false;
  public replied = false;
  public ephemeral = false;
  public deferredAt?: number;
  public replyPayload: any = null;
  public editReplyPayload: any = null;
  public followUpPayloads: any[] = [];
  public modalShown: any = null;

  private readonly optionsMap: Record<string, string | number | boolean | null | undefined>;

  constructor(opts: MockChatInputOptions) {
    this.id = `chat_input_${Math.random().toString(36).substring(2, 9)}`;
    this.commandName = opts.commandName;
    this.subcommand = opts.subcommand ?? null;
    this.guildId = opts.guildId !== undefined ? opts.guildId : 'guild_allowlist_123';
    this.channelId = opts.channelId ?? 'channel_alerts_456';
    this.user = opts.user ?? { id: 'discord_user_001', username: 'testuser' };
    this.member = { user: this.user };
    this.optionsMap = opts.options ?? {};
  }

  public isChatInputCommand(): true {
    return true;
  }
  public isButton(): false {
    return false;
  }
  public isModalSubmit(): false {
    return false;
  }
  public isRepliable(): true {
    return true;
  }
  public inGuild(): boolean {
    return this.guildId !== null;
  }

  public options = {
    getSubcommand: (required = true) => {
      if (required && !this.subcommand) {
        throw new Error('Command has no subcommand.');
      }
      return this.subcommand;
    },
    getString: (name: string, required = false) => {
      const val = this.optionsMap[name];
      if (required && (val === undefined || val === null)) {
        throw new Error(`Option '${name}' is required.`);
      }
      return val !== undefined && val !== null ? String(val) : null;
    },
    getInteger: (name: string, required = false) => {
      const val = this.optionsMap[name];
      if (required && (val === undefined || val === null)) {
        throw new Error(`Option '${name}' is required.`);
      }
      return val !== undefined && val !== null ? Number(val) : null;
    },
    getBoolean: (name: string, required = false) => {
      const val = this.optionsMap[name];
      if (required && (val === undefined || val === null)) {
        throw new Error(`Option '${name}' is required.`);
      }
      return val !== undefined && val !== null ? Boolean(val) : null;
    },
  };

  public async deferReply(options?: { ephemeral?: boolean }): Promise<void> {
    this.deferred = true;
    this.ephemeral = options?.ephemeral ?? false;
    this.deferredAt = Date.now();
  }

  public async reply(options: any): Promise<void> {
    this.replied = true;
    this.ephemeral = options?.ephemeral ?? false;
    this.replyPayload = options;
  }

  public async editReply(options: any): Promise<void> {
    this.editReplyPayload = options;
  }

  public async followUp(options: any): Promise<void> {
    this.followUpPayloads.push(options);
  }

  public async showModal(modal: any): Promise<void> {
    if (this.deferred) {
      throw new Error('Interaction already deferred; showModal cannot be called');
    }
    this.modalShown = modal;
  }
}

export class MockButtonInteraction {
  public readonly customId: string;
  public readonly guildId: string | null;
  public readonly channelId: string | null;
  public readonly user: MockInteractionUser;
  public readonly member: { user: MockInteractionUser };
  public readonly id: string;

  public deferred = false;
  public replied = false;
  public updated = false;
  public ephemeral = false;
  public updatePayload: any = null;
  public replyPayload: any = null;
  public editReplyPayload: any = null;

  constructor(
    customId: string,
    user?: MockInteractionUser,
    guildId: string | null = 'guild_allowlist_123',
    channelId = 'channel_alerts_456',
  ) {
    this.id = `button_${Math.random().toString(36).substring(2, 9)}`;
    this.customId = customId;
    this.user = user ?? { id: 'discord_user_001', username: 'testuser' };
    this.member = { user: this.user };
    this.guildId = guildId;
    this.channelId = channelId;
  }

  public isChatInputCommand(): false {
    return false;
  }
  public isButton(): true {
    return true;
  }
  public isModalSubmit(): false {
    return false;
  }
  public isRepliable(): true {
    return true;
  }
  public inGuild(): boolean {
    return this.guildId !== null;
  }

  public async deferUpdate(): Promise<void> {
    this.deferred = true;
  }

  public async deferReply(options?: { ephemeral?: boolean }): Promise<void> {
    this.deferred = true;
    this.ephemeral = options?.ephemeral ?? false;
  }

  public async update(payload: any): Promise<void> {
    this.updated = true;
    this.updatePayload = payload;
  }

  public async reply(payload: any): Promise<void> {
    this.replied = true;
    this.ephemeral = payload?.ephemeral ?? false;
    this.replyPayload = payload;
  }

  public async editReply(payload: any): Promise<void> {
    this.editReplyPayload = payload;
  }
}

export class MockModalSubmitInteraction {
  public readonly customId: string;
  public readonly guildId: string | null;
  public readonly channelId: string | null;
  public readonly user: MockInteractionUser;
  public readonly member: { user: MockInteractionUser };
  public readonly id: string;

  public deferred = false;
  public replied = false;
  public ephemeral = false;
  public replyPayload: any = null;
  public editReplyPayload: any = null;
  private readonly fieldsMap: Record<string, string>;

  constructor(
    customId: string,
    fields: Record<string, string>,
    user?: MockInteractionUser,
    guildId: string | null = 'guild_allowlist_123',
    channelId = 'channel_alerts_456',
  ) {
    this.id = `modal_${Math.random().toString(36).substring(2, 9)}`;
    this.customId = customId;
    this.fieldsMap = fields;
    this.user = user ?? { id: 'discord_user_001', username: 'testuser' };
    this.member = { user: this.user };
    this.guildId = guildId;
    this.channelId = channelId;
  }

  public isChatInputCommand(): false {
    return false;
  }
  public isButton(): false {
    return false;
  }
  public isModalSubmit(): true {
    return true;
  }
  public isRepliable(): true {
    return true;
  }
  public inGuild(): boolean {
    return this.guildId !== null;
  }

  public fields = {
    getTextInputValue: (id: string): string => this.fieldsMap[id] ?? '',
  };

  public async deferReply(options?: { ephemeral?: boolean }): Promise<void> {
    this.deferred = true;
    this.ephemeral = options?.ephemeral ?? false;
  }

  public async reply(options: any): Promise<void> {
    this.replied = true;
    this.ephemeral = options?.ephemeral ?? false;
    this.replyPayload = options;
  }

  public async editReply(options: any): Promise<void> {
    this.editReplyPayload = options;
  }
}

export function createMockChatInputInteraction(
  opts: MockChatInputOptions,
): MockChatInputCommandInteraction {
  return new MockChatInputCommandInteraction(opts);
}

export function createMockButtonInteraction(
  customId: string,
  user?: MockInteractionUser,
  guildId?: string | null,
): MockButtonInteraction {
  return new MockButtonInteraction(customId, user, guildId);
}

export function createMockModalSubmitInteraction(
  customId: string,
  fields: Record<string, string>,
  user?: MockInteractionUser,
  guildId?: string | null,
): MockModalSubmitInteraction {
  return new MockModalSubmitInteraction(customId, fields, user, guildId);
}
