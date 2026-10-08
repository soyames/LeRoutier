import {
  Bell, Briefcase, Info, MessagesSquare, Navigation, Package, Search, Ticket, UserRound,
} from 'lucide-react';

// The public header's four destinations, in the order a traveller meets them.
// There are four and not six: every extra entry makes the four that matter
// smaller, and anything left over has a home in the drawer.
export const PUBLIC_LINKS = [
  { label: 'Réservations', to: '/trips', page: 'trips' },
  { label: 'Colis', to: '/parcels', page: 'parcels' },
  { label: 'Trajets', to: '/tracking', page: 'tracking' },
  { label: 'Professionnels', to: '/professionnel', page: 'professionnel' },
];

/** @param {string} page the active passenger section, as App.jsx derives it */
export const publicLinks = page => PUBLIC_LINKS.map(link => ({ label: link.label, to: link.to, current: page === link.page }));

// The four destinations a traveller gets on a phone, in the bar at the bottom
// of the screen. Three of them are the header's own — same label, same route,
// so moving between a phone and a laptop never moves a destination — and the
// fourth is the account, which the header keeps behind the avatar.
//
// PROFESSIONNELS IS NOT ONE OF THE FOUR, deliberately. A traveller bar that
// spends a quarter of itself on a door for people who work in transport is a
// bar that has four items and three traveller destinations. That door is not
// lost: it is in the drawer, on the page the header links to, and in the
// footer.
//
// "Réservations" covers bought tickets as well as the search for one: a ticket
// IS a reservation, they are two halves of one errand, and a bar with nothing
// lit while somebody reads their own tickets answers "where am I" with silence.
export const PASSENGER_TABS = [
  { label: 'Réservations', to: '/trips', page: 'trips', pages: ['trips', 'tickets'], icon: Search },
  { label: 'Trajets', to: '/tracking', page: 'tracking', pages: ['tracking'], icon: Navigation },
  { label: 'Colis', to: '/parcels', page: 'parcels', pages: ['parcels'], icon: Package },
  { label: 'Profil', to: '/account', page: 'account', pages: ['account'], icon: UserRound },
];

/** @param {string} page the active passenger section, as App.jsx derives it */
export const passengerTabs = page => PASSENGER_TABS.map(tab =>
  ({ label: tab.label, to: tab.to, current: tab.pages.includes(page || ''), icon: tab.icon }));

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
  { label: 'Réservations', to: '/trips', icon: Search },
  { label: 'Mes voyages', to: '/tickets', icon: Ticket },
  { label: 'Envoyer un colis', to: '/parcels', icon: Package },
  { label: 'Suivre un colis', to: '/parcels/track', icon: Navigation },
  { label: 'Notifications', to: '/notifications', icon: Bell, badge: unread },
  { label: 'Espace professionnel', to: '/professionnel', icon: Briefcase },
  { label: 'À propos', to: '/about', icon: Info },
  { label: 'Aide', icon: MessagesSquare, onSelect: () => window.dispatchEvent(new Event('leroutier:assistant-open')) },
  signedIn ? { label: 'Mon compte', to: '/account', icon: UserRound } : { label: 'Se connecter', to: '/account', icon: UserRound },
].map(item => ({ ...item, current: Boolean(item.to) && item.to === pathname }));
