/**
 * Browser notification utility for Agentic chat application
 * Shows desktop notifications when Claude responds while user is away
 */

export type NotificationPermissionStatus = 'granted' | 'denied' | 'default';

/**
 * Request notification permission from the user
 * @returns Promise with the permission status
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionStatus> {
  if (!('Notification' in window)) {
    console.warn('This browser does not support desktop notifications');
    return 'denied';
  }

  if (Notification.permission === 'granted') {
    return 'granted';
  }

  if (Notification.permission === 'denied') {
    return 'denied';
  }

  try {
    const permission = await Notification.requestPermission();
    return permission as NotificationPermissionStatus;
  } catch (error) {
    console.error('Error requesting notification permission:', error);
    return 'denied';
  }
}

/**
 * Check if the browser tab is currently focused
 * @returns true if tab is focused, false otherwise
 */
export function isTabFocused(): boolean {
  // Only check visibility state - hasFocus() is unreliable when browser is minimized
  return document.visibilityState === 'visible';
}

/**
 * Truncate text to a maximum length with ellipsis
 * @param text - Text to truncate
 * @param maxLength - Maximum length before truncation
 * @returns Truncated text
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength).trim() + '...';
}

/**
 * Strip markdown formatting for notification preview
 * @param text - Text with potential markdown
 * @returns Plain text without markdown
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code]') // Code blocks
    .replace(/`[^`]+`/g, '') // Inline code
    .replace(/[*_~]{1,2}([^*_~]+)[*_~]{1,2}/g, '$1') // Bold, italic, strikethrough
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links
    .replace(/^#+\s+/gm, '') // Headers
    .replace(/^\s*[-*+]\s+/gm, '') // List items
    .trim();
}

export interface ShowNotificationOptions {
  /** The message content to display */
  message: string;
  /** Optional title (defaults to "Agentic") */
  title?: string;
  /** Optional icon URL (defaults to "/agentgirl.png") */
  icon?: string;
  /** Maximum length of message preview (defaults to 100) */
  maxPreviewLength?: number;
  /** Force show notification even if tab is focused (defaults to false) */
  forceShow?: boolean;
}

/**
 * Show a desktop notification when Claude responds
 * Only shows if tab is not focused (unless forceShow is true)
 * @param options - Notification configuration options
 * @returns The Notification instance or null if not shown
 */
export function showClaudeResponseNotification(
  options: ShowNotificationOptions
): Notification | null {
  const {
    message,
    title = 'Agentic',
    icon,
    maxPreviewLength = 100,
    forceShow = false,
  } = options;

  // Build icon URL - use base64 data URL for maximum compatibility
  // This is a simple blue circle icon that works in all browsers
  const defaultIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAABs0lEQVR4nO2WvUoDQRSFv0hsfEJrwUorC1/AwsLKB7CwsLCw0UJrGysfwMJKO7G0srCwsLCw0s7CRhsLLbQIJCHJrtzA7OzO7I9ZCfiBgWHn3nvmzNy5s/BPfQEtYBe4Ah6BD+C7wPVeAjaBCnAKvCWB14FFYAFoAFfAc0zAMzANrAErwBywHhfwBLSBQ+AQWI0L6AATwBqwAqwC8yEBHWAXOAN2gMW4gF6gH1gDloF5YDYk4B04Bm6BA2A+JOAHGALWgQVgFpgJCXgDjoBH4ACYCQnQMTgC3oC9kIAfYBTYBBaBaWAq5P4N6AaugBNgPuT+HRgDNoB5YBKoB92/As/AB7AHzITcfwAXgAbeBORiAtT8BnADHAJTcQE1RYCauxtz/wF0gQ/gJCD/KSCgCjwAV0A7JKAO3AId4Aw4DglQk3PAA3AKtEMC2sA10AEugJOQgJpS4B14Bi5D7gfABNABboDjkICaov4eWAYmgYmQ+1tgEqgD7cD9KzACNIG7gPu+5r4P3AfcfwHrQAu4C7h/BUZA/T8HPv0H8QvxW/zb3mU7JAAAAABJRU5ErkJggg==';
  const iconUrl = icon || defaultIcon;

  // Debug logging
  console.log('[Notification] Attempting to show notification:', {
    permission: 'Notification' in window ? Notification.permission : 'not supported',
    isTabFocused: isTabFocused(),
    forceShow,
    messageLength: message.length,
    iconUrl,
  });

  // Check if notifications are supported and enabled
  if (!canShowNotifications()) {
    console.log('[Notification] Notifications not available:', {
      supported: 'Notification' in window,
      permission: 'Notification' in window ? Notification.permission : 'N/A',
      userEnabled: areNotificationsEnabled(),
    });
    return null;
  }

  // TEMPORARILY DISABLED: Always show notifications for debugging
  // Don't show if tab is focused (unless forced)
  // if (!forceShow && isTabFocused()) {
  //   console.log('[Notification] Tab is focused, skipping notification');
  //   return null;
  // }

  // Prepare notification body
  const plainText = stripMarkdown(message);
  const body = truncateText(plainText, maxPreviewLength);

  // Create notification - keep simple like the test notification that works
  try {
    console.log('[Notification] Creating notification with body:', body.substring(0, 50) + '...');

    const notification = new Notification(title, {
      body,
      tag: 'agentic-response',
    });

    console.log('[Notification] Notification created successfully');

    // Focus window when notification is clicked
    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    return notification;
  } catch (error) {
    console.error('[Notification] Error creating notification:', error);
    return null;
  }
}

/**
 * Initialize notification system
 * Call this once on app startup to request permission
 * @returns Promise with permission status
 */
export async function initializeNotifications(): Promise<NotificationPermissionStatus> {
  if (!('Notification' in window)) {
    console.warn('Notifications not supported in this browser');
    return 'denied';
  }

  // Don't auto-request permission, just return current status
  // User should manually trigger permission request via settings or first notification
  return Notification.permission as NotificationPermissionStatus;
}

/**
 * Check if notifications are available and permitted
 * @returns true if notifications can be shown
 */
export function canShowNotifications(): boolean {
  return 'Notification' in window && Notification.permission === 'granted' && areNotificationsEnabled();
}

/**
 * Check if user has enabled notifications (user preference)
 * This is separate from browser permission
 * @returns true if user wants notifications
 */
export function areNotificationsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const preference = localStorage.getItem('agentic-notifications-enabled');
  // Default to true if permission is granted but no preference is set
  if (preference === null && 'Notification' in window) {
    return Notification.permission === 'granted';
  }
  return preference === 'true';
}

/**
 * Set user's notification preference
 * @param enabled - Whether user wants notifications
 */
export function setNotificationsEnabled(enabled: boolean): void {
  localStorage.setItem('agentic-notifications-enabled', String(enabled));
}
