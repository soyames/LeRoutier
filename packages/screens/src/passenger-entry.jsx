import { useLocation, useNavigate } from 'react-router';
import { Package, QrCode, Route, ShieldCheck, Smartphone, MapPin } from 'lucide-react';
import { Parcels as LegacyParcels, ParcelTracking as LegacyParcelTracking } from './passenger.jsx';
import './parcel-experience.css';

export * from './passenger.jsx';

function ParcelHero({ tracking }) {
  const navigate = useNavigate();
  return <section className="parcel-hero" aria-labelledby="parcel-hero-title">
    <div className="parcel-hero-copy">
      <div className="parcel-kicker"><span className="parcel-live-dot"/>Colis interurbains · Bénin</div>
      <h1 id="parcel-hero-title">{tracking ? 'Suivre votre colis' : 'Envoyer un colis entre les villes'}</h1>
      <p>{tracking
        ? 'Scannez le QR ou saisissez la référence LRP pour retrouver les étapes déjà confirmées.'
        : 'Préparez l’envoi sur votre téléphone, obtenez sa référence LRP puis confiez-le au point de prise en charge indiqué.'}</p>
    </div>
    <div className="parcel-hero-mark" aria-hidden="true"><Package size={34}/></div>
    <div className="parcel-mode-tabs" role="tablist" aria-label="Colis">
      <button type="button" role="tab" aria-selected={!tracking} className={!tracking ? 'active' : ''} onClick={() => navigate('/parcels')}>
        <Package size={18}/>Nouvel envoi
      </button>
      <button type="button" role="tab" aria-selected={tracking} className={tracking ? 'active' : ''} onClick={() => navigate('/parcels/track')}>
        <QrCode size={18}/>Suivi colis
      </button>
    </div>
  </section>;
}

function ParcelAssurances({ tracking }) {
  const items = tracking ? [
    { icon: QrCode, title: 'QR ou référence LRP', text: 'Deux façons de retrouver le même envoi.' },
    { icon: Route, title: 'Étapes confirmées', text: 'Le suivi montre uniquement les jalons réellement enregistrés.' },
    { icon: ShieldCheck, title: 'Suivi public protégé', text: 'Les données privées de l’expéditeur et du destinataire restent masquées.' },
  ] : [
    { icon: Smartphone, title: 'Téléphone suffisant', text: 'L’impression reste facultative. Le QR et la référence LRP vivent dans l’application.' },
    { icon: MapPin, title: 'Départ et destination clairs', text: 'Choisissez les points disponibles avant de confirmer l’envoi.' },
    { icon: ShieldCheck, title: 'Retrait sécurisé', text: 'Le destinataire utilise son code de retrait lorsque le colis est prêt.' },
  ];
  return <div className="parcel-assurances" aria-label="Repères utiles">
    {items.map(({ icon: Icon, title, text }) => <article key={title} className="parcel-assurance">
      <span className="parcel-assurance-icon"><Icon size={18}/></span>
      <div><strong>{title}</strong><span>{text}</span></div>
    </article>)}
  </div>;
}

function ParcelExperience({ tracking }) {
  return <div className={`parcel-stitch-shell ${tracking ? 'parcel-mode-track' : 'parcel-mode-send'}`}>
    <ParcelHero tracking={tracking}/>
    <ParcelAssurances tracking={tracking}/>
    <div className="parcel-task-surface">
      {tracking ? <LegacyParcelTracking/> : <LegacyParcels/>}
    </div>
  </div>;
}

export function Parcels() {
  const { pathname } = useLocation();
  return <ParcelExperience tracking={pathname.endsWith('/track')}/>;
}

export function ParcelTracking() {
  return <ParcelExperience tracking/>;
}
