/**
 * Date utility functions for timezone-aware formatting.
 */

/**
 * Returns date formatted as YYYY-MM-DD in Asia/Jakarta timezone.
 * Uses 'en-CA' locale which outputs ISO 8601 YYYY-MM-DD format.
 */
export function getJakartaDateString(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
