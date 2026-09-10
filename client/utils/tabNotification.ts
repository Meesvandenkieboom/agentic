let clearNotification: (() => void) | null = null;

/** Mark a completed reply while away, independently of desktop permissions. */
export function showTabCompletionNotification(): void {
  if (document.visibilityState === 'visible' || clearNotification) return;

  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const originalHref = favicon?.getAttribute('href');
  const originalTitle = document.title;

  if (favicon) favicon.href = '/client/agentic-icon-notification.svg';
  document.title = `✓ Chat finished · ${originalTitle}`;

  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') return;
    if (favicon) {
      if (originalHref == null) favicon.removeAttribute('href');
      else favicon.setAttribute('href', originalHref);
    }
    document.title = originalTitle;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    clearNotification = null;
  };

  clearNotification = onVisibilityChange;
  document.addEventListener('visibilitychange', onVisibilityChange);
}
