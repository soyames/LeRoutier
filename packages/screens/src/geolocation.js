import { useCallback, useEffect, useRef, useState } from 'react';
import { distanceMetres } from '@leroutier/geo';

// Where the passenger is, for the one thing the product needs it for: turning
// "Ma position" into a real departure city.
//
// Memory only, deliberately. The privacy policy says a passenger's exact
// coordinates are transient — used to resolve the first mile, never stored —
// and a cache in localStorage would make that sentence false. A reload loses
// it. That is the correct behaviour, not a limitation.
//
// The cache is module-level rather than per-component because the search is
// started on one screen and run on another: somebody picks "Ma position" on
// the home page and lands on the results page, and asking for the same
// permission twice for one search is exactly the kind of thing that makes
// people deny it the second time.
/** @type {{ latitude: number, longitude: number, accuracyM: number | null } | null} */
let sessionPosition = null;

/** The request currently in flight, shared so two screens cannot ask twice. */
/** @type {Promise<{ latitude: number, longitude: number, accuracyM: number | null }> | null} */
let inFlight = null;

/** How long to wait for a fix before telling the passenger we could not get one. */
const TIMEOUT_MS = 8000;

// Every message says what happened AND what to do next. "Position indisponible"
// on its own leaves somebody on a bus-stop bench with no idea whether to wait,
// retry, or type their city — and typing their city is almost always the right
// answer, so it is in every one of them.
export const GEOLOCATION_MESSAGES = {
  unsupported: 'Cet appareil ne fournit pas de position. Choisissez votre ville de départ.',
  denied: 'Localisation refusée. Choisissez votre ville de départ, ou autorisez la localisation pour ce site.',
  unavailable: 'Position indisponible pour le moment. Choisissez votre ville de départ.',
};

/**
 * The position already obtained during this session, if any.
 * @returns {{ latitude: number, longitude: number, accuracyM: number | null } | null}
 */
export function cachedPosition() { return sessionPosition; }

/** A geolocation failure with the reason the UI needs, in one object. */
export class GeolocationFailure extends Error {
  /** @param {'unsupported' | 'denied' | 'unavailable'} reason */
  constructor(reason) {
    super(GEOLOCATION_MESSAGES[reason]);
    this.reason = reason;
  }
}

/**
 * Ask the device where it is.
 *
 * Resolves with the position, or rejects with a GeolocationFailure carrying
 * the reason — so the caller can say something specific rather than "erreur".
 *
 * @returns {Promise<{ latitude: number, longitude: number, accuracyM: number | null }>}
 */
export function requestPosition() {
  if (sessionPosition) return Promise.resolve(sessionPosition);
  // One request, however many callers ask at once. The home page asks when the
  // passenger submits and the results page asks when it mounts, and those two
  // happen within milliseconds of each other: two prompts for one search is
  // how a permission gets refused.
  if (inFlight) return inFlight;
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.reject(new GeolocationFailure('unsupported'));
  }
  inFlight = new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      fix => {
        // `accuracy` is what the device reports about its own confidence. It
        // is kept because a 3 km fix from a wifi lookup is not the same fact
        // as a 10 m GPS fix, and the first-mile estimate should not pretend
        // otherwise.
        sessionPosition = {
          latitude: fix.coords.latitude,
          longitude: fix.coords.longitude,
          accuracyM: Number.isFinite(fix.coords.accuracy) ? Math.round(fix.coords.accuracy) : null,
        };
        resolve(sessionPosition);
      },
      failure => {
        // PERMISSION_DENIED is the one the passenger can act on, so it gets
        // its own message rather than being folded into "unavailable".
        reject(new GeolocationFailure(failure?.code === 1 ? 'denied' : 'unavailable'));
      },
      { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: 60_000 });
  }).finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Geolocation as a hook, with the state the screens need to say something true.
 *
 * `state` is one of: idle (not asked yet), asking, granted, refused.
 * `error` is the sentence to show, in French, or ''.
 *
 * `request()` is stable, so it is safe to call it from an effect.
 */
export function useGeolocation() {
  const [position, setPosition] = useState(() => sessionPosition);
  const [state, setState] = useState(() => (sessionPosition ? 'granted' : 'idle'));
  const [error, setError] = useState('');
  // Set on mount as well as cleared on unmount: StrictMode mounts, unmounts
  // and mounts again in development, and a flag that is only ever cleared
  // would leave the second mount silently discarding every answer.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const request = useCallback(async () => {
    if (sessionPosition) { setPosition(sessionPosition); setState('granted'); return sessionPosition; }
    // No pre-check against navigator.permissions. Querying it is not
    // implemented everywhere, and where it is, a stale answer would block the
    // request the passenger just made. A refused permission makes
    // getCurrentPosition fail immediately with PERMISSION_DENIED, which is the
    // same outcome with none of the guessing.
    setState('asking'); setError('');
    try {
      const fix = await requestPosition();
      if (!alive.current) return fix;
      setPosition(fix); setState('granted'); return fix;
    } catch (failure) {
      if (!alive.current) return null;
      setState('refused');
      setError(failure instanceof GeolocationFailure ? failure.message : GEOLOCATION_MESSAGES.unavailable);
      return null;
    }
  }, []);

  return { position, state, error, request };
}

/**
 * The commune the passenger is in — what "Ma position" means to a human.
 *
 * Resolved on the device against the same canonical geography the search uses,
 * so the name shown in the summary is a city LeRoutier can actually search
 * from, not a label invented from coordinates. Returns null when the geography
 * has not loaded yet or nothing is close enough to name honestly.
 *
 * @param {{ id: string, name: string, latitude: unknown, longitude: unknown }[] | undefined} places
 * @param {{ latitude: number, longitude: number } | null} position
 * @param {{ maxKm?: number }} [options]
 */
export function nearestPlace(places, position, { maxKm = 60 } = {}) {
  if (!position || !Array.isArray(places) || !places.length) return null;
  let best = null;
  for (const place of places) {
    const distance = distanceMetres(position, { latitude: Number(place.latitude), longitude: Number(place.longitude) });
    if (distance === null) continue;
    if (!best || distance < best.distanceM) best = { place, distanceM: distance };
  }
  // Past a certain distance the nearest commune is not "where you are", and
  // naming it would be a guess dressed as a fact.
  if (!best || best.distanceM > maxKm * 1000) return null;
  return { ...best.place, distanceM: best.distanceM };
}
