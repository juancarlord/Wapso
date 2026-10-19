import { useEffect, useRef, useCallback, useState } from 'react';

type UseAutoPollingOptions = {
  interval?: number;
  enabled?: boolean;
  onPoll: () => void | Promise<void>;
  /** Pause while the tab is hidden (default true). */
  pauseWhenHidden?: boolean;
};

export function useAutoPolling({ interval = 5000, enabled = true, onPoll, pauseWhenHidden = true }: UseAutoPollingOptions) {
  const [isPolling, setIsPolling] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const startPolling = useCallback(() => {
    if (!enabled) return;

    // Never stack timers if startPolling runs again (e.g. interval changed).
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    setIsPolling(true);

    const poll = async () => {
      try {
        await onPoll();
      } catch (error) {
        console.error('Polling error:', error);
      }
    };

    // Poll immediately
    poll();

    // Then poll at intervals
    intervalRef.current = setInterval(poll, interval);
  }, [interval, enabled, onPoll]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPolling(false);
  }, []);

  // Handle visibility change (pause when tab is hidden)
  useEffect(() => {
    if (!pauseWhenHidden) return;
    const handleVisibilityChange = () => {
      if (document.hidden) {
        setIsPaused(true);
        stopPolling();
      } else {
        setIsPaused(false);
        if (enabled) {
          startPolling();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, startPolling, stopPolling, pauseWhenHidden]);

  // Start/stop polling based on enabled flag
  useEffect(() => {
    if (enabled && (!pauseWhenHidden || !document.hidden)) {
      startPolling();
    } else {
      stopPolling();
    }

    return () => {
      stopPolling();
    };
  }, [enabled, startPolling, stopPolling, pauseWhenHidden]);

  return {
    isPolling,
    isPaused
  };
}
