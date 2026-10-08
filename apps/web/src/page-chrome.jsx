import { Link, useLocation, useNavigate } from 'react-router';
import { AppShell } from '@leroutier/ui';
import { useSession } from '@leroutier/config/client';
import { LegalFooter } from './legal.jsx';
import { publicLinks, publicMenu, passengerTabs } from './public-nav.js';

/**
 * The public shell for the pages that are routed ABOVE <App> — the about page,
 * the legal pages and the topic pages — rather than inside it.
 *
 * Those pages were full-width documents with no header at all: you arrived
 * from a search engine and the only way back into the product was a link in
 * the footer. They now carry the same header, the same drawer and the same
 * footer as the rest of the public product, which is the point of having a
 * shell — and it is the same component, not a second copy of it.
 *
 * The page keeps its own <main>: AppShell renders the landmark and children
 * provide the article.
 */
export function PageChrome({ children }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user } = useSession();
  // The same four destinations the rest of the public product carries. These
  // pages are reached from the footer, from a search engine, and from each
  // other; without the bar, the bottom of the screen on a phone is a legal
  // notice with no way back into the product above it.
  //
  // None of the four is current here, and none is meant to be: this is not a
  // fifth destination, it is the product's navigation passing through.
  const section = pathname.split('/').filter(Boolean)[0] ?? '';
  return <AppShell
    variant="public" role="Voyageur" title="LeRoutier" active={pathname}
    onHome={() => navigate('/')} linkComponent={Link}
    links={publicLinks(null)} menu={publicMenu({ signedIn: Boolean(user), pathname })}
    bottomNav={passengerTabs(section)}
    menuTitle="Menu LeRoutier" footer={<LegalFooter/>}>
    <div className="page-shell">{children}</div>
  </AppShell>;
}
