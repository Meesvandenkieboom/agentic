/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import React, { useState, useEffect } from 'react';
import { Bell, BellOff, BellRing } from 'lucide-react';
import { requestNotificationPermission, type NotificationPermissionStatus } from '../../utils/notifications';

export function NotificationToggle() {
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermissionStatus>('default');
  const [isRequesting, setIsRequesting] = useState(false);

  // Check current permission status on mount
  useEffect(() => {
    if ('Notification' in window) {
      setPermissionStatus(Notification.permission as NotificationPermissionStatus);
    } else {
      setPermissionStatus('denied');
    }
  }, []);

  const handleToggle = async () => {
    if (permissionStatus === 'granted') {
      // Can't revoke permission programmatically, show info
      return;
    }

    if (permissionStatus === 'denied') {
      // Show instructions for manual enable
      return;
    }

    // Request permission
    setIsRequesting(true);
    try {
      const result = await requestNotificationPermission();
      setPermissionStatus(result);
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
    if (permissionStatus === 'granted') return <BellRing size={18} />;
    if (permissionStatus === 'denied') return <BellOff size={18} />;
    return <Bell size={18} />;
  };

  const getTooltip = () => {
    if (permissionStatus === 'granted') return 'Desktop notifications enabled';
    if (permissionStatus === 'denied') return 'Notifications blocked - enable in browser settings';
    return 'Enable desktop notifications';
  };

  const getButtonStyle = () => {
    if (permissionStatus === 'granted') {
      return 'text-green-400 hover:text-green-300';
    }
    if (permissionStatus === 'denied') {
      return 'text-gray-500 hover:text-gray-400 cursor-not-allowed';
    }
    return 'text-gray-400 hover:text-gray-200';
  };

  return (
    <button
      onClick={handleToggle}
      disabled={permissionStatus === 'denied' || isRequesting}
      className={`p-2 rounded-lg transition-colors ${getButtonStyle()}`}
      title={getTooltip()}
    >
      {getIcon()}
    </button>
  );
}
