import { createContext, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api } from './api.ts';
import { LANG_NAMES, setLang, t, useLang } from './i18n.ts';
import { Icon, Link, Loading, usePath } from './ui.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { Home } from './pages/Home.tsx';
import { PlaceView, UnitView } from './pages/Places.tsx';
import { ApprovalList, ApprovalNew, ApprovalView } from './pages/Approvals.tsx';
import { Committees, PeopleList, PersonView } from './pages/People.tsx';
import { Activity, MoreMenu, Roles, Rules, SettingsPage } from './pages/Settings.tsx';
import { VendorList, VendorView } from './pages/Procurement.tsx';
import { AssetList, AssetNew, AssetView, isStaff, Requests, RoutineList, RoutineNew, RoutineView, Today, WorkOrderNew, WorkOrders,
  WorkOrderView } from './pages/Work.tsx';

export type Community = { platformName: string; brandName: string; primaryColor: string; languages: string[]; assistantName: string; hasLogo: boolean; isDemo: boolean };
export type Me = { person: { id: string; name: string; phone: string }; roles: { key: string; name: string; scope: string | null }[];
  permissions: string[]; homes: any[]; committees: any[]; waitingForMyVote: number };

const Ctx = createContext<{ community: Community; me: Me; refreshMe: () => void; refreshCommunity: () => void } | null>(null);
export const useApp = () => useContext(Ctx)!;
export const can = (me: Me, p: string) => me.permissions.includes(p);
export const signOut = async () => { await api.post('/api/auth/signout'); location.href = '/'; };

function applyBrand(c: Community) {
  document.documentElement.style.setProperty('--brand', c.primaryColor);
  document.title = c.platformName;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', c.primaryColor);
}

function App() {
  useLang();
  const [community, setCommunity] = useState<Community | null>(null);
  const [missing, setMissing] = useState(false);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const loadCommunity = () => api.get<Community>('/api/public/community').then(c => { setCommunity(c); applyBrand(c); }).catch(() => setMissing(true));
  const loadMe = () => api.get<Me>('/api/me').then(setMe).catch(() => setMe(null));
  useEffect(() => {
    loadCommunity(); loadMe();
    const out = () => setMe(null);
    window.addEventListener('pragati:signed-out', out);
    return () => window.removeEventListener('pragati:signed-out', out);
  }, []);

  if (missing) return <main><h1>No community here</h1><p>This web address is not set up yet. Check the link your association shared.</p></main>;
  if (!community || me === undefined) return <main><Loading /></main>;
  if (!me) return <SignIn community={community} onSignedIn={loadMe} />;
  return <Ctx.Provider value={{ community, me, refreshMe: loadMe, refreshCommunity: loadCommunity }}><Frame /></Ctx.Provider>;
}

