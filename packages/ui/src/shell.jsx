import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Wifi, WifiOff, Menu, X, ChevronRight } from 'lucide-react';
import { Logo } from './logo.jsx';

/**
 * One link primitive for both shells.
 *
 * `@leroutier/ui` deliberately does not depend on react-router — the console
 * screens are rendered by the web app, and a router import here would make the
 * component library unusable outside it. The web app passes its own `Link` in;
 * everything else falls back to an anchor, which is also what a static render
 * of this shell would want.
 *
 * @param {{ to: string, component?: any, className?: string, children: ReactNode, [key: string]: any }} props
 */
function ShellLink({ to, component: Component, className, children, ...rest }) {
  if (Component) return <Component to={to} className={className} {...rest}>{children}</Component>;
  return <a href={to} className={className} {...rest}>{children}</a>;
}

/**
 * The mobile navigation drawer.
 *
 * A modal dialog rather than a panel that happens to be on screen: focus moves
 * in on open, cannot leave while it is open, Escape closes it, and focus goes
 * back to the button that opened it. On a phone this is the only route to half
 * the product, so it has to be usable without a pointer.
 *
 * @param {{ open: boolean, onClose: () => void, title: string, items: any[], linkComponent?: any, footer?: ReactNode }} props
 */
function Drawer({ open, onClose, title, items, linkComponent, footer }) {
  const panel = useRef(/** @type {HTMLDivElement | null} */ (null));
  const close = useRef(/** @type {HTMLButtonElement | null} */ (null));

  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    // The page behind a modal must not scroll away underneath it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const nodes = /** @type {HTMLElement[]} */ ([...(panel.current?.querySelectorAll('a[href], button:not(:disabled)') ?? [])]);
      if (!nodes.length) return;
      const active = /** @type {HTMLElement | null} */ (document.activeElement);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = previous; };
  }, [open, onClose]);

  if (!open) return null;
  return <>
    <div className="lr-drawer-scrim" onClick={onClose}/>
    <div className="lr-drawer" ref={panel} role="dialog" aria-modal="true" aria-label={title} id="lr-menu">
      <div className="lr-drawer-head">
        <span className="lr-drawer-title">{title}</span>
        <button ref={close} className="icon-btn" onClick={onClose} aria-label="Fermer le menu"><X size={19}/></button>
      </div>
      <nav aria-label="Menu principal">
        <ul>{items.map((item, index) => {
          const Icon = item.icon;
          const inner = <>
            {Icon && <Icon size={19} aria-hidden="true"/>}
            <span className="grow">{item.label}</span>
            {item.badge > 0 && <Badge tone="danger">{item.badge > 9 ? '9+' : item.badge}</Badge>}
            {!item.badge && <ChevronRight size={16} aria-hidden="true" style={{ opacity: .35 }}/>}
          </>;
          // An entry that acts rather than navigates — opening the assistant —
          // is a button, not a link to nowhere.
          return <li key={`${item.to ?? 'action'}:${item.label}:${index}`}>
            {item.onSelect && !item.to
              ? <button type="button" className="lr-drawer-item" onClick={() => { item.onSelect(); onClose(); }}>{inner}</button>
              : <ShellLink to={item.to} component={linkComponent} onClick={onClose} aria-current={item.current ? 'page' : undefined}>{inner}</ShellLink>}
          </li>;
        })}</ul>
      </nav>
      {footer && <div className="lr-drawer-foot">{footer}</div>}
    </div>
  </>;
}

