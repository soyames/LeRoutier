import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';

/**
 * The one camera reader in the product.
 *
 * There were three: this one, and two copies inside the crew console for
 * tickets and for parcels. They drifted, as copies do — only this one stopped
 * the camera when the app went to the background, so a driver who switched to
 * their maps app left the camera running on the crew screens. Whatever is
 * learned about reading a code in the field now gets learned once.
 *
 * `accept` decides what counts as a hit, so the caller states which codes it
 * wants instead of every scanner having its own inline regular expression and
 * its own idea of what a wrong code means.
 *
 * @param {{
 *   onRead: (value: string) => void,
 *   accept?: (value: string) => string | null,
 *   label?: string,
 *   rejectText?: string,
 *   deniedText?: string,
 * }} props
 */
export function QrCapture({ onRead, accept = value => value, label = 'Scanner le QR',
  rejectText = 'Ce QR ne correspond pas à un code LeRoutier.',
  deniedText = 'Caméra indisponible. Autorisez la caméra dans votre navigateur, ou saisissez le code ci-dessous.' }) {
  const video = useRef(null), scanner = useRef(null), generation = useRef(0);
  const [active, setActive] = useState(false), [error, setError] = useState('');
  const [torch, setTorch] = useState(null); // null = unknown/unsupported, boolean = available

  function stop() {
    generation.current++;
    scanner.current?.destroy();
    scanner.current = null;
    setActive(false);
    setTorch(null);
  }

  // Starting the scanner in the click handler used to race React: the video
  // still had the `hidden` attribute when QrScanner asked the browser to attach
  // the camera stream. Real phones would grant permission while leaving no
  // visible scanning surface. The click now only reveals the surface; this
  // effect starts the camera after that render has committed.
  useEffect(() => {
    if (!active || !video.current) return undefined;
    const current = generation.current;
    const instance = new QrScanner(video.current, result => {
      if (current !== generation.current) return;
      const value = accept(String(result.data ?? '').trim());
      // A code that is not ours is reported and the camera stays on: the crew
      // are holding a phone up to a parcel, and being dropped back to a dead
      // screen for every stray barcode in the station is not usable.
      if (!value) { setError(rejectText); return; }
      stop();
      onRead(value);
    }, { highlightScanRegion: true, preferredCamera: 'environment', returnDetailedScanResult: true });
    scanner.current = instance;

    (async () => {
      try {
        await instance.start();
        if (current !== generation.current) { instance.destroy(); return; }
        const hasTorch = await Promise.race([
          instance.hasFlash().catch(() => false),
          new Promise(resolve => setTimeout(() => resolve(false), 1500)),
        ]).catch(() => false);
        if (current === generation.current) setTorch(hasTorch ? false : null);
      } catch {
        if (current === generation.current) { stop(); setError(deniedText); }
      }
    })();

    return () => {
      // Destroy only the instance created by this render. `stop()` may already
      // have destroyed it after a successful scan; destroy is safe to repeat.
      instance.destroy();
      if (scanner.current === instance) scanner.current = null;
    };
  }, [active, accept, deniedText, onRead, rejectText]);

  useEffect(() => {
    // A camera left running behind another app is a battery drain and a light
    // the holder did not ask for. Stop on background, always.
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hide);
    return () => { generation.current++; scanner.current?.destroy(); scanner.current = null; document.removeEventListener('visibilitychange', hide); };
  }, []);

  function start() {
    generation.current++;
    scanner.current?.destroy();
    scanner.current = null;
    setTorch(null);
    setError('');
    setActive(true);
  }

  async function toggleTorch() {
    try { await scanner.current?.toggleFlash(); setTorch(on => !on); }
    catch { setTorch(null); }
  }

  return <div className="stack">
    <div className="controls">
      <button type="button" className="btn btn-soft" onClick={active ? stop : start}>
        {active ? 'Arrêter la caméra' : label}</button>
      {active && torch !== null && <button type="button" className="btn btn-soft" onClick={toggleTorch}
        aria-pressed={torch}>{torch ? 'Éteindre la lampe' : 'Allumer la lampe'}</button>}
    </div>
    <video ref={video} className="qr-video" hidden={!active} muted playsInline autoPlay aria-label="Lecture caméra QR"
      style={{ width: '100%', maxWidth: 640, aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 16, background: '#0f172a' }}/>
    {active && <p role="status" className="small">Placez le QR code dans le cadre de la caméra.</p>}
    {error && <p role="alert" className="small">{error}</p>}
  </div>;
}
