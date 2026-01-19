/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import React, { useState } from 'react';
import { Bell, BellOff, BellRing } from 'lucide-react';
import {
  requestNotificationPermission,
  type NotificationPermissionStatus,
  areNotificationsEnabled,
  setNotificationsEnabled
} from '../../utils/notifications';
import { toast } from '../../utils/toast';

export function NotificationToggle() {
  // Check actual browser permission status on mount
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermissionStatus>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';
    return Notification.permission as NotificationPermissionStatus;
  });

  // Track user preference (separate from browser permission)
  const [isEnabled, setIsEnabled] = useState<boolean>(() => areNotificationsEnabled());
  const [isRequesting, setIsRequesting] = useState(false);

  const handleToggle = async () => {
    // If browser permission is denied, show instructions
    if (permissionStatus === 'denied') {
      toast.error('Notifications blocked', {
        description: 'Enable notifications in your browser settings for this site',
      });
      return;
    }

    // If permission not yet granted, request it
    if (permissionStatus === 'default') {
      setIsRequesting(true);
      try {
        const result = await requestNotificationPermission();
        setPermissionStatus(result);
        if (result === 'granted') {
          setNotificationsEnabled(true);
          setIsEnabled(true);
          toast.success('Notifications enabled!');

          // Send a test notification immediately to verify it works
          try {
            const testNotification = new Notification('Agentic', {
              body: 'Notifications are working! You will be notified when Claude responds.',
              tag: 'agentic-test',
            });
            testNotification.onclick = () => {
              window.focus();
              testNotification.close();
            };
          } catch (e) {
            console.error('[Notification] Test notification failed:', e);
          }
        } else if (result === 'denied') {
          toast.error('Notifications blocked');
        }
      } finally {
        setIsRequesting(false);
      }
      return;
    }

    // If permission already granted, toggle user preference
    if (permissionStatus === 'granted') {
      const newState = !isEnabled;
      setNotificationsEnabled(newState);
      setIsEnabled(newState);

      if (newState) {
        toast.success('Notifications enabled!');
      } else {
        toast.info('Notifications disabled');
      }
    }
  };

  // Don't render if notifications not supported
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return null;
  }

  const getIcon = () => {
    if (isRequesting) return <Bell size={18} className="animate-pulse" />;
    if (permissionStatus === 'denied') return <BellOff size={18} />;
    if (permissionStatus === 'granted' && isEnabled) return <BellRing size={18} />;
    if (permissionStatus === 'granted' && !isEnabled) return <BellOff size={18} />;
    return <Bell size={18} />;
  };

  const getTooltip = () => {
    if (permissionStatus === 'denied') return 'Notifications blocked - enable in browser settings';
    if (permissionStatus === 'granted' && isEnabled) return 'Notifications enabled - click to disable';
    if (permissionStatus === 'granted' && !isEnabled) return 'Notifications disabled - click to enable';
    return 'Click to enable desktop notifications';
  };

  const getButtonStyle = () => {
    if (permissionStatus === 'denied') {
      return 'text-gray-500 hover:text-gray-400';
    }
    if (permissionStatus === 'granted' && isEnabled) {
      return 'text-green-400 hover:text-green-300';
    }
    if (permissionStatus === 'granted' && !isEnabled) {
      return 'text-gray-500 hover:text-gray-400';
    }
    return 'text-gray-400 hover:text-gray-200';
  };

  return (
    <button
      onClick={handleToggle}
      disabled={isRequesting}
      className={`p-2 rounded-lg transition-colors ${getButtonStyle()}`}
      title={getTooltip()}
    >
      {getIcon()}
    </button>
  );
}
