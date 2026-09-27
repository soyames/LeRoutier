import {
  Bell, Briefcase, Info, MessagesSquare, Navigation, Package, Search, Ticket, UserRound,
} from 'lucide-react';

// The public header's four destinations, in the order a traveller meets them.
// There are four and not six: every extra entry makes the four that matter
// smaller, and anything left over has a home in the drawer.
export const PUBLIC_LINKS = [
  { label: 'Voyager', to: '/trips', page: 'trips' },
  { label: 'Colis', to: '/parcels', page: 'parcels' },
  { label: 'Suivi', to: '/tracking', page: 'tracking' },
  { label: 'Professionnels', to: '/professionnel', page: 'professionnel' },
];

/** @param {string} page the active passenger section, as App.jsx derives it */
export const publicLinks = page => PUBLIC_LINKS.map(link => ({ label: link.label, to: link.to, current: page === link.page }));

/**
 * Everything the header does not carry.
 *
 * The list is short on purpose: a drawer with fifteen entries is a sitemap,
 * not a menu. "Aide" is an action rather than a destination — it opens the
 * assistant, which is why the drawer renders it as a button.
 *
 * `current` marks where the reader already is. On a phone this drawer is the
 * only navigation there is, so a menu that cannot answer "which one am I on"
 * is a menu that makes people open it twice.
 *
 * @param {{ unread?: number, signedIn?: boolean, pathname?: string }} state
 */
export const publicMenu = ({ unread = 0, signedIn = false, pathname = '' } = {}) => [
  { label: 'Voyager', to: '/trips', icon: Search },
  { label: 'Mes voyages', to: '/tickets', icon: Ticket },
  { label: 'Envoyer un colis', to: '/parcels', icon: Package },
  { label: 'Suivre un colis', to: '/parcels/track', icon: Navigation },
  { label: 'Notifications', to: '/notifications', icon: Bell, badge: unread },
  { label: 'Espace professionnel', to: '/professionnel', icon: Briefcase },
  { label: 'À propos', to: '/about', icon: Info },
  { label: 'Aide', icon: MessagesSquare, onSelect: () => window.dispatchEvent(new Event('leroutier:assistant-open')) },
  signedIn ? { label: 'Mon compte', to: '/account', icon: UserRound } : { label: 'Se connecter', to: '/account', icon: UserRound },
].map(item => ({ ...item, current: Boolean(item.to) && item.to === pathname }));
