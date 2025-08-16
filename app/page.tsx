'use client';

import { useEffect, useMemo, useState } from 'react';
import { addWeeks, format } from 'date-fns';
import { nl } from 'date-fns/locale';

/* =========================
   Types
========================= */
type MatchCategory = 'training' | 'wedstrijd';

interface Reservation {
  date: string; // yyyy-MM-dd
  timeSlot: string; // '18u30-19u30'
  court: number; // 1..3
  matchType: 'single' | 'double';
  category: MatchCategory; // training | wedstrijd
  // Bij single: players: [a,b]
  // Bij double: players: [x1,x2,y1,y2]
  // Lege plekken worden bewaard als '' zodat spelers stapsgewijs kunnen invullen
  players: string[];
  // Resultaat:
  // single:  { winner: 'A', loser: 'B' }
  // double:  { winners: ['A','B'], losers: ['C','D'] }
  result?: {
    winner?: string;
    loser?: string;
    winners?: [string, string];
    losers?: [string, string];
  };
  // Markering om dubbele meldingen te vermijden zodra match voor het eerst vol is
  notifiedFull?: boolean;
}

type Availability = Record<string, Record<string, Record<string, boolean>>>;

interface UserSession {
  playerName: string;
}

type Message = {
  id: string;
  to: string; // playerName
  text: string;
  createdAt: number;
  read: boolean;
};

type TabKey = 'reservatie' | 'beschikbaarheid' | 'ladderEnkel' | 'ladderDubbel';

/* =========================
   Data
========================= */
const PLAYERS_SCORES: Record<string, number> = {
  Mattias: 55,
  Ruben: 70,
  Seppe: 55,
  Tibo: 60,
  Aaron: 50,
  Koenraad: 10,
  Brent: 5,
  Nicolas: 15,
  Remi: 20,
  SanderD: 25,
  Gilles: 10,
  Thomas: 35,
  Wout: 20,
  SanderB: 75,
};
const PLAYERS = Object.keys(PLAYERS_SCORES);

// Hardcoded wachtwoorden
const ADMIN_NAME = 'Mattias';
const PASSWORDS: Record<string, string> = {
  Mattias: 'ZAT2025*',
  Ruben: 'Ruben2025!',
  Seppe: 'Seppe2025!',
  Tibo: 'Tibo2025!',
  Aaron: 'Aaron2025!',
  Koenraad: 'Koenraad2025!',
  Brent: 'Brent2025!',
  Nicolas: 'Nicolas2025!',
  Remi: 'Remi2025!',
  SanderD: 'SanderD2025!',
  Gilles: 'Gilles2025!',
  Thomas: 'Thomas2025!',
  Wout: 'Wout2025!',
  SanderB: 'SanderB2025!',
};

const TIME_SLOTS = [
  { id: '18u30-19u30', label: '18u30-19u30' },
  { id: '19u30-20u30', label: '19u30-20u30' },
];

/* =========================
   Utils
========================= */
const scoreOf = (name: string) => PLAYERS_SCORES[name] ?? 0;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function combinations4<T>(arr: T[]): Array<[T, T, T, T]> {
  const res: Array<[T, T, T, T]> = [];
  const n = arr.length;
  for (let i = 0; i < n - 3; i++) {
    for (let j = i + 1; j < n - 2; j++) {
      for (let k = j + 1; k < n - 1; k++) {
        for (let l = k + 1; l < n; l++) {
          res.push([arr[i], arr[j], arr[k], arr[l]]);
        }
      }
    }
  }
  return res;
}

/* =========================
   Storage keys
========================= */
const RESERV_KEY = 'zat-reservations';
const AVAIL_KEY = 'zat-availability';
const MATCHTYPE_KEY = 'zat-court-matchtype';
const CATEGORY_KEY = 'zat-court-category';
const SELECTED_DATE_KEY = 'zat-selected-date';
const SESSION_KEY = 'zat-session';
const ACTIVE_TAB_KEY = 'zat-active-tab';
const MSG_KEY = 'zat-messages';

/* =========================
   Small UI bits
========================= */
const PlayerChip = ({
  name,
  size = 'md',
  highlight = false,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  highlight?: boolean;
}) => {
  const base =
    'inline-flex items-center gap-2 rounded-full bg-white shadow-sm border';
  const sizeCls =
    size === 'sm'
      ? 'text-xs px-2 py-0.5'
      : size === 'lg'
      ? 'text-base px-3 py-1.5'
      : 'text-sm px-2.5 py-1';
  const badgeCls =
    size === 'sm'
      ? 'text-[10px] px-1.5 py-0.5'
      : size === 'lg'
      ? 'text-xs px-2 py-0.5'
      : 'text-xs px-1.5 py-0.5';

  return (
    <div
      className={`${base} ${
        highlight ? 'border-green-400 ring-2 ring-green-300' : 'border-gray-200'
      } ${sizeCls}`}
    >
      <span className="font-semibold text-gray-900">{name}</span>
      <span className={`rounded-full bg-purple-600 text-white ${badgeCls}`}>
        {scoreOf(name)}
      </span>
    </div>
  );
};

/** Echte net-look met raster + witte band bovenaan */
const TennisNet = () => (
  <div className="relative w-full my-1 h-10" aria-hidden>
    {/* Witte band */}
    <div className="absolute left-0 right-0 top-0 h-2 bg-white rounded-sm shadow-sm" />
    {/* Raster */}
    <div
      className="absolute left-0 right-0 bottom-0"
      style={{
        top: '0.5rem',
        backgroundImage:
          'linear-gradient(to right, rgba(255,255,255,0.85) 1px, transparent 1px),' +
          'linear-gradient(to bottom, rgba(255,255,255,0.85) 1px, transparent 1px)',
        backgroundSize: '8px 8px',
        backgroundColor: 'rgba(0,0,0,0.15)',
        borderTop: '1px solid rgba(255,255,255,0.6)',
        borderBottom: '1px solid rgba(255,255,255,0.6)',
      }}
    />
  </div>
);