function Frame() {
  const { community, me } = useApp();
  const path = usePath().split('?')[0];
  const lang = useLang();
  // Staff see the day's work; owners and residents see their own requests. People sits under More on phones.
  const tabs: { to: string; label: string; icon: React.ReactNode; match: (p: string) => boolean; badge?: number; desktopOnly?: boolean }[] = [
    { to: '/', label: t('Home'), icon: Icon.home, match: (p: string) => p === '/' },
    isStaff(me) ? { to: '/work', label: t('Work'), icon: Icon.work, match: (p: string) => p.startsWith('/work') }
      : { to: '/requests', label: t('Requests'), icon: Icon.work, match: (p: string) => p.startsWith('/requests') || p.startsWith('/work') },
    { to: '/approvals', label: t('Approvals'), icon: Icon.approve, match: (p: string) => p.startsWith('/approvals'), badge: me.waitingForMyVote },
    { to: '/places', label: t('Places'), icon: Icon.plan, match: (p: string) => p.startsWith('/places') || p.startsWith('/units') },
    { to: '/people', label: t('People'), icon: Icon.people, match: (p: string) => p.startsWith('/people') || p.startsWith('/committees'), desktopOnly: true },
    { to: '/more', label: t('More'), icon: Icon.more, match: (p: string) => p.startsWith('/more') || p.startsWith('/settings') },
  ];

  let page;
  const m = (re: RegExp) => re.exec(path);
  let r: RegExpExecArray | null;
  if (path === '/') page = <Home />;
  else if (path === '/places') page = <PlaceView id={null} />;
  else if ((r = m(/^\/places\/([\w-]+)$/))) page = <PlaceView id={r[1]} />;
  else if ((r = m(/^\/units\/([\w-]+)$/))) page = <UnitView id={r[1]} />;
  else if (path === '/approvals') page = <ApprovalList />;
  else if (path === '/approvals/new') page = <ApprovalNew />;
  else if ((r = m(/^\/approvals\/([\w-]+)$/))) page = <ApprovalView id={r[1]} />;
  else if (path === '/people') page = <PeopleList />;
  else if ((r = m(/^\/people\/([\w-]+)$/))) page = <PersonView id={r[1]} />;
  else if (path === '/committees') page = <Committees />;
  else if (path === '/work') page = <Today />;
  else if (path === '/work/orders') page = <WorkOrders />;
  else if (path === '/work/orders/new') page = <WorkOrderNew />;
  else if ((r = m(/^\/work\/orders\/([\w-]+)$/))) page = <WorkOrderView id={r[1]} />;
  else if (path === '/work/routines') page = <RoutineList />;
  else if (path === '/work/routines/new') page = <RoutineNew />;
  else if ((r = m(/^\/work\/routines\/([\w-]+)$/))) page = <RoutineView id={r[1]} />;
  else if (path === '/work/assets') page = <AssetList />;
  else if (path === '/work/assets/new') page = <AssetNew />;
  else if ((r = m(/^\/work\/assets\/([\w-]+)$/))) page = <AssetView id={r[1]} />;
  else if (path === '/work/vendors') page = <VendorList />;
  else if ((r = m(/^\/work\/vendors\/([\w-]+)$/))) page = <VendorView id={r[1]} />;
  else if (path === '/requests') page = <Requests />;
  else if (path === '/more') page = <MoreMenu />;
  else if (path === '/settings') page = <SettingsPage />;
  else if (path === '/settings/roles') page = <Roles />;
  else if (path === '/settings/rules') page = <Rules />;
  else if (path === '/settings/activity') page = <Activity />;
  else page = <><h1>Not found</h1><p><Link to="/">Go to {t('Home')}</Link></p></>;

  return <div className="frame">
    <header className="topbar">
      {community.hasLogo ? <img className="logo" src="/api/public/logo" alt="" /> : <span className="mark" aria-hidden="true">{community.brandName[0]}</span>}
      <Link to="/" className="platform">{community.platformName}</Link>
      <span className="spacer" />
      {community.languages.length > 1 && <select aria-label={t('Language')} value={lang} onChange={e => setLang(e.target.value)}>
        {community.languages.map(l => <option key={l} value={l}>{LANG_NAMES[l] ?? l}</option>)}
      </select>}
      <span className="who desktop-only">{me.person.name.split(' ')[0]}</span>
      <button className="desktop-only" onClick={() => signOut()} style={{ minHeight: 36, padding: '6px 12px' }}>{t('Sign out')}</button>
    </header>
    <nav className="nav" aria-label="Main">
      {tabs.map(tab => <Link key={tab.to} to={tab.to} aria-current={tab.match(path) ? 'page' : undefined} className={tab.desktopOnly ? 'desktop-tab' : undefined}>
        {tab.icon}<span>{tab.label}</span>{tab.badge ? <span className="badge" aria-label={`${tab.badge} waiting`}>{tab.badge}</span> : null}
      </Link>)}
    </nav>
    <main id="main">{community.isDemo && <p className="note demo-note">This is a demo community. Every name, number and amount is made up.</p>}{page}</main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
