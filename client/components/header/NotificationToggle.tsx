/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import React, { useState } from 'react';
import { Bell, BellOff, BellRing } from 'lucide-react';
import { requestNotificationPermission, type NotificationPermissionStatus } from '../../utils/notifications';
import { toast } from '../../utils/toast';

export function NotificationToggle() {
  // Always start as 'default' so user can manually click to request permission
  // This fixes stale permission issues after browser/app restart
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermissionStatus>('default');
  const [isRequesting, setIsRequesting] = useState(false);

  const handleToggle = async () => {
    // If permission denied, show instructions
    if (permissionStatus === 'denied') {
      toast.error('Notifications blocked', {
        description: 'Enable notifications in your browser settings for this site',
      });
      return;
    }

    // Request permission (works for both 'default' and to refresh 'granted')
    setIsRequesting(true);
    try {
      const result = await requestNotificationPermission();
      setPermissionStatus(result);
      if (result === 'granted') {
        toast.success('Notifications enabled!');
      } else if (result === 'denied') {
        toast.error('Notifications blocked');
      }
    } finally {
      setIsRequesting(false);
    }
  };

  // Don't render if notifications not supported
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return null;
  }

  const getIcon = () => {
    if (isRequesting) return <Bell size={18} className="animate-pulse" />;
    if (permissionStatus === 'denied') return <BellOff size={18} />;
    if (permissionStatus === 'granted') return <BellRing size={18} />;
    return <Bell size={18} />;
  };

  const getTooltip = () => {
    if (permissionStatus === 'denied') return 'Notifications blocked - enable in browser settings';
    if (permissionStatus === 'granted') return 'Desktop notifications enabled';
    return 'Click to enable desktop notifications';
  };

  const getButtonStyle = () => {
    if (permissionStatus === 'denied') {
      return 'text-gray-500 hover:text-gray-400';
    }
    if (permissionStatus === 'granted') {
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

// Export function to check if notifications are enabled
export function areNotificationsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (!('Notification' in window)) return false;
  return Notification.permission === 'granted';
}
