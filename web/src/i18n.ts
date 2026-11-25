// Interface words in English and Tamil. Tamil strings are a first draft for review by a native
// speaker before launch; anything missing falls back to English.
import { useSyncExternalStore } from 'react';

const ta: Record<string, string> = {
  Home: 'முகப்பு', Places: 'இடங்கள்', Approvals: 'ஒப்புதல்கள்', People: 'நபர்கள்', More: 'மேலும்',
  Committees: 'குழுக்கள்', Settings: 'அமைப்புகள்', 'Sign out': 'வெளியேறு', 'Sign in': 'உள்நுழை',
  'Mobile number': 'கைபேசி எண்', 'Send code': 'குறியீட்டை அனுப்பு', 'Enter the 6-digit code': '6 இலக்கக் குறியீட்டை உள்ளிடவும்',
  Approve: 'ஒப்புதல் அளி', Object: 'ஆட்சேபனை', 'Waiting for your vote': 'உங்கள் வாக்கிற்காகக் காத்திருக்கிறது',
  'Your homes': 'உங்கள் வீடுகள்', Units: 'வீடுகள்', Owners: 'உரிமையாளர்கள்', 'New request': 'புதிய கோரிக்கை',
  Search: 'தேடு', Approved: 'ஒப்புதல் பெற்றது', Pending: 'நிலுவையில்', Rejected: 'நிராகரிக்கப்பட்டது', Withdrawn: 'திரும்பப் பெறப்பட்டது',
  'Use a different number': 'வேறு எண்ணைப் பயன்படுத்து', Language: 'மொழி',
  Work: 'பணிகள்', Requests: 'கோரிக்கைகள்', Today: 'இன்று', Money: 'கணக்குகள்', Dues: 'நிலுவை',
};
const dict: Record<string, Record<string, string>> = { ta };

let lang = (() => { try { return localStorage.getItem('pragati.lang') ?? 'en'; } catch { return 'en'; } })();
const listeners = new Set<() => void>();

export function setLang(l: string) {
  lang = l;
  try { localStorage.setItem('pragati.lang', l); } catch { /* private mode */ }
  document.documentElement.lang = l;
  listeners.forEach(f => f());
}
export function useLang() {
  return useSyncExternalStore(f => { listeners.add(f); return () => listeners.delete(f); }, () => lang);
}
export function t(s: string) { return dict[lang]?.[s] ?? s; }
export const LANG_NAMES: Record<string, string> = { en: 'English', ta: 'தமிழ்', hi: 'हिन्दी', te: 'తెలుగు', kn: 'ಕನ್ನಡ', ml: 'മലയാളം' };
