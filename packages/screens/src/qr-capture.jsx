import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';

export function QrCapture({ onRead, label = 'Scanner le QR' }) {
  const video = useRef(null), scanner = useRef(null), generation = useRef(0);
  const [active, setActive] = useState(false), [error, setError] = useState('');
  function stop() { generation.current++; scanner.current?.destroy(); scanner.current = null; setActive(false); }
  useEffect(() => {
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hide);
    return () => { stop(); document.removeEventListener('visibilitychange', hide); };
  }, []);
  async function start() {
    stop(); setError(''); setActive(true);
    const current = generation.current;
    const instance = new QrScanner(video.current, result => {
      if (current !== generation.current) return;
      stop(); onRead(result.data);
    }, { preferredCamera: 'environment', returnDetailedScanResult: true });
    scanner.current = instance;
    try { await instance.start(); if (current !== generation.current) instance.destroy(); }
    catch { if (current === generation.current) { stop(); setError('Caméra indisponible. Autorisez la caméra dans votre navigateur ou saisissez la référence ci-dessous.'); } }
  }
  return <div className="stack">
    <button type="button" className="btn btn-soft" onClick={active ? stop : start}>{active ? 'Arrêter la caméra' : label}</button>
    <video ref={video} className="qr-video" hidden={!active} muted playsInline aria-label="Lecture caméra QR"/>
    {error && <p role="alert" className="small">{error}</p>}
  </div>;
}
