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
  return document.visibilityState === 'visible' && document.hasFocus();
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

  // Build absolute icon URL (required for notifications)
  const iconUrl = icon || `${window.location.origin}/agentgirl.png`;

  // Debug logging
  console.log('[Notification] Attempting to show notification:', {
    permission: 'Notification' in window ? Notification.permission : 'not supported',
    isTabFocused: isTabFocused(),
    forceShow,
    messageLength: message.length,
    iconUrl,
  });

  // Check if notifications are supported
  if (!('Notification' in window)) {
    console.log('[Notification] Browser does not support notifications');
    return null;
  }

  // Check permission
  if (Notification.permission !== 'granted') {
    console.log('[Notification] Permission not granted:', Notification.permission);
    return null;
  }

  // Don't show if tab is focused (unless forced)
  if (!forceShow && isTabFocused()) {
    console.log('[Notification] Tab is focused, skipping notification');
    return null;
  }

  // Prepare notification body
  const plainText = stripMarkdown(message);
  const body = truncateText(plainText, maxPreviewLength);

  // Create notification
  try {
    const notification = new Notification(title, {
      body,
      icon: iconUrl,
      badge: iconUrl,
      tag: 'agentic-response', // Replaces previous notification
      requireInteraction: false, // Auto-dismiss after a few seconds
    });

    // Focus window when notification is clicked
    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    return notification;
  } catch (error) {
    console.error('Error showing notification:', error);
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
  return 'Notification' in window && Notification.permission === 'granted';
}
