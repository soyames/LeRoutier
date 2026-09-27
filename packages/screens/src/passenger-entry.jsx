import { useLocation, useNavigate } from 'react-router';
import { Package, QrCode } from 'lucide-react';
import { MEDIA, Photo } from '@leroutier/ui';
import { Parcels as LegacyParcels, ParcelTracking as LegacyParcelTracking } from './passenger.jsx';

export * from './passenger.jsx';
export { OnboardingPage } from './operator-onboarding.jsx';

// The parcel entrance.
//
// It used to be a hero card, then three "assurance" cards each carrying a title
// and a sentence, then the actual form — five blocks of explanation before the
// first field. One of the three said "Téléphone suffisant", which the heading
// above it already implied; another explained that a QR and a reference exist,
// which the screen shows two inches lower.
//
// What is left: the photograph, the heading, one sentence, the tab pair, and
// the form. The one reassurance that is genuinely not visible in the form —
// that printing is optional — moved into the hero as a single line, because a
// sender who thinks they must find a printer will not start.
function ParcelHero({ tracking }) {
  const navigate = useNavigate();
  return <section className="parcel-hero" aria-labelledby="parcel-hero-title">
    <div className="parcel-hero-copy">
      <div className="parcel-kicker"><span className="parcel-live-dot"/>Colis interurbains · Bénin</div>
      <h1 id="parcel-hero-title">{tracking ? 'Suivre votre colis' : 'Envoyer un colis entre les villes'}</h1>
      <p>{tracking
        ? 'Scannez le QR ou saisissez la référence LRP pour retrouver les étapes déjà confirmées.'
        : 'Préparez l’envoi sur votre téléphone, puis confiez-le au point de prise en charge indiqué. L’impression reste facultative.'}</p>
      <div className="parcel-mode-tabs" role="tablist" aria-label="Colis">
        <button type="button" role="tab" aria-selected={!tracking} className={!tracking ? 'active' : ''} onClick={() => navigate('/parcels')}>
          <Package size={18}/>Nouvel envoi
        </button>
        <button type="button" role="tab" aria-selected={tracking} className={tracking ? 'active' : ''} onClick={() => navigate('/parcels/track')}>
          <QrCode size={18}/>Suivi colis
        </button>
      </div>
    </div>
    {/* One photograph, at the entrance only. The parcel sub-pages — devis,
        création, suivi, documents — inherit the design system and add no
        imagery of their own. */}
    <div className="parcel-hero-media"><Photo media={MEDIA.colis} priority/></div>
  </section>;
}

function ParcelExperience({ tracking }) {
  return <div className={`parcel-stitch-shell ${tracking ? 'parcel-mode-track' : 'parcel-mode-send'}`}>
    <ParcelHero tracking={tracking}/>
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
