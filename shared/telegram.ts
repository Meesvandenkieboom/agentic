export interface TelegramPreferences {
  enabled: boolean;
  userId: string;
  finished: boolean;
  errors: boolean;
  questions: boolean;
}
export interface TelegramSettings extends TelegramPreferences {
  hasToken: boolean;
  lastError: string | null;
}
export const defaultTelegramPreferences: TelegramPreferences = {
  enabled: true, userId: '', finished: true, errors: true, questions: true,
};
