import { useCallback, useEffect, useRef, useState } from 'react';
import { shouldPublishPosition } from '@leroutier/geo';

// Vehicle GPS capture for crew running an active service.
//
// Tracking is deliberately explicit: permission is requested only when a
// service actually needs it, and capture stops the moment it does not. The
// passenger's device is never involved — this is the vehicle's position, sent
// by the crew who are authorised for that service.
//
// Browser limitation, stated plainly: a web app only receives positions while
// its page is alive. Android may suspend a backgrounded tab and iOS Safari
// stops geolocation when the app is not foregrounded. There is no reliable
// background geolocation on the web platform, so continuous tracking means the
// crew device keeps the screen on this page. A dedicated tracker or a native
// app would remove that constraint; neither is claimed here.

export const TRACKING_STATE = {
  off: 'off', requesting: 'requesting', active: 'active',
  denied: 'denied', unavailable: 'unavailable', offline: 'offline',
};

/** Bounded local buffer: unsent fixes survive a tunnel, not a whole day. */
const BUFFER_LIMIT = 40;
const BUFFER_MAX_AGE_MS = 30 * 60_000;

/**
 * @param {{ serviceId: string|null, enabled: boolean, request: Function,
 *   options?: { minMetres?: number, maxSeconds?: number, maxAccuracyM?: number } }} params
 */
// A stable default keeps the capture effect from re-running on unrelated
// renders. A fresh {} per render re-registered watchPosition and re-subscribed
// the online listeners every time — and the listener swap during the
// reconnect's synchronous re-render dropped the very event that was supposed
// to flush the buffered fixes.
const DEFAULT_OPTIONS = Object.freeze({});
export function useVehicleTracking({ serviceId, enabled, request, options = DEFAULT_OPTIONS }) {
  // Only the browser's own callbacks move this; the states that follow
  // directly from the inputs are derived below rather than stored.
  const [watchState, setWatchState] = useState(null);
  const [lastSentAt, setLastSentAt] = useState(null);
  const [pending, setPending] = useState(0);
  const watchId = useRef(null);
  const lastSent = useRef(null);
  const buffer = useRef([]);
  const sending = useRef(false);

  // Drain buffered fixes oldest-first so the server sees them in order. The
  // server rejects anything not newer than what it already has, so a replayed
  // fix is refused rather than duplicated.
  const flush = useCallback(async () => {
    if (sending.current || !serviceId || !navigator.onLine) return;
    sending.current = true;
    try {
      const cutoff = Date.now() - BUFFER_MAX_AGE_MS;
      buffer.current = buffer.current.filter(fix => Date.parse(fix.observedAt) >= cutoff);
      while (buffer.current.length) {
        const fix = buffer.current[0];
        try {
          await request(`/services/${serviceId}/positions`, { method: 'POST', body: fix });
          buffer.current.shift();
          lastSent.current = fix;
          setLastSentAt(fix.observedAt);
        } catch (error) {
          // A position the server will never accept is dropped rather than
          // retried forever; anything else waits for the next attempt.
          if (error?.status === 409 || error?.status === 400) buffer.current.shift();
          else break;
        }
      }
    } finally { sending.current = false; setPending(buffer.current.length); }
  }, [serviceId, request]);

  useEffect(() => {
    // Capture stops as soon as the service no longer needs it.
    if (!enabled || !serviceId || !('geolocation' in navigator)) {
      if (watchId.current !== null) { navigator.geolocation?.clearWatch(watchId.current); watchId.current = null; }
      return;
    }
    watchId.current = navigator.geolocation.watchPosition(
      position => {
        setWatchState(navigator.onLine ? TRACKING_STATE.active : TRACKING_STATE.offline);
        const fix = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          observedAt: new Date(position.timestamp).toISOString(),
          accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
          // Device speed and heading are reported only when the device has
          // them; neither is ever derived here and presented as measured.
          speedMps: Number.isFinite(position.coords.speed) && position.coords.speed >= 0 ? position.coords.speed : null,
          headingDeg: Number.isFinite(position.coords.heading) && position.coords.heading >= 0 ? position.coords.heading : null,
          source: 'pwa_device',
        };
        // Movement or elapsed time — not every callback, which would drain the
        // battery and flood the API for a parked vehicle.
        if (!shouldPublishPosition(fix, lastSent.current ?? buffer.current.at(-1) ?? null, options)) return;
        if (buffer.current.length >= BUFFER_LIMIT) buffer.current.shift();
        buffer.current.push(fix);
        setPending(buffer.current.length);
        flush();
      },
      error => {
        // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
        setWatchState(error?.code === 1 ? TRACKING_STATE.denied : TRACKING_STATE.unavailable);
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );

    const onOnline = () => { setWatchState(TRACKING_STATE.active); flush();
      // Some browsers deliver the online event before navigator.onLine has
      // settled, which makes flush() bail on its own guard and leaves the
      // buffer waiting for the next movement fix. One retry on the next tick
      // drains it either way; the sending/onLine guards make it a no-op when
      // the first attempt already landed.
      setTimeout(flush, 250); };
    const onOffline = () => setWatchState(TRACKING_STATE.offline);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      if (watchId.current !== null) { navigator.geolocation.clearWatch(watchId.current); watchId.current = null; }
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [enabled, serviceId, flush, options]);

  // Derived, so the reported state can never drift from the inputs.
  const state = !enabled || !serviceId ? TRACKING_STATE.off
    : !('geolocation' in navigator) ? TRACKING_STATE.unavailable
      : watchState ?? TRACKING_STATE.requesting;

  return { state, lastSentAt, pending, flush };
}
