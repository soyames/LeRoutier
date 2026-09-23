import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';

/**
 * The one camera reader in the product.
 *
 * `accept` decides what counts as a hit, so each caller states which LeRoutier
 * codes it accepts while camera lifecycle and mobile behaviour stay shared.
 */
export function QrCapture({ onRead, accept = value => value, label = 'Scanner le QR',
  rejectText = 'Ce QR ne correspond pas à un code LeRoutier.',
  deniedText = 'Caméra indisponible. Autorisez la caméra dans votre navigateur, ou saisissez le code ci-dessous.' }) {
  const video = useRef(null), scanner = useRef(null), generation = useRef(0), reading = useRef(false);
  const acceptRef = useRef(accept), onReadRef = useRef(onRead), rejectTextRef = useRef(rejectText), deniedTextRef = useRef(deniedText);
  const [active, setActive] = useState(false), [error, setError] = useState(''), [processing, setProcessing] = useState(false);
  const [torch, setTorch] = useState(null); // null = unknown/unsupported, boolean = available

  useEffect(() => {
    acceptRef.current = accept;
    onReadRef.current = onRead;
    rejectTextRef.current = rejectText;
    deniedTextRef.current = deniedText;
  }, [accept, onRead, rejectText, deniedText]);

  function stop() {
    generation.current++;
    reading.current = false;
    scanner.current?.destroy();
    scanner.current = null;
    setActive(false);
    setTorch(null);
  }

  function revealResult() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const explicit = document.querySelector('main .card-success, main .summary');
      const cards = [...document.querySelectorAll('main .card')].filter(node => node.getBoundingClientRect().height > 0);
      const target = explicit || cards.at(-1);
      target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      target?.querySelector?.('button, [href], input, [tabindex]:not([tabindex="-1"])')?.focus?.({ preventScroll: true });
    }));
  }

  // The video is made visible first. The camera starts only after React has
  // committed that render, avoiding the permission-granted-but-no-preview race
  // seen on real phones.
  useEffect(() => {
    if (!active || !video.current) return undefined;
    const current = generation.current;

    async function decoded(result) {
      if (current !== generation.current || reading.current) return;
      const raw = String(result?.data ?? result ?? '').trim();
      const value = acceptRef.current(raw);
      if (!value) {
        setError(rejectTextRef.current);
        return;
      }

      // A valid LeRoutier QR is a one-shot action. Stop the camera immediately
      // so the same code cannot be decoded twice while its details are loading.
      reading.current = true;
      generation.current++;
      scanner.current?.destroy();
      scanner.current = null;
      setActive(false);
      setTorch(null);
      setError('');
      setProcessing(true);
      try {
        await onReadRef.current(value);
        revealResult();
      } finally {
        reading.current = false;
        setProcessing(false);
      }
    }

    const instance = new QrScanner(video.current, decoded, {
      preferredCamera: 'environment',
      returnDetailedScanResult: true,
      highlightScanRegion: true,
      highlightCodeOutline: true,
      maxScansPerSecond: 12,
      // The default qr-scanner crop only looks at a central square. On a phone
      // held close to another screen or parcel label the QR often sits partly
      // outside that square even though it is plainly visible to the user.
      // Decode the whole visible camera frame instead.
      calculateScanRegion: element => ({
        x: 0,
        y: 0,
        width: element.videoWidth || element.clientWidth || 640,
        height: element.videoHeight || element.clientHeight || 480,
        downScaledWidth: 480,
        downScaledHeight: 480,
      }),
    });
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
        if (current === generation.current) { stop(); setError(deniedTextRef.current); }
      }
    })();

    return () => {
      instance.destroy();
      if (scanner.current === instance) scanner.current = null;
    };
  }, [active]);

  useEffect(() => {
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hide);
    return () => {
      generation.current++;
      scanner.current?.destroy();
      scanner.current = null;
      document.removeEventListener('visibilitychange', hide);
    };
  }, []);

  function start() {
    generation.current++;
    reading.current = false;
    scanner.current?.destroy();
    scanner.current = null;
    setTorch(null);
    setError('');
    setProcessing(false);
    setActive(true);
  }

  async function toggleTorch() {
    try { await scanner.current?.toggleFlash(); setTorch(on => !on); }
    catch { setTorch(null); }
  }

  return <div className="stack">
    <div className="controls">
      <button type="button" className="btn btn-soft" disabled={processing} onClick={active ? stop : start}>
        {processing ? 'QR détecté…' : active ? 'Arrêter la caméra' : label}</button>
      {active && torch !== null && <button type="button" className="btn btn-soft" onClick={toggleTorch}
        aria-pressed={torch}>{torch ? 'Éteindre la lampe' : 'Allumer la lampe'}</button>}
    </div>
    <video ref={video} className="qr-video" hidden={!active} muted playsInline autoPlay aria-label="Lecture caméra QR"
      style={{ width: '100%', maxWidth: 640, aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 16, background: '#0f172a' }}/>
    {active && <p role="status" className="small">Placez le QR code LeRoutier entièrement dans le cadre.</p>}
    {processing && <p role="status" className="small">QR détecté. Vérification des informations…</p>}
    {error && <p role="alert" className="small">{error}</p>}
  </div>;
}