/**
 * @typedef {import('react').ReactNode} ReactNode
 * @typedef {import('lucide-react').LucideIcon} Icon
 * @param {{
 *   role: string, title: string, subtitle?: string,
 *   nav?: { id: string, label: string, icon: Icon }[], active?: string, onNavigate?: (id: string) => void,
 *   children: ReactNode, online?: boolean, actions?: ReactNode, avatar?: ReactNode,
 *   onNotifications?: () => void, unread?: number, onHome?: () => void,
 *   variant?: 'public'|'app', links?: { label: string, to: string, current?: boolean }[],
 *   menu?: { label: string, to?: string, icon?: Icon, badge?: number, onSelect?: () => void }[],
 *   bottomNav?: { label: string, to: string, icon: Icon, current?: boolean }[],
 *   menuTitle?: string, menuFooter?: ReactNode, footer?: ReactNode, linkComponent?: any, bleed?: boolean,
 * }} props
 */
export function AppShell({
  role, title, subtitle, nav = [], active, onNavigate, children,
  online = true, actions, avatar = null, onNotifications, unread = 0, onHome,
  variant = 'app', links = [], menu = [], menuTitle = 'Menu', menuFooter = null, footer = null, linkComponent, bleed = false,
  bottomNav = [],
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isPublic = variant === 'public';
  // The floating assistant is mounted by the application, outside this shell —
  // it stays alive across navigations, which is what keeps a conversation
  // going when somebody moves between pages. So it cannot be found with a
  // descendant selector from here, and it has to be told in a way that outlives
  // a selector: the body carries the fact that the bottom of the screen is
  // already occupied by navigation.
  //
  // TWO KINDS OF BOTTOM BAR, and the difference is not cosmetic. `nav` is a
  // task bar: the same screen swapping between four jobs, driven by a callback.
  // `bottomNav` is a destination bar: four places, each a real URL a traveller
  // can open in a new tab, bookmark, or come back to. A traveller's navigation
  // has to be the second kind, which is why it is a separate prop rather than
  // the same one rendered differently.
  const bar = nav.length > 0 ? 'bottom' : bottomNav.length > 0 ? 'public' : 'none';
  useEffect(() => { document.body.dataset.nav = bar; }, [bar]);
  const roleKey = String(role || 'public').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
  const pageKey = String(active || title || 'home').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  // Escape has to work from the trigger too: focus is on the button for a
  // moment after the drawer's own trap hands it back.
  const onMenuKey = useCallback(event => { if (event.key === 'Escape') setMenuOpen(false); }, []);
  const hasDrawer = menu.length > 0;

  // `data-nav` is how the floating assistant knows whether the bottom of the
  // screen is already occupied by task navigation it must not cover.
  return <div className="lr-app" data-role={roleKey} data-page={pageKey} data-variant={isPublic ? 'public' : 'app'} data-nav={bar}>
    <a className="skip-link" href="#lr-content">Aller au contenu</a>
    <header className="lr-header">
      <div className="lr-header-main">
        <div className="lr-brand-wrap">
          {onHome
            ? <button className="lr-brand-btn" onClick={onHome} aria-label="Accueil LeRoutier"><Logo className="lr-logo"/></button>
            : <Logo className="lr-logo"/>}
          {!isPublic && <div className="lr-page-title"><strong>{title}</strong><span>{subtitle || role}</span></div>}
        </div>

        {/* Public header: four destinations, and a menu button on a phone.
            Operational consoles keep their workspace furniture instead. */}
        {isPublic && <nav className="lr-nav" aria-label="Navigation principale">
          <ul>{links.map(link => <li key={link.to}>
            <ShellLink to={link.to} component={linkComponent} aria-current={link.current ? 'page' : undefined}>{link.label}</ShellLink>
          </li>)}</ul>
        </nav>}

        <div className="lr-header-actions">
          {!isPublic && <>
            <Badge tone={online ? 'success' : 'neutral'}>{online ? <Wifi size={14}/> : <WifiOff size={14}/>} {online ? 'En ligne' : 'Hors-ligne'}</Badge>
            {actions}
            <button className="icon-btn" aria-label={unread > 0 ? `Notifications (${unread} non lues)` : 'Notifications'} onClick={onNotifications} disabled={!onNotifications}>
              <Bell size={19}/>{unread > 0 && <span className="icon-badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
            </button>
          </>}
          {avatar}
          {isPublic && hasDrawer && <button className="lr-menu-btn" aria-label="Ouvrir le menu" aria-expanded={menuOpen}
            aria-controls="lr-menu" onClick={() => setMenuOpen(v => !v)} onKeyDown={onMenuKey}>
            <Menu size={20}/>
          </button>}
        </div>
      </div>
      {/* Where "what page am I on" lives below 720px, because .lr-page-title is
          display:none there. Above 720px that title is already on screen two
          elements away, so this half is hidden rather than repeated. */}
      {!isPublic && <div className="lr-role-strip"><span>{role}</span><small>{title}</small></div>}
    </header>

    {/* `bleed` is for the one page that carries full-width bands — the public
        home, whose hero is edge to edge. Every other page keeps the container:
        without it their content starts at x=0 with no gutter at all.

        `key` is the page, and it is what makes the entrance replay: a change
        of destination remounts this element, which restarts one 240ms fade and
        rise. Keyed on the page rather than the URL, so refining a search on
        the results screen does not re-animate the page underneath the user. */}
    {/* `tabIndex={-1}` so the region can take focus: it is where a route change
        hands the reader next, and it is what the skip link at the top of the
        page has always pointed at. Without it that link moves a browser's
        attention and nothing else. */}
    <main key={active} className={`${bleed ? 'lr-main is-public' : 'lr-main'} lr-enter`} id="lr-content" tabIndex={-1}>{children}</main>

    {footer}
    {nav.length > 0 && <nav className="lr-bottom-nav" aria-label={`Navigation ${role}`}>{nav.map(item => { const Icon = item.icon; const selected = active === item.id; return <button key={item.id} className={selected ? 'active' : ''} onClick={() => onNavigate?.(item.id)} aria-current={selected ? 'page' : undefined}><Icon size={22}/><span>{item.label}</span></button>; })}</nav>}
    {/* The traveller's four destinations, on the phones where a header row of
        links has nowhere to go. Links rather than buttons for the same reason
        the header uses them: these are places, and a place has an address. */}
    {bottomNav.length > 0 && <nav className="lr-bottom-nav lr-bottom-nav-public" aria-label="Navigation voyageur">
      {bottomNav.map(item => { const Icon = item.icon; return <ShellLink key={item.to} to={item.to} component={linkComponent}
        className={item.current ? 'active' : ''} aria-current={item.current ? 'page' : undefined}>
        <Icon size={22} aria-hidden="true"/><span>{item.label}</span>
      </ShellLink>; })}
    </nav>}
    {hasDrawer && <Drawer open={menuOpen} onClose={closeMenu} title={menuTitle} items={menu} linkComponent={linkComponent} footer={menuFooter}/>}
  </div>;
}

/** @param {{ children: ReactNode, className?: string, tone?: string }} props */
export function Card({ children, className = '', tone = 'default' }) { return <section className={`card card-${tone} ${className}`}>{children}</section>; }
/** @param {{ children: ReactNode, tone?: string }} props */
export function Badge({ children, tone = 'neutral' }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
/** @param {{ label: string, value: ReactNode, hint?: string, icon?: Icon, tone?: string }} props */
export function StatCard({ label, value, hint, icon: Icon, tone = 'default' }) { return <Card className="stat-card"><div className={`stat-icon stat-${tone}`}>{Icon && <Icon size={18}/>}</div><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</Card>; }
/** @param {{ icon?: Icon, title: string, trailing?: ReactNode }} props */
export function SectionTitle({ icon: Icon, title, trailing }) { return <div className="section-title"><div>{Icon && <Icon size={20}/>}<h2>{title}</h2></div>{trailing}</div>; }
/** @param {{ icon?: Icon, title: string, text: string, action?: ReactNode }} props */
export function EmptyState({ icon: Icon, title, text, action }) { return <Card className="empty"><div className="empty-icon">{Icon && <Icon size={26}/>}</div><strong>{title}</strong><p>{text}</p>{action}</Card>; }