/* =========================
   Page
========================= */
export default function Page() {
  /* --- Dates --- */
  const startDate = new Date(2025, 8, 28); // 28 sept 2025
  const sundays = useMemo(
    () => Array.from({ length: 20 }, (_, i) => addWeeks(startDate, i)),
    []
  );
  const [selectedDate, setSelectedDate] = useState<string>(
    format(sundays[0], 'yyyy-MM-dd')
  );

  /* --- Session --- */
  const [session, setSession] = useState<UserSession | null>(null);
  const myName = session?.playerName ?? null;
  const isAdmin = myName === ADMIN_NAME;

  /* --- Core state --- */
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [availability, setAvailability] = useState<Availability>({});
  const [matchTypes, setMatchTypes] = useState<
    Record<string, 'single' | 'double'>
  >({});
  const [categories, setCategories] = useState<Record<string, MatchCategory>>(
    {}
  );

  /* --- Messages (meldingen) --- */
  const [messages, setMessages] = useState<Message[]>([]);

  /* --- UI state --- */
  const [activeTab, setActiveTab] = useState<TabKey>('reservatie');
  const [loginName, setLoginName] = useState(PLAYERS[0]);
  const [loginPass, setLoginPass] = useState('');
  const [loginErr, setLoginErr] = useState<string | null>(null);

  /* --- Helpers for UI --- */
  const selectClass =
    'w-full p-2 border border-gray-300 rounded text-sm font-medium focus:ring-1 focus:ring-blue-500 bg-white text-gray-900 placeholder-gray-400';
  const inputClass =
    'w-full border border-gray-300 rounded px-3 py-2 bg-white text-gray-900 placeholder-gray-400';

  const courtClass =
    'relative bg-green-600 rounded-xl p-5 h-80 md:h-96 pb-14 flex flex-col justify-between border-4 border-green-700';

  /* =========================
     Persist & load
  ========================= */
  useEffect(() => {
    try {
      const r = localStorage.getItem(RESERV_KEY);
      if (r) setReservations(JSON.parse(r));
      const a = localStorage.getItem(AVAIL_KEY);
      if (a) setAvailability(JSON.parse(a));
      const mt = localStorage.getItem(MATCHTYPE_KEY);
      if (mt) setMatchTypes(JSON.parse(mt));
      const cat = localStorage.getItem(CATEGORY_KEY);
      if (cat) setCategories(JSON.parse(cat));
      const sd = localStorage.getItem(SELECTED_DATE_KEY);
      if (sd) setSelectedDate(sd);
      const sess = localStorage.getItem(SESSION_KEY);
      if (sess) setSession(JSON.parse(sess));
      const tab = localStorage.getItem(ACTIVE_TAB_KEY) as TabKey | null;
      if (
        tab &&
        [
          'reservatie',
          'beschikbaarheid',
          'ladderEnkel',
          'ladderDubbel',
        ].includes(tab)
      ) {
        setActiveTab(tab);
      }
      const m = localStorage.getItem(MSG_KEY);
      if (m) setMessages(JSON.parse(m));
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(RESERV_KEY, JSON.stringify(reservations));
  }, [reservations]);
  useEffect(() => {
    localStorage.setItem(AVAIL_KEY, JSON.stringify(availability));
  }, [availability]);
  useEffect(() => {
    localStorage.setItem(MATCHTYPE_KEY, JSON.stringify(matchTypes));
  }, [matchTypes]);
  useEffect(() => {
    localStorage.setItem(CATEGORY_KEY, JSON.stringify(categories));
  }, [categories]);
  useEffect(() => {
    localStorage.setItem(SELECTED_DATE_KEY, selectedDate);
  }, [selectedDate]);
  useEffect(() => {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }, [session]);
  useEffect(() => {
    localStorage.setItem(ACTIVE_TAB_KEY, activeTab);
  }, [activeTab]);
  useEffect(() => {
    localStorage.setItem(MSG_KEY, JSON.stringify(messages));
  }, [messages]);

  // Cross-tab sync
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      try {
        if (e.key === RESERV_KEY && e.newValue)
          setReservations(JSON.parse(e.newValue));
        if (e.key === AVAIL_KEY && e.newValue)
          setAvailability(JSON.parse(e.newValue));
        if (e.key === MATCHTYPE_KEY && e.newValue)
          setMatchTypes(JSON.parse(e.newValue));
        if (e.key === CATEGORY_KEY && e.newValue)
          setCategories(JSON.parse(e.newValue));
        if (e.key === SELECTED_DATE_KEY && e.newValue)
          setSelectedDate(e.newValue);
        if (e.key === SESSION_KEY && e.newValue)
          setSession(JSON.parse(e.newValue));
        if (e.key === ACTIVE_TAB_KEY && e.newValue) {
          const t = e.newValue as TabKey;
          if (
            [
              'reservatie',
              'beschikbaarheid',
              'ladderEnkel',
              'ladderDubbel',
            ].includes(t)
          ) {
            setActiveTab(t);
          }
        }
        if (e.key === MSG_KEY && e.newValue)
          setMessages(JSON.parse(e.newValue));
      } catch {}
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /* =========================
     Helpers
  ========================= */
  const getCourtKey = (date: string, timeSlot: string, court: number) =>
    `${date}-${timeSlot}-${court}`;
  const getMatchType = (date: string, timeSlot: string, court: number) =>
    matchTypes[getCourtKey(date, timeSlot, court)] || 'single';
  const getCategory = (date: string, timeSlot: string, court: number) =>
    categories[getCourtKey(date, timeSlot, court)] || 'training';

  const canModifyReservation = (r: Reservation) =>
    isAdmin || (!!myName && r.players.includes(myName));

  const setMatchTypeFor = (
    date: string,
    timeSlot: string,
    court: number,
    type: 'single' | 'double'
  ) => {
    const key = getCourtKey(date, timeSlot, court);
    setMatchTypes((prev) => ({ ...prev, [key]: type }));
  };
  const setCategoryFor = (
    date: string,
    timeSlot: string,
    court: number,
    cat: MatchCategory
  ) => {
    const key = getCourtKey(date, timeSlot, court);
    setCategories((prev) => ({ ...prev, [key]: cat }));
  };

  const playersAvailableFor = (date: string, slot: string) => {
    const availForDate = availability[date] || {};
    const availForSlot = availForDate[slot] || {};
    return PLAYERS.filter((p) => availForSlot[p] !== false);
  };

  const getPlayersInSlot = (date: string, timeSlot: string) => {
    const set = new Set<string>();
    reservations.forEach((r) => {
      if (r.date === date && r.timeSlot === timeSlot)
        r.players.filter(Boolean).forEach((p) => set.add(p));
    });
    return set;
  };

  const isReservationFull = (r: Reservation) => {
    const needed = r.matchType === 'single' ? 2 : 4;
    if (r.players.length !== needed) return false;
    return r.players.every((p) => !!p && typeof p === 'string');
  };

  const findReservation = (date: string, timeSlot: string, court: number) =>
    reservations.find(
      (r) => r.date === date && r.timeSlot === timeSlot && r.court === court
    );

  const ensureReservation = (
    date: string,
    timeSlot: string,
    court: number
  ): Reservation => {
    const existing = findReservation(date, timeSlot, court);
    if (existing) return existing;
    const mt = getMatchType(date, timeSlot, court);
    const cat = getCategory(date, timeSlot, court);
    const size = mt === 'single' ? 2 : 4;
    const fresh: Reservation = {
      date,
      timeSlot,
      court,
      matchType: mt,
      category: cat,
      players: Array.from({ length: size }, () => ''),
    };
    setReservations((prev) => [...prev, fresh]);
    return fresh;
  };

  /* =========================
     Meldingen
  ========================= */
  const pushMessage = (to: string, text: string) => {
    const msg: Message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      to,
      text,
      createdAt: Date.now(),
      read: false,
    };
    setMessages((prev) => [msg, ...prev]);
  };

  const sendMatchFullMessages = (r: Reservation) => {
    const dateLab = format(new Date(r.date), 'dd/MM', { locale: nl });
    const text = `Match is volledig: ${dateLab} ${r.timeSlot} (Terrein ${r.court}).`;
    // 1 melding per speler
    const uniq = new Set<string>();
    r.players.filter(Boolean).forEach((p) => {
      if (!uniq.has(p)) {
        pushMessage(p, text);
        uniq.add(p);
      }
    });
  };

  /* =========================
     Login / Logout
  ========================= */
  const doLogin = () => {
    setLoginErr(null);
    const expected = PASSWORDS[loginName];
    if (!expected) {
      setLoginErr('Onbekende speler.');
      return;
    }
    if (loginPass !== expected) {
      setLoginErr('Onjuist wachtwoord.');
      return;
    }
    setSession({ playerName: loginName });
  };

  const logout = () => {
    setSession(null);
  };

  /* =========================
     Acties: admin (planners)
  ========================= */
  const buildCounts = (excludingDate?: string) => {
    const opponentCount: Record<string, number> = {};
    reservations.forEach((r) => {
      if (excludingDate && r.date === excludingDate) return;
      if (r.matchType === 'single') {
        const [a, b] = r.players.filter(Boolean);
        if (!a || !b) return;
        opponentCount[pairKey(a, b)] = (opponentCount[pairKey(a, b)] || 0) + 1;
      } else {
        const [x1, x2, y1, y2] = r.players;
        if (!x1 || !x2 || !y1 || !y2) return;
        [
          [x1, y1],
          [x1, y2],
          [x2, y1],
          [x2, y2],
        ].forEach(([a, b]) => {
          const k = pairKey(a, b);
          opponentCount[k] = (opponentCount[k] || 0) + 1;
        });
      }
    });
    return { opponentCount };
  };

  const planAllBalanced = () => {
    if (!isAdmin) return;
    const { opponentCount } = buildCounts();
    const result: Reservation[] = [];
    const mt: Record<string, 'single' | 'double'> = {};
    const cat: Record<string, MatchCategory> = {};

    const hours = sundays.flatMap((d) =>
      TIME_SLOTS.map((slot) => ({
        dateStr: format(d, 'yyyy-MM-dd'),
        slotId: slot.id,
      }))
    );

    const oppSeen = (a: string, b: string) => opponentCount[pairKey(a, b)] || 0;

    hours.forEach((hr, hourIdx) => {
      const groups = hourIdx % 2 === 0 ? [4, 4, 2] : [4, 2, 2];
      const used = new Set<string>();
      const available = new Set(playersAvailableFor(hr.dateStr, hr.slotId));

      const pickSingles = (): [string, string] | null => {
        const cand = PLAYERS.filter((p) => !used.has(p) && available.has(p));
        if (cand.length < 2) return null;
        const sorted = cand.slice().sort((a, b) => scoreOf(a) - scoreOf(b));
        let best: [string, string] | null = null;
        let bestScore = Infinity;
        for (let i = 0; i < sorted.length - 1; i++) {
          for (let j = i + 1; j < sorted.length; j++) {
            const a = sorted[i],
              b = sorted[j];
            const diff = Math.abs(scoreOf(a) - scoreOf(b));
            const s = diff * 12 + oppSeen(a, b) * 60 + Math.random() * 0.5;
            if (s < bestScore) {
              bestScore = s;
              best = [a, b];
            }
          }
        }
        return best;
      };

      const pickDoubles = () => {
        const cand = PLAYERS.filter((p) => !used.has(p) && available.has(p));
        if (cand.length < 4) return null;
        let best: { teamA: [string, string]; teamB: [string, string] } | null =
          null;
        let bestScore = Infinity;

        for (const [a, b, c, d] of combinations4(cand)) {
          const splits: Array<[[string, string], [string, string]]> = [
            [
              [a, b],
              [c, d],
            ],
            [
              [a, c],
              [b, d],
            ],
            [
              [a, d],
              [b, c],
            ],
          ];
          for (const [t1, t2] of splits) {
            const [x1, x2] = t1,
              [y1, y2] = t2;
            const sumA = scoreOf(x1) + scoreOf(x2);
            const sumB = scoreOf(y1) + scoreOf(y2);
            const sumDiff = Math.abs(sumA - sumB);
            let s = 0;
            s += sumDiff * 15;
            s +=
              oppSeen(x1, y1) +
              oppSeen(x1, y2) +
              oppSeen(x2, y1) +
              oppSeen(x2, y2);
            s += Math.random() * 0.5;
            if (s < bestScore) {
              bestScore = s;
              best = { teamA: [x1, x2], teamB: [y1, y2] };
            }
          }
        }
        return best;
      };

      groups.forEach((size, idxInHour) => {
        const court = idxInHour + 1;
        if (size === 2) {
          const pair = pickSingles();
          if (!pair) return;
          const [a, b] = pair;
          used.add(a);
          used.add(b);
          const res: Reservation = {
            date: hr.dateStr,
            timeSlot: hr.slotId,
            court,
            matchType: 'single',
            category: 'wedstrijd',
            players: [a, b],
            notifiedFull: true,
          };
          result.push(res);
          sendMatchFullMessages(res);
          mt[getCourtKey(hr.dateStr, hr.slotId, court)] = 'single';
          cat[getCourtKey(hr.dateStr, hr.slotId, court)] = 'wedstrijd';
        } else {
          const grp = pickDoubles();
          if (!grp) return;
          const { teamA, teamB } = grp;
          const [x1, x2] = teamA,
            [y1, y2] = teamB;
          [x1, x2, y1, y2].forEach((p) => used.add(p));
          const res: Reservation = {
            date: hr.dateStr,
            timeSlot: hr.slotId,
            court,
            matchType: 'double',
            category: 'training',
            players: [x1, x2, y1, y2],
            notifiedFull: true,
          };
          result.push(res);
          sendMatchFullMessages(res);
          mt[getCourtKey(hr.dateStr, hr.slotId, court)] = 'double';
          cat[getCourtKey(hr.dateStr, hr.slotId, court)] = 'training';
        }
      });
    });

    setReservations(result);
    setMatchTypes(mt);
    setCategories(cat);
  };

  const planSelectedWeek = () => {
    if (!isAdmin) return;
    const dateStr = selectedDate;
    setReservations((prev) => prev.filter((r) => r.date !== dateStr));

    const { opponentCount } = buildCounts(dateStr);
    const hours = TIME_SLOTS.map((slot) => ({
      dateStr,
      slotId: slot.id,
    }));
    const result: Reservation[] = [];
    const mt: Record<string, 'single' | 'double'> = {};
    const cat: Record<string, MatchCategory> = {};
    const oppSeen = (a: string, b: string) => opponentCount[pairKey(a, b)] || 0;

    hours.forEach((hr, hourIdx) => {
      const groups = hourIdx % 2 === 0 ? [4, 4, 2] : [4, 2, 2];
      const used = new Set<string>();
      const available = new Set(playersAvailableFor(hr.dateStr, hr.slotId));

      const pickSingles = (): [string, string] | null => {
        const cand = PLAYERS.filter((p) => !used.has(p) && available.has(p));
        if (cand.length < 2) return null;
        const sorted = cand.slice().sort((a, b) => scoreOf(a) - scoreOf(b));
        let best: [string, string] | null = null;
        let bestScore = Infinity;
        for (let i = 0; i < sorted.length - 1; i++) {
          for (let j = i + 1; j < sorted.length; j++) {
            const a = sorted[i],
              b = sorted[j];
            const diff = Math.abs(scoreOf(a) - scoreOf(b));
            const s = diff * 12 + oppSeen(a, b) * 60 + Math.random() * 0.5;
            if (s < bestScore) {
              bestScore = s;
              best = [a, b];
            }
          }
        }
        return best;
      };

      const pickDoubles = () => {
        const cand = PLAYERS.filter((p) => !used.has(p) && available.has(p));
        if (cand.length < 4) return null;
        let best: { teamA: [string, string]; teamB: [string, string] } | null =
          null;
        let bestScore = Infinity;

        for (const [a, b, c, d] of combinations4(cand)) {
          const splits: Array<[[string, string], [string, string]]> = [
            [
              [a, b],
              [c, d],
            ],
            [
              [a, c],
              [b, d],
            ],
            [
              [a, d],
              [b, c],
            ],
          ];
          for (const [t1, t2] of splits) {
            const [x1, x2] = t1,
              [y1, y2] = t2;
            const sumA = scoreOf(x1) + scoreOf(x2);
            const sumB = scoreOf(y1) + scoreOf(y2);
            const sumDiff = Math.abs(sumA - sumB);
            let s = 0;
            s += sumDiff * 15;
            s +=
              oppSeen(x1, y1) +
              oppSeen(x1, y2) +
              oppSeen(x2, y1) +
              oppSeen(x2, y2);
            s += Math.random() * 0.5;
            if (s < bestScore) {
              bestScore = s;
              best = { teamA: [x1, x2], teamB: [y1, y2] };
            }
          }
        }
        return best;
      };

      groups.forEach((size, idxInHour) => {
        const court = idxInHour + 1;
        if (size === 2) {
          const pair = pickSingles();
          if (!pair) return;
          const [a, b] = pair;
          used.add(a);
          used.add(b);
          const res: Reservation = {
            date: hr.dateStr,
            timeSlot: hr.slotId,
            court,
            matchType: 'single',
            category: 'wedstrijd',
            players: [a, b],
            notifiedFull: true,
          };
          result.push(res);
          sendMatchFullMessages(res);
          mt[getCourtKey(hr.dateStr, hr.slotId, court)] = 'single';
          cat[getCourtKey(hr.dateStr, hr.slotId, court)] = 'wedstrijd';
        } else {
          const grp = pickDoubles();
          if (!grp) return;
          const { teamA, teamB } = grp;
          const [x1, x2] = teamA,
            [y1, y2] = teamB;
          [x1, x2, y1, y2].forEach((p) => used.add(p));
          const res: Reservation = {
            date: hr.dateStr,
            timeSlot: hr.slotId,
            court,
            matchType: 'double',
            category: 'training',
            players: [x1, x2, y1, y2],
            notifiedFull: true,
          };
          result.push(res);
          sendMatchFullMessages(res);
          mt[getCourtKey(hr.dateStr, hr.slotId, court)] = 'double';
          cat[getCourtKey(hr.dateStr, hr.slotId, court)] = 'training';
        }
      });
    });

    setReservations((prev) => [...prev, ...result]);
    setMatchTypes((prev) => ({ ...prev, ...mt }));
    setCategories((prev) => ({ ...prev, ...cat }));
  };

  const clearAll = () => {
    if (!isAdmin) return;
    const ok = window.confirm('Alle reservaties wissen?');
    if (!ok) return;
    setReservations([]);
    localStorage.setItem(RESERV_KEY, JSON.stringify([]));
    setMatchTypes({});
    setCategories({});
    localStorage.setItem(MATCHTYPE_KEY, JSON.stringify({}));
    localStorage.setItem(CATEGORY_KEY, JSON.stringify({}));
  };

  /* =========================
     Winner marking (single + double)
  ========================= */
  const markWinner = (res: Reservation, payload: string | [string, string]) => {
    if (!session) return;
    if (!isAdmin && !res.players.includes(myName!)) {
      alert('Alleen admin of deelnemers kunnen de winnaar instellen.');
      return;
    }
    if (res.category !== 'wedstrijd') {
      alert('Winnaar kan enkel bij Wedstrijd worden ingesteld.');
      return;
    }

    if (res.matchType === 'single') {
      if (typeof payload !== 'string') return;
      const winner = payload;
      if (!res.players.includes(winner)) return;
      const loser = res.players.find((p) => p && p !== winner)!;
      setReservations((prev) =>
        prev.map((r) => (r === res ? { ...r, result: { winner, loser } } : r))
      );
      return;
    }

    // double
    if (!Array.isArray(payload) || payload.length !== 2) return;
    const winners = payload as [string, string];
    const [x1, x2, y1, y2] = res.players;
    const teamA: [string, string] = [x1, x2];
    const teamB: [string, string] = [y1, y2];

    const sameSet = (a: [string, string], b: [string, string]) =>
      new Set(a).size === 2 &&
      new Set(b).size === 2 &&
      a.every((m) => b.includes(m));

    let losers: [string, string] | undefined;
    if (sameSet(winners, teamA)) losers = teamB;
    else if (sameSet(winners, teamB)) losers = teamA;
    else {
      alert('Winnaar-team komt niet overeen met een van de teams.');
      return;
    }
    setReservations((prev) =>
      prev.map((r) => (r === res ? { ...r, result: { winners, losers } } : r))
    );
  };

  /* =========================
     Self-join / leave (spelers)
  ========================= */
  const joinCourt = (date: string, timeSlot: string, court: number) => {
    if (!session) return alert('Log in om deel te nemen.');
    const availableSet = new Set(playersAvailableFor(date, timeSlot));
    if (!availableSet.has(myName!)) {
      alert('Je bent niet beschikbaar in dit tijdslot.');
      return;
    }
    const slotPlayers = getPlayersInSlot(date, timeSlot);
    if (slotPlayers.has(myName!)) {
      alert('Je staat al ingepland in dit uur.');
      return;
    }

    const existing = findReservation(date, timeSlot, court);
    const mt = getMatchType(date, timeSlot, court);
    const cat = getCategory(date, timeSlot, court);
    const needed = mt === 'single' ? 2 : 4;

    if (!existing) {
      const arr = Array.from({ length: needed }, () => '');
      arr[0] = myName!;
      const fresh: Reservation = {
        date,
        timeSlot,
        court,
        matchType: mt,
        category: cat,
        players: arr,
        notifiedFull: isReservationFull({
          date,
          timeSlot,
          court,
          matchType: mt,
          category: cat,
          players: arr,
        } as Reservation),
      };
      setReservations((prev) => [...prev, fresh]);
      if (fresh.notifiedFull) sendMatchFullMessages(fresh);
      return;
    }

    if (existing.players.includes(myName!)) {
      alert('Je staat al op dit terrein.');
      return;
    }
    const emptyIdx = existing.players.findIndex((p) => !p);
    if (emptyIdx === -1) {
      alert('Dit terrein is al volledig.');
      return;
    }

    // Bepaal vooraf of we vol worden
    const newPlayers = [...existing.players];
    newPlayers[emptyIdx] = myName!;
    const willBeFull = newPlayers.every((p) => !!p);

    setReservations((prev) =>
      prev.map((r) => {
        if (r !== existing) return r;
        const copy: Reservation = {
          ...r,
          players: newPlayers,
          // markeer enkel wanneer we NU voor het eerst vol worden
          notifiedFull: r.notifiedFull || willBeFull,
        };
        // Resultaat ongeldig zodra samenstelling wijzigde
        if (willBeFull === false) delete copy.result;
        return copy;
      })
    );

    // Stuur meldingen één keer, zonder extra setTimeout
    if (!existing.notifiedFull && willBeFull) {
      const fullRes: Reservation = {
        ...existing,
        players: newPlayers,
        notifiedFull: true,
        matchType: mt,
        category: cat,
      };
      sendMatchFullMessages(fullRes);
    }
  };

  const leaveCourt = (res: Reservation, who: string) => {
    if (!isAdmin && who !== myName) return;
    setReservations((prev) =>
      prev.map((r) => {
        if (r !== res) return r;
        const idx = r.players.findIndex((p) => p === who);
        if (idx === -1) return r;
        const copy: Reservation = { ...r, players: [...r.players] };
        copy.players[idx] = '';
        // Match is niet meer vol -> terug open, reset notifiedFull
        copy.notifiedFull = false;
        // Resultaat ongeldig maken als teams/players wijzigen
        delete copy.result;
        return copy;
      })
    );
  };

  const removeReservation = (date: string, timeSlot: string, court: number) => {
    const res = findReservation(date, timeSlot, court);
    if (!res) return;
    if (!canModifyReservation(res))
      return alert('Je kan enkel je eigen wedstrijden verwijderen (of admin).');
    const ok = window.confirm(
      'Weet je zeker dat je deze reservatie wilt verwijderen?'
    );
    if (!ok) return;
    setReservations((prev) =>
      prev.filter(
        (r) =>
          !(r.date === date && r.timeSlot === timeSlot && r.court === court)
      )
    );
  };

  /* =========================
     Beschikbaarheid
  ========================= */
  const toggleAvailability = (player: string, date: string, slot: string) => {
    setAvailability((prev) => {
      const copy: Availability = JSON.parse(JSON.stringify(prev || {}));
      copy[date] = copy[date] || {};
      copy[date][slot] = copy[date][slot] || {};
      const cur = copy[date][slot][player];
      copy[date][slot][player] = cur === false ? true : false;
      return copy;
    });
  };

  /* =========================
     Winner buttons helper
  ========================= */
  const WinnerButtons = ({ r }: { r: Reservation }) => {
    const mayEdit = canModifyReservation(r);
    if (r.category !== 'wedstrijd' || !mayEdit) return null;

    if (r.matchType === 'single') {
      const winnerSingle = r.result?.winner;
      if (winnerSingle && !isAdmin) return null;
      return (
        <div className="absolute bottom-3 left-3 right-3 flex flex-wrap gap-2 justify-center">
          {r.players.filter(Boolean).map((p) => (
            <button
              key={p}
              onClick={() => markWinner(r, p)}
              className="px-3 py-1.5 rounded-full text-xs bg-white text-black hover:bg-white shadow border border-gray-200"
              title="Markeer winnaar"
            >
              ✅ {p} won
            </button>
          ))}
        </div>
      );
    }

    // double
    const [x1, x2, y1, y2] = r.players;
    const teamA: [string, string] = [x1, x2];
    const teamB: [string, string] = [y1, y2];
    const winnerDoubles = r.result?.winners;
    if (winnerDoubles && !isAdmin) return null;

    return (
      <div className="absolute bottom-3 left-3 right-3 flex flex-col sm:flex-row gap-2 justify-center">
        <button
          onClick={() => markWinner(r, teamA)}
          className="px-3 py-1.5 rounded-full text-xs bg-white text-black hover:bg-white shadow border border-gray-200"
          title="Markeer winnend team"
          disabled={!x1 || !x2}
        >
          ✅ {x1 || '—'} & {x2 || '—'} wonnen
        </button>
        <button
          onClick={() => markWinner(r, teamB)}
          className="px-3 py-1.5 rounded-full text-xs bg-white text-black hover:bg-white shadow border border-gray-200"
          title="Markeer winnend team"
          disabled={!y1 || !y2}
        >
          ✅ {y1 || '—'} & {y2 || '—'} wonnen
        </button>
      </div>
    );
  };

  /* =========================
     Components
  ========================= */
  const ReservationBadge = ({ r }: { r: Reservation }) => (
    <div className="absolute top-1 left-1 flex gap-1">
      <div className="bg-white rounded-full px-2 py-1 text-[10px] font-bold">
        {r.matchType === 'single' ? '👤👤' : '👥👥'}
      </div>
      <div
        className={`rounded-full px-2 py-1 text-[10px] font-semibold ${
          r.category === 'wedstrijd'
            ? 'bg-purple-100 text-purple-700'
            : 'bg-yellow-100 text-yellow-800'
        }`}
        title={r.category}
      >
        {r.category === 'wedstrijd' ? 'Wedstrijd' : 'Training'}
      </div>
      {/* Result-badge */}
      {r.matchType === 'single' && r.result?.winner && (
        <div className="rounded-full px-2 py-1 text-[10px] font-semibold bg-green-100 text-green-700">
          ✅ {r.result.winner}
        </div>
      )}
      {r.matchType === 'double' && r.result?.winners && (
        <div className="rounded-full px-2 py-1 text-[10px] font-semibold bg-green-100 text-green-700">
          ✅ {r.result.winners.join(' & ')}
        </div>
      )}
    </div>
  );

  const TennisCourt = ({
    date,
    timeSlot,
    court,
  }: {
    date: string;
    timeSlot: string;
    court: number;
  }) => {
    const reservation = findReservation(date, timeSlot, court);
    const matchType = getMatchType(date, timeSlot, court);
    const category = getCategory(date, timeSlot, court);

    // Kaart met bestaande reservatie
    if (reservation) {
      const mayEdit = canModifyReservation(reservation);
      const winnerSingle = reservation.result?.winner;
      const winnerDoubles = reservation.result?.winners;
      const isWin = (p: string) =>
        Array.isArray(winnerDoubles) && winnerDoubles.includes(p);
      const iAmIn = !!myName && reservation.players.includes(myName);
      const availableSet = new Set(playersAvailableFor(date, timeSlot));
      const canJoin =
        !!myName &&
        !iAmIn &&
        availableSet.has(myName) &&
        !getPlayersInSlot(date, timeSlot).has(myName) &&
        reservation.players.some((p) => !p); // er is nog plek

      return (
        <div className={courtClass}>
          <ReservationBadge r={reservation} />

          {reservation.matchType === 'single' ? (
            <>
              <div className="bg-blue-600 text-white text-center py-3 rounded border-2 border-white text-base font-semibold">
                <div className="flex items-center justify-center">
                  <PlayerChip
                    name={reservation.players[0] || '—'}
                    size="md"
                    highlight={
                      !!reservation.players[0] &&
                      winnerSingle === reservation.players[0]
                    }
                  />
                </div>
              </div>
              <TennisNet />
              <div className="bg-blue-600 text-white text-center py-3 rounded border-2 border-white text-base font-semibold">
                <div className="flex items-center justify-center">
                  <PlayerChip
                    name={reservation.players[1] || '—'}
                    size="md"
                    highlight={
                      !!reservation.players[1] &&
                      winnerSingle === reservation.players[1]
                    }
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1">
                <div className="bg-blue-600 text-white text-center py-2 rounded border-2 border-white text-sm font-semibold">
                  <div className="flex items-center justify-center">
                    <PlayerChip
                      name={reservation.players[0] || '—'}
                      size="sm"
                      highlight={isWin(reservation.players[0])}
                    />
                  </div>
                </div>
                <div className="bg-blue-600 text-white text-center py-2 rounded border-2 border-white text-sm font-semibold">
                  <div className="flex items-center justify-center">
                    <PlayerChip
                      name={reservation.players[1] || '—'}
                      size="sm"
                      highlight={isWin(reservation.players[1])}
                    />
                  </div>
                </div>
              </div>
              <TennisNet />
              <div className="space-y-1">
                <div className="bg-blue-600 text-white text-center py-2 rounded border-2 border-white text-sm font-semibold">
                  <div className="flex items-center justify-center">
                    <PlayerChip
                      name={reservation.players[2] || '—'}
                      size="sm"
                      highlight={isWin(reservation.players[2])}
                    />
                  </div>
                </div>
                <div className="bg-blue-600 text-white text-center py-2 rounded border-2 border-white text-sm font-semibold">
                  <div className="flex items-center justify-center">
                    <PlayerChip
                      name={reservation.players[3] || '—'}
                      size="sm"
                      highlight={isWin(reservation.players[3])}
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Actieknoppen */}
          <div className="absolute top-1 right-1 flex gap-1">
            {iAmIn && (
              <button
                onClick={() => leaveCourt(reservation, myName!)}
                className="bg-white text-gray-800 rounded-full px-2 py-1 text-[10px] border border-gray-200"
                title="Ik kan toch niet"
              >
                Ik kan toch niet
              </button>
            )}
            {canJoin && (
              <button
                onClick={() => joinCourt(date, timeSlot, court)}
                className="bg-white text-gray-800 rounded-full px-2 py-1 text-[10px] border border-gray-200"
                title="Ik speel mee"
              >
                Ik speel mee
              </button>
            )}
            {mayEdit && (
              <button
                onClick={() => removeReservation(date, timeSlot, court)}
                className="bg-red-500 text-white rounded-full w-6 h-6 text-xs hover:bg-red-600"
                title="Verwijder reservatie"
              >
                ×
              </button>
            )}
          </div>

          <WinnerButtons r={reservation} />
        </div>
      );
    }

    // Kaart zonder reservatie: controls bovenaan
    const availableSet = new Set(playersAvailableFor(date, timeSlot));
    const canFirstJoin =
      !!myName &&
      availableSet.has(myName) &&
      !getPlayersInSlot(date, timeSlot).has(myName);

    return (
      <div className={courtClass}>
        <div className="flex justify-center gap-2 mb-2">
          <button
            onClick={() => setMatchTypeFor(date, timeSlot, court, 'single')}
            className={`px-3 py-1 rounded text-sm font-bold ${
              matchType === 'single'
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-800'
            }`}
          >
            👤👤
          </button>
          <button
            onClick={() => setMatchTypeFor(date, timeSlot, court, 'double')}
            className={`px-3 py-1 rounded text-sm font-bold ${
              matchType === 'double'
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-800'
            }`}
          >
            👥👥
          </button>
          <select
            // *** Zichtbaar op mobiel: altijd donkere tekst op witte achtergrond
            className="px-2 py-1 rounded text-sm bg-white text-gray-900 border border-gray-300"
            value={getCategory(date, timeSlot, court)}
            onChange={(e) =>
              setCategoryFor(
                date,
                timeSlot,
                court,
                e.target.value as MatchCategory
              )
            }
            title="Type"
          >
            <option value="training">Training</option>
            <option value="wedstrijd">Wedstrijd</option>
          </select>
        </div>

        <div className="flex-1 grid place-items-center text-white/90 text-sm">
          Nog geen spelers
        </div>

        <div className="pt-2">
          <button
            onClick={() => joinCourt(date, timeSlot, court)}
            disabled={!canFirstJoin}
            className="w-full bg-white text-gray-800 py-2 px-3 rounded text-sm border border-gray-200 disabled:opacity-50"
            title={
              canFirstJoin
                ? 'Plaats jezelf op dit terrein'
                : 'Niet beschikbaar of al ingepland'
            }
          >
            Ik speel mee
          </button>
        </div>
      </div>
    );
  };

  /* =========================
     Mijn beschikbaarheid
  ========================= */
  const MyAvailability = ({ playerName }: { playerName: string }) => {
    return (
      <div className="bg-white rounded-xl shadow p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-800">Mijn beschikbaarheid</h3>
          <span className="text-xs text-gray-500">
            Ok = beschikbaar, niet = niet beschikbaar
          </span>
        </div>

        <div className="md:hidden mb-2 flex flex-wrap gap-2">
          {TIME_SLOTS.map((s) => (
            <span
              key={s.id}
              className="px-2 py-1 rounded-full text-[11px] bg-gray-100 text-gray-700 border border-gray-200"
            >
              {s.label}
            </span>
          ))}
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-xs table-fixed">
            <thead className="sticky top-0 bg-white z-10">
              <tr>
                <th className="text-left py-2 pr-3 w-36 text-black">Datum</th>
                {TIME_SLOTS.map((s) => (
                  <th
                    key={s.id}
                    className="text-left py-2 pr-3 w-36 text-black"
                  >
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sundays.map((d) => {
                const dateStr = format(d, 'yyyy-MM-dd');
                return (
                  <tr key={dateStr} className="border-t">
                    <td className="py-1 pr-3 text-gray-900 whitespace-nowrap">
                      {format(d, 'eee dd/MM', { locale: nl })}
                    </td>
                    {TIME_SLOTS.map((s) => {
                      const disallowed =
                        availability?.[dateStr]?.[s.id]?.[playerName] === false;
                      return (
                        <td
                          key={`${dateStr}-${s.id}`}
                          className="py-1 pr-3 align-top"
                        >
                          <div className="md:hidden text-[10px] text-black-500 mb-0.5">
                            {s.label}
                          </div>
                          <button
                            onClick={() =>
                              toggleAvailability(playerName, dateStr, s.id)
                            }
                            className={`px-2 py-1 rounded border ${
                              disallowed
                                ? 'bg-red-50 border-red-200 text-red-700'
                                : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                            }`}
                          >
                            {disallowed ? 'Niet' : 'Ok'}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  /* =========================
     Ladders (met medailles)
  ========================= */
  const medalFor = (rank: number) =>
    rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : '';

  const LadderEnkel = () => {
    const stats = useMemo(() => {
      const s: Record<string, { wins: number; matches: number }> = {};
      PLAYERS.forEach((p) => (s[p] = { wins: 0, matches: 0 }));
      reservations.forEach((r) => {
        if (r.category !== 'wedstrijd' || r.matchType !== 'single' || !r.result)
          return;
        const { winner, loser } = r.result;
        if (!winner || !loser) return;
        if (!s[winner] || !s[loser]) return;
        s[winner].wins++;
        s[winner].matches++;
        s[loser].matches++;
      });
      return s;
    }, [reservations]);

    const sorted = PLAYERS.slice().sort((a, b) => {
      const A = stats[a],
        B = stats[b];
      if (B.wins !== A.wins) return B.wins - A.wins;
      if (B.matches !== A.matches) return B.matches - A.matches;
      return a.localeCompare(b);
    });

    return (
      <div className="bg-white rounded-xl shadow-lg p-6">
        <h2 className="text-2xl font-bold text-gray-800 mb-2">
          🏆 Ladder enkel
        </h2>
        <p className="text-sm text-gray-600 mb-6">
          Telt enkel <b>Wedstrijden (single)</b> met geregistreerde winnaar.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead>
              <tr className="border-b">
                <th className="text-left py-3 px-4">Positie</th>
                <th className="text-left py-3 px-4">Speler</th>
                <th className="text-left py-3 px-4">Gespeeld</th>
                <th className="text-left py-3 px-4">Gewonnen</th>
                <th className="text-left py-3 px-4">Win %</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((player, i) => {
                const s = stats[player];
                const pct = s.matches
                  ? Math.round((s.wins / s.matches) * 100)
                  : 0;
                return (
                  <tr key={player} className="border-b hover:bg-gray-50">
                    <td className="py-3 px-4 font-bold text-gray-600">
                      #{i + 1}
                    </td>
                    <td className="py-3 px-4 flex items-center gap-2">
                      <span className="text-lg leading-none">
                        {medalFor(i)}
                      </span>
                      <PlayerChip name={player} size="md" />
                    </td>
                    <td className="py-3 px-4">{s.matches}</td>
                    <td className="py-3 px-4 text-green-600 font-semibold">
                      {s.wins}
                    </td>
                    <td className="py-3 px-4 font-semibold">{pct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const LadderDubbel = () => {
    const stats = useMemo(() => {
      const s: Record<string, { wins: number; matches: number }> = {};
      PLAYERS.forEach((p) => (s[p] = { wins: 0, matches: 0 }));
      reservations.forEach((r) => {
        if (r.matchType !== 'double' || r.category !== 'wedstrijd') return;
        r.players.filter(Boolean).forEach((p) => {
          if (s[p]) s[p].matches++;
        });
        if (r.result?.winners && r.result.winners.length === 2) {
          const [w1, w2] = r.result.winners;
          if (s[w1]) s[w1].wins++;
          if (s[w2]) s[w2].wins++;
        }
      });
      return s;
    }, [reservations]);

    const sorted = PLAYERS.slice().sort((a, b) => {
      const A = stats[a],
        B = stats[b];
      if (B.wins !== A.wins) return B.wins - A.wins;
      if (B.matches !== A.matches) return B.matches - A.matches;
      return a.localeCompare(b);
    });

    return (
      <div className="bg-white rounded-xl shadow-lg p-6">
        <h2 className="text-2xl font-bold text-gray-800 mb-2">
          👥 Ladder dubbel
        </h2>
        <p className="text-sm text-gray-600 mb-6">
          Telt enkel <b>Wedstrijden (double)</b> met geregistreerd winnend team.
          Beide winnaars krijgen 1 win.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead>
              <tr className="border-b">
                <th className="text-left py-3 px-4">Positie</th>
                <th className="text-left py-3 px-4">Speler</th>
                <th className="text-left py-3 px-4">Gespeeld</th>
                <th className="text-left py-3 px-4">Gewonnen</th>
                <th className="text-left py-3 px-4">Win %</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((player, i) => {
                const s = stats[player];
                const pct = s.matches
                  ? Math.round((s.wins / s.matches) * 100)
                  : 0;
                return (
                  <tr key={player} className="border-b hover:bg-gray-50">
                    <td className="py-3 px-4 font-bold text-gray-600">
                      #{i + 1}
                    </td>
                    <td className="py-3 px-4 flex items-center gap-2">
                      <span className="text-lg leading-none">
                        {medalFor(i)}
                      </span>
                      <PlayerChip name={player} size="md" />
                    </td>
                    <td className="py-3 px-4">{s.matches}</td>
                    <td className="py-3 px-4 text-green-600 font-semibold">
                      {s.wins}
                    </td>
                    <td className="py-3 px-4 font-semibold">{pct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  /* =========================
     Notifications UI (mobiel + desktop varianten)
  ========================= */
  const [notifOpen, setNotifOpen] = useState(false);
  const NotificationsPanel = () => {
    if (!myName) return null;
    const mine = messages
      .filter((m) => m.to === myName)
      .sort((a, b) => b.createdAt - a.createdAt);

    const unreadCount = mine.filter((m) => !m.read).length;

    const markAllRead = () => {
      setMessages((prev) =>
        prev.map((m) => (m.to === myName ? { ...m, read: true } : m))
      );
    };

    const clearAllMine = () => {
      const ok = window.confirm('Alle meldingen voor jou wissen?');
      if (!ok) return;
      setMessages((prev) => prev.filter((m) => m.to !== myName));
    };

    return (
      <div className="relative">
        <button
          onClick={() => {
            setNotifOpen((v) => !v);
            if (!notifOpen) markAllRead();
          }}
          className="relative bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900"
          title="Meldingen"
        >
          🔔 Meldingen
          {unreadCount > 0 && (
            <span className="ml-2 inline-flex items-center justify-center min-w-5 h-5 text-xs rounded-full bg-red-600 text-white px-1">
              {unreadCount}
            </span>
          )}
        </button>

        {/* Desktop popover */}
        {notifOpen && (
          <div className="hidden md:block">
            <div className="absolute right-0 mt-2 w-[24rem] max-w-[95vw] bg-white rounded-xl shadow-xl border border-gray-200 z-[60]">
              <div className="p-3 border-b flex items-center gap-2 justify-between">
                <div className="font-semibold text-gray-800">Meldingen</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={markAllRead}
                    className="text-xs px-2 py-1 bg-gray-100 rounded border border-gray-200 text-gray-700"
                    title="Markeer alles als gelezen"
                  >
                    Alles gelezen
                  </button>
                  <button
                    onClick={clearAllMine}
                    className="text-xs px-2 py-1 bg-red-50 rounded border border-red-200 text-red-700"
                    title="Wis alle meldingen"
                  >
                    Wis alles
                  </button>
                  <button
                    onClick={() => setNotifOpen(false)}
                    className="text-gray-500 hover:text-gray-800"
                    title="Sluiten"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="max-h-96 overflow-y-auto p-3">
                {mine.length === 0 ? (
                  <p className="text-sm text-gray-500">Geen meldingen.</p>
                ) : (
                  <ul className="space-y-2">
                    {mine.map((m) => (
                      <li
                        key={m.id}
                        className="p-2 bg-white border rounded text-sm text-gray-800 break-words"
                      >
                        {m.text}
                        <div className="mt-1 text-[10px] text-gray-500">
                          {new Date(m.createdAt).toLocaleString()}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Mobiel bottom sheet */}
        {notifOpen && (
          <div className="md:hidden">
            {/* semi-transparante achtergrond */}
            <div
              className="fixed inset-0 bg-black/40 z-[80]"
              onClick={() => setNotifOpen(false)}
            />
            <div className="fixed left-0 right-0 bottom-0 z-[90] bg-white rounded-t-2xl shadow-2xl border border-gray-200 max-h-[75vh]">
              <div className="p-3 border-b flex items-center justify-between gap-2">
                <div className="font-semibold text-gray-800">Meldingen</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={markAllRead}
                    className="text-xs px-2 py-1 bg-gray-100 rounded border border-gray-200 text-gray-700"
                    title="Markeer alles als gelezen"
                  >
                    Alles gelezen
                  </button>
                  <button
                    onClick={clearAllMine}
                    className="text-xs px-2 py-1 bg-red-50 rounded border border-red-200 text-red-700"
                    title="Wis alle meldingen"
                  >
                    Wis alles
                  </button>
                  <button
                    onClick={() => setNotifOpen(false)}
                    className="text-gray-500 hover:text-gray-800"
                    title="Sluiten"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div
                className="p-3 overflow-y-auto"
                style={{ maxHeight: '60vh' }}
              >
                {mine.length === 0 ? (
                  <p className="text-sm text-gray-500">Geen meldingen.</p>
                ) : (
                  <ul className="space-y-2">
                    {mine.map((m) => (
                      <li
                        key={m.id}
                        className="p-2 bg-white border rounded text-sm text-gray-800 break-words"
                      >
                        {m.text}
                        <div className="mt-1 text-[10px] text-gray-500">
                          {new Date(m.createdAt).toLocaleString()}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  /* =========================
     Navigation helpers
  ========================= */
  const selectedSunday = sundays.find(
    (d) => format(d, 'yyyy-MM-dd') === selectedDate
  );
  const selectedIndex = sundays.findIndex(
    (d) => format(d, 'yyyy-MM-dd') === selectedDate
  );
  const gotoPrev = () => {
    if (selectedIndex > 0)
      setSelectedDate(format(sundays[selectedIndex - 1], 'yyyy-MM-dd'));
  };
  const gotoNext = () => {
    if (selectedIndex < sundays.length - 1)
      setSelectedDate(format(sundays[selectedIndex + 1], 'yyyy-MM-dd'));
  };

  /* =========================
     Login screen
  ========================= */
  if (!session) {
    return (
      <div className="min-h-screen bg-gray-100 p-4 grid place-items-center">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6">
          <h1 className="text-2xl font-bold text-green-800 text-center mb-1">
            🎾 Zondagavondtennis
          </h1>
          <p className="text-center text-gray-600 mb-6">
            Log in om te reserveren
          </p>

          {loginErr && (
            <div className="mb-3 text-sm text-red-600">{loginErr}</div>
          )}

          <div className="mb-3">
            <label className="block text-sm text-gray-700 mb-1">Speler</label>
            <select
              className={selectClass}
              value={loginName}
              onChange={(e) => {
                setLoginName(e.target.value);
                setLoginPass('');
                setLoginErr(null);
              }}
            >
              {PLAYERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-4">
            <label className="block text-sm text-gray-700 mb-1">
              Wachtwoord
            </label>
            <input
              type="password"
              className={inputClass}
              placeholder="••••••••"
              value={loginPass}
              onChange={(e) => setLoginPass(e.target.value)}
            />
          </div>

          <button
            onClick={doLogin}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded"
          >
            Inloggen
          </button>
        </div>
      </div>
    );
  }

  /* =========================
     Main render
  ========================= */
  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3 mb-6">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-green-800">
              🎾 Zondagavondtennis
            </h1>
            <p className="text-gray-700 text-base md:text-lg font-medium">
              Dag <span className="font-bold">{myName}</span>, reserveer je
              terrein!
            </p>
          </div>

          <div className="flex items-center flex-wrap gap-2">
            <NotificationsPanel />
            {isAdmin && (
              <>
                <button
                  onClick={planAllBalanced}
                  className="bg-green-600 hover:bg-green-700 text-white px-3 py-2 rounded text-sm"
                >
                  Plan alle wedstrijden
                </button>
                <button
                  onClick={planSelectedWeek}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded text-sm"
                >
                  Herplan geselecteerde week
                </button>
                <button
                  onClick={clearAll}
                  className="bg-red-600 hover:bg-red-700 text-white px-3 py-2 rounded text-sm"
                >
                  Wis alle reservaties
                </button>
              </>
            )}
            <button
              onClick={logout}
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded text-sm"
            >
              Uitloggen
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-6">
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex gap-4 overflow-x-auto">
              <button
                onClick={() => setActiveTab('reservatie')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'reservatie'
                    ? 'border-green-500 text-green-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                🗓️ Reservatie
              </button>
              <button
                onClick={() => setActiveTab('beschikbaarheid')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'beschikbaarheid'
                    ? 'border-green-500 text-green-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                📅 Mijn beschikbaarheid
              </button>
              <button
                onClick={() => setActiveTab('ladderEnkel')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'ladderEnkel'
                    ? 'border-green-500 text-green-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                🏆 Ladder enkel
              </button>
              <button
                onClick={() => setActiveTab('ladderDubbel')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'ladderDubbel'
                    ? 'border-green-500 text-green-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                👥 Ladder dubbel
              </button>
            </nav>
          </div>
        </div>

        {/* Tab: Reservatie */}
        {activeTab === 'reservatie' && (
          <>
            {/* Date navigation */}
            <div className="my-6 flex items-center justify-center gap-2">
              <button
                onClick={gotoPrev}
                disabled={selectedIndex <= 0}
                className="bg-purple-600 hover:bg-purple-700 text-white px-3 py-2 rounded disabled:opacity-50"
              >
                ← Vorige
              </button>
              <select
                className={`${selectClass} min-w-64`}
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
              >
                {sundays.map((d) => {
                  const v = format(d, 'yyyy-MM-dd');
                  const lab = format(d, 'eeee dd/MM/yyyy', { locale: nl });
                  return (
                    <option key={v} value={v}>
                      {lab}
                    </option>
                  );
                })}
              </select>
              <button
                onClick={gotoNext}
                disabled={selectedIndex >= sundays.length - 1}
                className="bg-purple-600 hover:bg-purple-700 text-white px-3 py-2 rounded disabled:opacity-50"
              >
                Volgende →
              </button>
            </div>

            {/* Geselecteerde speeldag */}
            {selectedSunday &&
              (() => {
                const dateStr = format(selectedSunday, 'yyyy-MM-dd');
                const displayDate = format(selectedSunday, 'dd/MM/yyyy', {
                  locale: nl,
                });
                const weekIndex = sundays.findIndex(
                  (d) => format(d, 'yyyy-MM-dd') === dateStr
                );

                return (
                  <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
                    <div className="flex justify-between items-center mb-6">
                      <h2 className="text-2xl font-bold text-gray-800">
                        Week {weekIndex + 1}
                      </h2>
                      <div className="text-2xl font-bold text-gray-800">
                        {displayDate}
                      </div>
                    </div>

                    {TIME_SLOTS.map((slot) => (
                      <div key={slot.id} className="mb-8">
                        <h3 className="text-xl font-semibold text-gray-700 mb-4">
                          {slot.label}
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {[1, 2, 3].map((court) => (
                            <div key={court} className="text-center">
                              <div className="text-sm font-medium text-gray-600 mb-2">
                                Terrein {court}
                              </div>
                              <TennisCourt
                                date={dateStr}
                                timeSlot={slot.id}
                                court={court}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
          </>
        )}

        {/* Tab: Beschikbaarheid */}
        {activeTab === 'beschikbaarheid' && (
          <MyAvailability playerName={myName!} />
        )}

        {/* Tab: Ladders */}
        {activeTab === 'ladderEnkel' && <LadderEnkel />}
        {activeTab === 'ladderDubbel' && <LadderDubbel />}

        {/* Footer */}
        <div className="mt-6 text-center text-sm text-gray-500">
          <p>💡 Tip: Je data worden lokaal opgeslagen in je browser.</p>
          <p>📱 Deze pagina is geoptimaliseerd voor smartphone.</p>
        </div>
        <br />
        <div className="mt-1 text-center text-xs text-gray-500">
          <p>© 2025 Mattias Van der Stuyft. Alle rechten voorbehouden.</p>
        </div>
      </div>
    </div>
  );
}
