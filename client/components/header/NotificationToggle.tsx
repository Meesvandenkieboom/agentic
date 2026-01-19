/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import React, { useState, useEffect } from 'react';
import { Bell, BellOff, BellRing } from 'lucide-react';
import { requestNotificationPermission, type NotificationPermissionStatus } from '../../utils/notifications';
import { toast } from '../../utils/toast';

const NOTIFICATIONS_ENABLED_KEY = 'agentic-notifications-enabled';

export function NotificationToggle() {
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermissionStatus>('default');
  const [isEnabled, setIsEnabled] = useState<boolean>(() => {
    // Load from localStorage, default to true
    const stored = localStorage.getItem(NOTIFICATIONS_ENABLED_KEY);
    return stored === null ? true : stored === 'true';
  });
  const [isRequesting, setIsRequesting] = useState(false);

  // Check and refresh permission status on mount
  useEffect(() => {
    const initializePermission = async () => {
      if (!('Notification' in window)) {
        setPermissionStatus('denied');
        return;
      }

      const currentPermission = Notification.permission as NotificationPermissionStatus;
      setPermissionStatus(currentPermission);

      // If user previously enabled notifications but permission is 'default',
      // automatically re-request permission on page load
      if (isEnabled && currentPermission === 'default') {
        console.log('[Notification] Re-requesting permission on page load...');
        try {
          const result = await requestNotificationPermission();
          setPermissionStatus(result);
          if (result === 'granted') {
            console.log('[Notification] Permission re-granted on page load');
          }
        } catch (error) {
          console.error('[Notification] Failed to re-request permission:', error);
        }
      }
    };

    initializePermission();
  }, []);

  // Save enabled state to localStorage
  useEffect(() => {
    localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, String(isEnabled));
  }, [isEnabled]);

  const handleToggle = async () => {
    // If permission denied, show instructions
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
          setIsEnabled(true);
          toast.success('Notifications enabled!');
        } else if (result === 'denied') {
          toast.error('Notifications blocked');
        }
      } finally {
        setIsRequesting(false);
      }
      return;
    }

    // Permission is granted - toggle local enabled state
    const newEnabled = !isEnabled;
    setIsEnabled(newEnabled);

    if (newEnabled) {
      toast.success('Notifications enabled');
    } else {
      toast.info('Notifications disabled');
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
    return <BellOff size={18} />;
  };

  const getTooltip = () => {
    if (permissionStatus === 'denied') return 'Notifications blocked - enable in browser settings';
    if (permissionStatus === 'default') return 'Click to enable desktop notifications';
    if (isEnabled) return 'Desktop notifications ON - click to disable';
    return 'Desktop notifications OFF - click to enable';
  };

  const getButtonStyle = () => {
    if (permissionStatus === 'denied') {
      return 'text-gray-500 hover:text-gray-400';
    }
    if (permissionStatus === 'granted' && isEnabled) {
      return 'text-green-400 hover:text-green-300';
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

// Export function to check if notifications are enabled (for use in ChatContainer)
export function areNotificationsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const stored = localStorage.getItem(NOTIFICATIONS_ENABLED_KEY);
  return stored === null ? true : stored === 'true';
}
