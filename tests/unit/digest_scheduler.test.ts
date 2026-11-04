import { describe, it, expect, vi } from 'vitest';
import { DigestScheduler } from '../../src/infrastructure/scheduling/DigestScheduler.js';
import { getJakartaDateString } from '../../src/infrastructure/scheduling/dateUtils.js';

describe('Daily Digest Croner Scheduler: DigestScheduler', () => {
  const createMockDispatchUseCase = () => ({
    execute: vi.fn().mockResolvedValue({
      dispatched: true,
      reason: 'SUCCESS',
      dateStr: '2026-11-04',
      projectNumber: 1,
    }),
  });

  describe('Cron Pattern Construction', () => {
    it('constructs weekday pattern 0 9 * * 1-5 for default 09:00', () => {
      const mockUseCase: any = createMockDispatchUseCase();
      const scheduler = new DigestScheduler({
        config: {
          DIGEST_ENABLED: true,
          DIGEST_TIME: '09:00',
          DIGEST_TIMEZONE: 'Asia/Jakarta',
        },
        dispatchUseCase: mockUseCase,
      });

      expect(scheduler.cronPattern).toBe('0 9 * * 1-5');
      expect(scheduler.timezone).toBe('Asia/Jakarta');
    });

    it('constructs pattern 30 14 * * 1-5 for afternoon time 14:30', () => {
      const mockUseCase: any = createMockDispatchUseCase();
      const scheduler = new DigestScheduler({
        config: {
          DIGEST_ENABLED: true,
          DIGEST_TIME: '14:30',
          DIGEST_TIMEZONE: 'Asia/Jakarta',
        },
        dispatchUseCase: mockUseCase,
      });

      expect(scheduler.cronPattern).toBe('30 14 * * 1-5');
    });

    it('constructs pattern 5 8 * * 1-5 for single-digit minutes and hours 08:05', () => {
      const mockUseCase: any = createMockDispatchUseCase();
      const scheduler = new DigestScheduler({
        config: {
          DIGEST_ENABLED: true,
          DIGEST_TIME: '08:05',
          DIGEST_TIMEZONE: 'Asia/Jakarta',
        },
        dispatchUseCase: mockUseCase,
      });

      expect(scheduler.cronPattern).toBe('5 8 * * 1-5');
    });
  });

  describe('Feature Flag & Lifecycle (start, stop, isRunning, nextRun)', () => {
    it('does not start cron job when DIGEST_ENABLED is false', () => {
      const mockUseCase: any = createMockDispatchUseCase();
      const loggedInfo: string[] = [];

      const scheduler = new DigestScheduler({
        config: {
          DIGEST_ENABLED: false,
          DIGEST_TIME: '09:00',
          DIGEST_TIMEZONE: 'Asia/Jakarta',
        },
        dispatchUseCase: mockUseCase,
        logger: {
          info: (msg) => loggedInfo.push(msg),
          error: vi.fn(),
        },
      });

      const started = scheduler.start();
      expect(started).toBe(false);
      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.nextRun()).toBeNull();
      expect(loggedInfo.some((m) => m.includes('disabled'))).toBe(true);
    });

    it('starts cron job when DIGEST_ENABLED is true and tracks next run', () => {
      const mockUseCase: any = createMockDispatchUseCase();
      const scheduler = new DigestScheduler({
        config: {
          DIGEST_ENABLED: true,
          DIGEST_TIME: '09:00',
          DIGEST_TIMEZONE: 'Asia/Jakarta',
        },
        dispatchUseCase: mockUseCase,
        logger: { info: vi.fn(), error: vi.fn() },
      });

      const started = scheduler.start();
      expect(started).toBe(true);
      expect(scheduler.isRunning()).toBe(true);

      const nextRun = scheduler.nextRun();
      expect(nextRun).toBeInstanceOf(Date);
      expect(nextRun!.getTime()).toBeGreaterThan(Date.now());

      // Idempotent start
      expect(scheduler.start()).toBe(true);

      // Stop
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.nextRun()).toBeNull();
    });

    it('respects SCHEDULED_DIGEST_ENABLED alias when DIGEST_ENABLED is omitted', () => {
      const mockUseCase: any = createMockDispatchUseCase();
      const scheduler = new DigestScheduler({
        config: {
          DIGEST_ENABLED: undefined as any,
          SCHEDULED_DIGEST_ENABLED: true,
          DIGEST_TIME: '09:00',
          DIGEST_TIMEZONE: 'Asia/Jakarta',
        },
        dispatchUseCase: mockUseCase,
        logger: { info: vi.fn(), error: vi.fn() },
      });

      expect(scheduler.start()).toBe(true);
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
    });

    it('triggerManual calls dispatchUseCase.execute with provided options', async () => {
      const mockUseCase: any = createMockDispatchUseCase();
      const scheduler = new DigestScheduler({
        config: {
          DIGEST_ENABLED: false,
          DIGEST_TIME: '09:00',
          DIGEST_TIMEZONE: 'Asia/Jakarta',
        },
        dispatchUseCase: mockUseCase,
      });

      const result = await scheduler.triggerManual({ force: true, targetDate: '2026-11-04' });
      expect(result.dispatched).toBe(true);
      expect(result.reason).toBe('SUCCESS');
      expect(mockUseCase.execute).toHaveBeenCalledWith({ force: true, targetDate: '2026-11-04' });
    });

    it('executes scheduled callback when cron triggers and logs success', async () => {
      const mockUseCase: any = createMockDispatchUseCase();
      const loggedInfo: string[] = [];
      const scheduler = new DigestScheduler({
        config: {
          DIGEST_ENABLED: true,
          DIGEST_TIME: '09:00',
          DIGEST_TIMEZONE: 'Asia/Jakarta',
        },
        dispatchUseCase: mockUseCase,
        logger: {
          info: (msg) => loggedInfo.push(msg),
          error: vi.fn(),
        },
      });

      scheduler.start();
      await (scheduler as any).cronJob.trigger();

      expect(mockUseCase.execute).toHaveBeenCalled();
      expect(loggedInfo.some((m) => m.includes('Digest execution completed'))).toBe(true);
      scheduler.stop();
    });

    it('logs error when dispatchUseCase throws inside cron callback', async () => {
      const mockUseCase: any = {
        execute: vi.fn().mockRejectedValue(new Error('Network failure during digest')),
      };
      const loggedErrors: string[] = [];
      const scheduler = new DigestScheduler({
        config: {
          DIGEST_ENABLED: true,
          DIGEST_TIME: '09:00',
          DIGEST_TIMEZONE: 'Asia/Jakarta',
        },
        dispatchUseCase: mockUseCase,
        logger: {
          info: vi.fn(),
          error: (msg) => loggedErrors.push(msg),
        },
      });

      scheduler.start();
      await (scheduler as any).cronJob.trigger();

      expect(loggedErrors.some((m) => m.includes('Failed to dispatch daily digest'))).toBe(true);
      scheduler.stop();
    });
  });

  describe('Timezone & Date Utilities', () => {
    it('getJakartaDateString returns YYYY-MM-DD strictly in Asia/Jakarta timezone', () => {
      // 2026-11-03T20:00:00Z -> UTC is 8pm Nov 3, but Jakarta (UTC+7) is 03:00am Nov 4!
      const utcDate = new Date('2026-11-03T20:00:00Z');
      const jakartaDate = getJakartaDateString(utcDate);
      expect(jakartaDate).toBe('2026-11-04');

      // 2026-11-04T00:00:00Z -> Jakarta is 07:00am Nov 4
      const morningDate = new Date('2026-11-04T00:00:00Z');
      expect(getJakartaDateString(morningDate)).toBe('2026-11-04');
    });

    it('defaults to current date if no argument provided', () => {
      const result = getJakartaDateString();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
