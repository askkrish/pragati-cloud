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
  Work: 'பணிகள்', Requests: 'கோரிக்கைகள்', Today: 'இன்று', Money: 'கணக்குகள்', Dues: 'நிலுவை', Notices: 'அறிவிப்புகள்',
  // Printed packs and statements
  'Weekly committee pack': 'வாராந்திர குழு அறிக்கை', "Owners' monthly update": 'உரிமையாளர்களுக்கான மாதாந்திர அறிக்கை',
  'checks done': 'சோதனைகள் முடிந்தன', 'checks missed': 'தவறிய சோதனைகள்', 'open work orders': 'நிலுவையிலுள்ள பணிகள்', overdue: 'காலம் கடந்தவை',
  'dues outstanding': 'நிலுவைத் தொகை', homes: 'வீடுகள்', 'Routine checks': 'வழக்கமான சோதனைகள்', 'Kind of work': 'பணி வகை', Due: 'திட்டமிடப்பட்டவை',
  Done: 'முடிந்தவை', Missed: 'தவறியவை', Late: 'தாமதம்', 'Missed checks': 'தவறிய சோதனைகள்', 'Work orders': 'பணி ஆணைகள்', opened: 'தொடங்கப்பட்டவை',
  closed: 'முடிக்கப்பட்டவை', 'service requests raised this week': 'இந்த வாரம் பெறப்பட்ட சேவைக் கோரிக்கைகள்', 'Oldest open work': 'பழைய நிலுவைப் பணிகள்',
  'Given to': 'பொறுப்பாளர்', 'Days open': 'நாட்கள்', 'Renewals overdue or due within 30 days': 'காலம் கடந்த மற்றும் 30 நாட்களுக்குள் புதுப்பிக்க வேண்டியவை', 'Waiting for approval': 'ஒப்புதலுக்காகக் காத்திருப்பவை',
  days: 'நாட்கள்', 'Nothing is waiting.': 'எதுவும் காத்திருக்கவில்லை.', 'Decided this week': 'இந்த வாரம் முடிவானவை', 'Cash and bank': 'ரொக்கம் மற்றும் வங்கி',
  Account: 'கணக்கு', Opening: 'தொடக்க இருப்பு', In: 'வரவு', Out: 'செலவு', Closing: 'இறுதி இருப்பு', 'overdue by more than 90 days, from': '90 நாட்களுக்கு மேல் நிலுவை,',
  'Payments this week': 'இந்த வாரச் செலுத்துகைகள்', 'Notices published': 'வெளியிடப்பட்ட அறிவிப்புகள்',
  'of scheduled checks done': 'திட்டமிட்ட சோதனைகள் முடிந்தன', 'requests fixed': 'கோரிக்கைகள் சரிசெய்யப்பட்டன', of: 'மொத்தம்', raised: 'பெறப்பட்டவை',
  'days on average to fix a request': 'ஒரு கோரிக்கையைச் சரிசெய்ய சராசரி நாட்கள்', 'maintenance jobs and projects completed': 'முடிந்த பராமரிப்புப் பணிகள் மற்றும் திட்டங்கள்',
  "of the month's maintenance collected": 'மாதப் பராமரிப்புக் கட்டணம் வசூலானது', 'projects in progress': 'நடைபெறும் திட்டங்கள்',
  'notices were published for owners this month.': 'அறிவிப்புகள் இந்த மாதம் உரிமையாளர்களுக்கு வெளியிடப்பட்டன.',
  'Figures are counts for the whole community. Your own dues and requests are in the app.': 'இவை முழுக் குடியிருப்புக்கான எண்ணிக்கைகள். உங்கள் நிலுவையும் கோரிக்கைகளும் செயலியில் உள்ளன.',
  'Statement of dues': 'நிலுவை அறிக்கை', 'As on': 'தேதி வரை', 'Amount due': 'செலுத்த வேண்டிய தொகை', 'Paid in advance': 'முன்கூட்டியே செலுத்தியது',
  'Nothing is due.': 'நிலுவை எதுவும் இல்லை.', Date: 'தேதி', Particulars: 'விவரம்', Charged: 'கட்டணம்', Paid: 'செலுத்தியது', Balance: 'இருப்பு',
  'Payment voucher': 'செலுத்துகைச் சீட்டு', 'Pay to': 'பெறுநர்', For: 'எதற்காக', Invoice: 'விலைப்பட்டியல்', Amount: 'தொகை', TDS: 'TDS',
  'net payable': 'செலுத்த வேண்டியது', Approval: 'ஒப்புதல்', 'Not yet paid': 'இன்னும் செலுத்தப்படவில்லை', 'Prepared by': 'தயாரித்தவர்',
  Treasurer: 'பொருளாளர்', 'President or Secretary': 'தலைவர் அல்லது செயலர்', 'Received by': 'பெற்றவர்',
  Security: 'பாதுகாப்பு', Housekeeping: 'தூய்மைப் பணி', Garden: 'தோட்டம்', Electrical: 'மின்சாரம்', Plumbing: 'குழாய்', Lifts: 'மின்தூக்கிகள்',
  Water: 'நீர்', 'Fire safety': 'தீ பாதுகாப்பு', Pool: 'நீச்சல் குளம்', Waste: 'கழிவு', General: 'பொது',
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
