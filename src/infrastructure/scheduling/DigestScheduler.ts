import { Cron } from 'croner';
import type { Config } from '../../config/env.js';
import type {
  DispatchDailyDigestUseCase,
  DispatchDailyDigestOptions,
  DispatchDailyDigestResult,
} from '../../application/usecases/DispatchDailyDigestUseCase.js';

export interface DigestSchedulerLogger {
  info: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
}

export interface DigestSchedulerDependencies {
  config: Pick<Config, 'DIGEST_ENABLED' | 'DIGEST_TIME' | 'DIGEST_TIMEZONE'> & {
    SCHEDULED_DIGEST_ENABLED?: boolean;
  };
  dispatchUseCase: DispatchDailyDigestUseCase;
  logger?: DigestSchedulerLogger;
}

export class DigestScheduler {
  private cronJob: Cron | null = null;
  private readonly config: DigestSchedulerDependencies['config'];
  private readonly dispatchUseCase: DispatchDailyDigestUseCase;
  private readonly logger: DigestSchedulerLogger;

  constructor(deps: DigestSchedulerDependencies) {
    this.config = deps.config;
    this.dispatchUseCase = deps.dispatchUseCase;
    this.logger = deps.logger ?? console;
  }

  public get cronPattern(): string {
    const time = this.config.DIGEST_TIME || '09:00';
    const [hourStr, minuteStr] = time.split(':');
    const minute = parseInt(minuteStr ?? '0', 10);
    const hour = parseInt(hourStr ?? '9', 10);
    return `${minute} ${hour} * * 1-5`;
  }

  public get timezone(): string {
    return this.config.DIGEST_TIMEZONE || 'Asia/Jakarta';
  }

  public start(): boolean {
    const isEnabled = this.config.DIGEST_ENABLED ?? this.config.SCHEDULED_DIGEST_ENABLED ?? false;

    if (!isEnabled) {
      this.logger.info('[DigestScheduler] Scheduled daily digest is disabled (DIGEST_ENABLED=false).');
      return false;
    }

    if (this.cronJob && this.cronJob.isRunning()) {
      return true;
    }

    const pattern = this.cronPattern;
    this.cronJob = new Cron(
      pattern,
      {
        timezone: this.timezone,
        protect: true,
        unref: true,
        catch: (err: unknown) => {
          this.logger.error('[DigestScheduler] Unhandled error during scheduled digest execution:', err);
        },
      },
      async () => {
        try {
          this.logger.info(
            `[DigestScheduler] Triggering scheduled daily digest (${pattern} ${this.timezone})...`,
          );
          const result = await this.dispatchUseCase.execute();
          this.logger.info(
            `[DigestScheduler] Digest execution completed: ${result.reason} (dispatched: ${result.dispatched})`,
          );
        } catch (err) {
          this.logger.error('[DigestScheduler] Failed to dispatch daily digest:', err);
        }
      },
    );

    const next = this.cronJob.nextRun();
    this.logger.info(
      `[DigestScheduler] Daily digest scheduled with pattern '${pattern}' (${this.timezone}). Next run: ${next?.toISOString() ?? 'none'}`,
    );
    return true;
  }

  public stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      this.logger.info('[DigestScheduler] Daily digest scheduler stopped.');
    }
  }

  public isRunning(): boolean {
    return this.cronJob?.isRunning() ?? false;
  }

  public nextRun(): Date | null {
    return this.cronJob?.nextRun() ?? null;
  }

  public async triggerManual(options?: DispatchDailyDigestOptions): Promise<DispatchDailyDigestResult> {
    return this.dispatchUseCase.execute(options);
  }
}
