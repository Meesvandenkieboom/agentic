import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getAppDataDirectory } from '../directoryUtils';
import { TelegramNotifications } from './telegram';
import { TurnNotifications } from './turns';

let telegram: TelegramNotifications | undefined;
export function getTelegramNotifications(): TelegramNotifications {
  if (!telegram) {
    const directory = getAppDataDirectory();
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'telegram.db');
    const db = new Database(file, { create: true });
    chmodSync(file, 0o600);
    telegram = new TelegramNotifications(db);
  }
  return telegram;
}
export const turnNotifications = new TurnNotifications(getTelegramNotifications);
export function startTelegramNotifications(): void {
  try { getTelegramNotifications().start(); }
  catch { console.warn('Telegram notifications could not start. Chats will continue normally.'); }
}
export function stopTelegramNotifications(): void { turnNotifications.cancelAll(); telegram?.stop(); }
