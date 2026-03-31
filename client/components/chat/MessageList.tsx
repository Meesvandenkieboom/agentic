/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MessageRenderer } from '../message/MessageRenderer';
import { useSearchContext } from './SearchContext';
import { Zap, Clock } from 'lucide-react';
import type { Message } from '../message/types';

interface MessageListProps {
  messages: Message[];
  isLoading?: boolean;
  liveTokenCount?: number;
  scrollContainerRef?: React.RefObject<HTMLDivElement>;
}

export const MessageList = React.memo(function MessageList({ messages, isLoading, liveTokenCount = 0, scrollContainerRef }: MessageListProps) {
  const parentRef = scrollContainerRef || useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { activeMessageId } = useSearchContext();

  // Elapsed time tracking
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  // Smooth token count animation
  const [displayedTokenCount, setDisplayedTokenCount] = useState(0);
  const animationFrameRef = useRef<number | null>(null);

  // Sticky scroll tracking - inspired by Vercel AI Chatbot & Discord
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const userScrolledUpRef = useRef(false);
  const scrollCooldownRef = useRef(false);

  // Keep ref in sync with state
  useEffect(() => {
    isAtBottomRef.current = isAtBottom;
  }, [isAtBottom]);

  // Check if scroll position is at bottom (with threshold)
  const checkIfAtBottom = useCallback(() => {
    const container = parentRef.current;
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    // 50px threshold - slightly more forgiving
    return scrollHeight - scrollTop - clientHeight <= 50;
  }, [parentRef]);

  // Detect user intent via WHEEL events (most reliable method)
  // This fires when user actively scrolls with mouse/trackpad
  useEffect(() => {
    const container = parentRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // User scrolled UP (negative deltaY = scroll up on most systems)
      if (e.deltaY < 0) {
        userScrolledUpRef.current = true;
        setIsAtBottom(false);

        // Set a cooldown to prevent auto-scroll from fighting back
        scrollCooldownRef.current = true;
        setTimeout(() => {
          scrollCooldownRef.current = false;
        }, 150); // 150ms cooldown after wheel scroll
      }
      // User scrolled DOWN - check if they reached bottom to re-enable auto-scroll
      else if (e.deltaY > 0) {
        // Use a small delay to let the scroll position update
        setTimeout(() => {
          if (checkIfAtBottom()) {
            userScrolledUpRef.current = false;
            setIsAtBottom(true);
          }
        }, 50);
      }
    };

    // Also handle touch scrolling for mobile
    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
    };

    const handleTouchMove = (e: TouchEvent) => {
      const touchY = e.touches[0].clientY;
      const deltaY = touchStartY - touchY;

      // User swiped UP (positive delta = scroll up)
      if (deltaY < -10) { // 10px threshold
        userScrolledUpRef.current = true;
        setIsAtBottom(false);
        scrollCooldownRef.current = true;
        setTimeout(() => {
          scrollCooldownRef.current = false;
        }, 150);
      }
      // User swiped DOWN - check if at bottom
      else if (deltaY > 10) {
        setTimeout(() => {
          if (checkIfAtBottom()) {
            userScrolledUpRef.current = false;
            setIsAtBottom(true);
          }
        }, 50);
      }
      touchStartY = touchY;
    };

    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
    };
  }, [parentRef, checkIfAtBottom]);

  // Reset scroll state when a NEW response starts (not during)
  const prevLoadingRef = useRef(isLoading);
  useEffect(() => {
    // Only reset when loading STARTS (false -> true), not when it ends
    if (isLoading && !prevLoadingRef.current) {
      // New response starting - if user is at bottom, keep auto-scroll enabled
      if (checkIfAtBottom()) {
        userScrolledUpRef.current = false;
        setIsAtBottom(true);
      }
    }
    prevLoadingRef.current = isLoading;
  }, [isLoading, checkIfAtBottom]);

  // Track elapsed time when loading
  useEffect(() => {
    if (isLoading) {
      // Start timer
      startTimeRef.current = Date.now();
      setElapsedSeconds(0);

      const interval = setInterval(() => {
        if (startTimeRef.current) {
          const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
          setElapsedSeconds(elapsed);
        }
      }, 1000);

      return () => clearInterval(interval);
    } else {
      // Reset timer when loading stops
      startTimeRef.current = null;
      setElapsedSeconds(0);
    }
  }, [isLoading]);

  // Smooth token count animation with throttling
  useEffect(() => {
    const startValue = displayedTokenCount;
    const endValue = liveTokenCount;
    const duration = 300; // 300ms animation duration
    const startTime = Date.now();

    if (startValue === endValue) return;

    // Throttle animation updates to every 16ms (60fps) for better performance
    let lastUpdateTime = 0;
    const throttleDelay = 16;

    const animate = () => {
      const now = Date.now();
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Only update if enough time has passed since last update
      if (now - lastUpdateTime >= throttleDelay || progress >= 1) {
        lastUpdateTime = now;

        // Ease-out cubic function for smooth deceleration
        const easeOut = 1 - Math.pow(1 - progress, 3);

        const currentValue = Math.floor(startValue + (endValue - startValue) * easeOut);
        setDisplayedTokenCount(currentValue);
      }

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        setDisplayedTokenCount(endValue);
      }
    };

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [liveTokenCount]);

  // Virtual scrolling setup
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 200, // Estimated message height - will auto-adjust
    overscan: 5, // Render 5 extra items above/below viewport
  });

  // Track previous message count to detect bulk loads (session switch, refresh, reconnect)
  const prevMessageCountRef = useRef(0);

  // Scroll to bottom when messages change (only if user hasn't manually scrolled up)
  useEffect(() => {
    const container = parentRef.current;
    if (!container || messages.length === 0) return;

    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    // Bulk load detected: messages jumped from 0/empty to many (session load, refresh, reconnect)
    // Always scroll to bottom and reset scroll tracking state
    const isBulkLoad = prevCount === 0 && messages.length > 0;
    if (isBulkLoad) {
      userScrolledUpRef.current = false;
      scrollCooldownRef.current = false;
      setIsAtBottom(true);
      // Use double-rAF to ensure DOM has rendered the new messages before scrolling
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight;
        });
      });
      return;
    }

    // Don't auto-scroll if user has explicitly scrolled up or we're in cooldown
    if (userScrolledUpRef.current || scrollCooldownRef.current) {
      return;
    }

    // Real-time check: only scroll if actually near the bottom.
    // This catches cases where content height changed (e.g. expanding a tool call)
    // without a wheel/touch event, which would leave isAtBottomRef stale.
    if (!checkIfAtBottom()) {
      // Content expanded above viewport (tool call opened, etc.) - stop auto-scrolling
      userScrolledUpRef.current = true;
      setIsAtBottom(false);
      return;
    }

    // Use requestAnimationFrame for smoother scrolling
    requestAnimationFrame(() => {
      if (!userScrolledUpRef.current && !scrollCooldownRef.current) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }, [messages, parentRef, checkIfAtBottom]);

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="empty-state">
          <h2 className="empty-state-title">Welcome to Agentic Chat</h2>
          <p className="empty-state-description">
            Start a conversation with Claude. I can help you with coding, analysis, and complex tasks
            using the Agent SDK tools.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className="flex overflow-auto z-10 flex-col flex-auto justify-between pb-2.5 w-full max-w-full h-0 scrollbar-hidden"
    >
      <div className="flex flex-col w-full h-full">
        <div className="h-full flex pt-8">
          <div className="pt-2 w-full">
            <div className="w-full" style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const message = messages[virtualItem.index];
                const isActiveSearch = activeMessageId === message.id;

                return (
                  <div
                    key={message.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                    ref={virtualizer.measureElement}
                    data-index={virtualItem.index}
                    className={isActiveSearch ? 'search-active-message' : undefined}
                  >
                    <MessageRenderer message={message} />
                  </div>
                );
              })}
            </div>
            {isLoading ? (
              <div className="message-container">
                <div className="loading-indicator-wrapper" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.75rem', flexWrap: 'nowrap' }}>
                  <div className="loading-dots">
                    <div className="loading-dot" />
                    <div className="loading-dot" />
                    <div className="loading-dot" />
                  </div>

                  {/* Elapsed time indicator - changes to amber after 60s */}
                  {elapsedSeconds > 0 && (
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.375rem',
                        padding: '0.375rem 0.625rem',
                        background: elapsedSeconds >= 60
                          ? 'linear-gradient(135deg, rgba(245, 158, 11, 0.1) 0%, rgba(245, 158, 11, 0.05) 100%)'
                          : 'linear-gradient(135deg, rgba(218, 238, 255, 0.1) 0%, rgba(218, 238, 255, 0.05) 100%)',
                        border: elapsedSeconds >= 60
                          ? '1px solid rgba(245, 158, 11, 0.25)'
                          : '1px solid rgba(218, 238, 255, 0.15)',
                        borderRadius: '12px',
                        backdropFilter: 'blur(8px)',
                        boxShadow: elapsedSeconds >= 60
                          ? '0 0 0 1px rgba(245, 158, 11, 0.15), 0 2px 8px rgba(245, 158, 11, 0.12)'
                          : '0 0 0 1px rgba(218, 238, 255, 0.1), 0 2px 8px rgba(218, 238, 255, 0.08)',
                        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                      }}
                    >
                      <Clock
                        size={12}
                        strokeWidth={2.5}
                        style={{
                          color: elapsedSeconds >= 60 ? 'rgb(245, 158, 11)' : 'rgb(218, 238, 255)',
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          fontSize: '0.8125rem',
                          fontWeight: 600,
                          color: elapsedSeconds >= 60 ? 'rgb(245, 158, 11)' : 'rgb(218, 238, 255)',
                          fontVariantNumeric: 'tabular-nums',
                          letterSpacing: '0.02em',
                        }}
                      >
                        {elapsedSeconds}s
                      </span>
                    </div>
                  )}

                  {/* Token count indicator (live during streaming) */}
                  {displayedTokenCount > 0 && (
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.375rem',
                        padding: '0.375rem 0.625rem',
                        background: 'linear-gradient(135deg, rgba(218, 238, 255, 0.1) 0%, rgba(218, 238, 255, 0.05) 100%)',
                        border: '1px solid rgba(218, 238, 255, 0.15)',
                        borderRadius: '12px',
                        backdropFilter: 'blur(8px)',
                        boxShadow: '0 0 0 1px rgba(218, 238, 255, 0.1), 0 2px 8px rgba(218, 238, 255, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
                        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                      }}
                    >
                      <Zap
                        size={12}
                        strokeWidth={2.5}
                        style={{
                          color: 'rgb(218, 238, 255)',
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          fontSize: '0.8125rem',
                          fontWeight: 600,
                          color: 'rgb(218, 238, 255)',
                          fontVariantNumeric: 'tabular-nums',
                          letterSpacing: '0.02em',
                        }}
                      >
                        {displayedTokenCount.toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ) : displayedTokenCount > 0 && (
              /* Persisted token count — visible after streaming ends */
              <div className="message-container">
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', flexWrap: 'nowrap' }}>
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.375rem',
                      padding: '0.375rem 0.625rem',
                      background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.02) 100%)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '12px',
                      opacity: 0.6,
                      transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                    }}
                  >
                    <Zap
                      size={11}
                      strokeWidth={2.5}
                      style={{
                        color: 'rgb(218, 238, 255)',
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: '0.75rem',
                        fontWeight: 500,
                        color: 'rgb(218, 238, 255)',
                        fontVariantNumeric: 'tabular-nums',
                        letterSpacing: '0.02em',
                      }}
                    >
                      {displayedTokenCount.toLocaleString()} tokens
                    </span>
                  </div>
                </div>
              </div>
            )}
            <div className="pb-12" />
            <div ref={bottomRef} />
          </div>
        </div>
      </div>
    </div>
  );
});
