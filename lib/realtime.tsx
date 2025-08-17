'use client';

// 📄 Complete, werkende page met Firestore realtime sync
// Vereist: lib/firebase.ts (zoals eerder gedeeld) + .env.local met NEXT_PUBLIC_FIREBASE_*

import { useEffect, useMemo, useState } from 'react';
import { addWeeks, format } from 'date-fns';
import { nl } from 'date-fns/locale';

// 🔥 Firebase
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db, ensureAuth } from '@/lib/firebase';

/* =========================
   Types
========================= */
type MatchCategory = 'training' | 'wedstrijd';

type MatchType = 'single' | 'double';

interface Reservation {
  date: string; // yyyy-MM-dd
  timeSlot: string; // '18u30-19u30'
  court: number; // 1..3
  matchType: MatchType;
  category: MatchCategory; // training | wedstrijd
  players: string[]; // single: [a,b], double: [x1,x2,y1,y2]
  result?: { winner: string; loser: string } | null; // uitslag (alleen single + wedstrijd)
}

type Availability = Record<string, Record<string, Record<string, boolean>>>;

interface UserSession {
  playerName: string;
}

/* =========================
   Consts
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

const TIME_SLOTS = [
  { id: '18u30-19u30', label: '18u30-19u30' },
  { id: '19u30-20u30', label: '19u30-20u30' },
] as const;

const ADMIN_NAME = 'Mattias';
const ADMIN_PASSWORD = 'ZAT2025*';

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
   Storage keys (optioneel, voor UX/offline)
========================= */
const RESERV_KEY = 'zat-reservations';
const AVAIL_KEY = 'zat-availability';
const MATCHTYPE_KEY = 'zat-court-matchtype';
const CATEGORY_KEY = 'zat-court-category';
const SELECTED_DATE_KEY = 'zat-selected-date';
const SESSION_KEY = 'zat-session';
const ACTIVE_TAB_KEY = 'zat-active-tab';

/* =========================
   UI bits
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

const TennisNet = () => (
  <div className="relative w-full h-8 my-1" aria-hidden>
    <div className="absolute top-0 left-0 right-0 h-1 bg-white rounded-sm" />
    <div
      className="absolute left-0 right-0 bottom-0"
      style={{
        top: '0.5rem',
        backgroundSize: '6px 6px',
        backgroundImage:
          'linear-gradient(to right, rgba(255,255,255,0.45) 1px, transparent 1px),' +
          'linear-gradient(to bottom, rgba(255,255,255,0.45) 1px, transparent 1px)',
      }}
    />
    <div className="absolute left-0 right-0" style={{ top: '0.5rem' }}>
      <div className="border-t border-white/40" />
    </div>
  </div>
);

/* =========================
   Page
========================= */
export default function Page() {
  /* --- Dates --- */
  const startDate = new Date(2025, 8, 28); // 28 sept 2025 (maand 0-based)
  const sundays = useMemo(
    () => Array.from({ length: 20 }, (_, i) => addWeeks(startDate, i)),
    []
  );
  const [selectedDate, setSelectedDate] = useState<string>(
    format(sundays[0], 'yyyy-MM-dd')
  );

  // Firestore-queries beperken tot seizoen
  const seasonStartStr = format(sundays[0], 'yyyy-MM-dd');
  const seasonEndStr = format(sundays[sundays.length - 1], 'yyyy-MM-dd');

  /* --- Session --- */
  const [session, setSession] = useState<UserSession | null>(null);
  const myName = session?.playerName ?? null;
  const isAdmin = myName === ADMIN_NAME;

  /* --- Core state --- */
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [availability, setAvailability] = useState<Availability>({});
  const [matchTypes, setMatchTypes] = useState<Record<string, MatchType>>({});
  const [categories, setCategories] = useState<Record<string, MatchCategory>>(
    {}
  );
  const [selectedPlayers, setSelectedPlayers] = useState<
    Record<string, string[]>
  >({});

  /* --- Tabs --- */
  type TabKey = 'reservatie' | 'beschikbaarheid' | 'ladder';
  const [activeTab, setActiveTab] = useState<TabKey>('reservatie');

  /* --- UI helpers --- */
  const selectClass =
    'w-full p-2 border border-gray-300 rounded text-sm font-medium focus:ring-1 focus:ring-blue-500 bg-white text-gray-900 placeholder-gray-400';
  const inputClass =
    'w-full border border-gray-300 rounded px-3 py-2 bg-white text-gray-900 placeholder-gray-400';

  const courtClass =
    'relative bg-green-600 rounded-xl p-5 h-80 md:h-96 pb-14 flex flex-col justify-between border-4 border-green-700';

  /* --- Load persisted (lokaal) --- */
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
      if (tab && ['reservatie', 'beschikbaarheid', 'ladder'].includes(tab)) {
        setActiveTab(tab);
      }
    } catch {}
  }, []);

  /* --- Persist (lokaal) --- */
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

  /* --- Cross-tab sync (browser) --- */
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
          if (['reservatie', 'beschikbaarheid', 'ladder'].includes(t)) {
            setActiveTab(t);
          }
        }
      } catch {}
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /* --- 🔥 Firestore realtime listeners (bron van waarheid) --- */
  useEffect(() => {
    let unsubRes: (() => void) | undefined;
    let unsubAv: (() => void) | undefined;

    (async () => {
      await ensureAuth();

      // RESERVATIONS van dit seizoen
      const qRes = query(
        collection(db, 'reservations'),
        where('date', '>=', seasonStartStr),
        where('date', '<=', seasonEndStr)
      );
      unsubRes = onSnapshot(qRes, (snap) => {
        const next: Reservation[] = [];
        snap.forEach((d) => {
          const r = d.data() as any;
          next.push({
            date: r.date,
            timeSlot: r.timeSlot ?? r.time_slot,
            court: r.court,
            matchType: (r.matchType ?? r.match_type) as MatchType,
            category: r.category as MatchCategory,
            players: r.players,
            result: r.result ?? null,
          });
        });
        setReservations(next);
      });

      // AVAILABILITY van dit seizoen
      const qAv = query(
        collection(db, 'availability'),
        where('date', '>=', seasonStartStr),
        where('date', '<=', seasonEndStr)
      );
      unsubAv = onSnapshot(qAv, (snap) => {
        const av: Availability = {};
        snap.forEach((d) => {
          const r = d.data() as any;
          const date = r.date as string;
          const slot = (r.timeSlot ?? r.time_slot) as string;
          const player = r.player as string;
          const available = !!r.available;
          av[date] = av[date] || {};
          av[date][slot] = av[date][slot] || {};
          av[date][slot][player] = available;
        });
        setAvailability(av);
      });
    })();

    return () => {
      unsubRes?.();
      unsubAv?.();
    };
  }, [seasonStartStr, seasonEndStr]);

  /* --- Helpers --- */
  const getCourtKey = (date: string, timeSlot: string, court: number) =>
    `${date}-${timeSlot}-${court}`;

  // 👇 Lees bij voorkeur matchType/category uit bestaande reservatie;
  // zo voorkom je drift tussen UI-helperstate en Firestore-records.
  const getMatchType = (date: string, timeSlot: string, court: number): MatchType => {
    const res = reservations.find(
      (r) => r.date === date && r.timeSlot === timeSlot && r.court === court
    );
    if (res) return res.matchType;
    return matchTypes[getCourtKey(date, timeSlot, court)] || 'single';
  };

  const getCategory = (date: string, timeSlot: string, court: number): MatchCategory => {
    const res = reservations.find(
      (r) => r.date === date && r.timeSlot === timeSlot && r.court === court
    );
    if (res) return res.category;
    return categories[getCourtKey(date, timeSlot, court)] || 'training';
  };

  const canModifyReservation = (r: Reservation) =>
    isAdmin || (!!myName && r.players.includes(myName));

  const setMatchTypeFor = (
    date: string,
    timeSlot: string,
    court: number,
    type: MatchType
  ) => {
    const key = getCourtKey(date, timeSlot, court);
    setMatchTypes((prev) => ({ ...prev, [key]: type }));
    setSelectedPlayers((prev) => ({ ...prev, [key]: [] }));
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
        r.players.forEach((p) => set.add(p));
    });
    return set;
  };

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

  /* --- Login --- */
  const [loginName, setLoginName] = useState(PLAYERS[0]);
  const [loginPass, setLoginPass] = useState('');
  const [loginErr, setLoginErr] = useState<string | null>(null);

  const doLogin = () => {
    setLoginErr(null);
    if (loginName === ADMIN_NAME) {
      if (loginPass !== ADMIN_PASSWORD) {
        setLoginErr('Onjuist wachtwoord.');
        return;
      }
    }
    setSession({ playerName: loginName });
  };

  const logout = () => {
    setSession(null);
  };

  /* --- Reservaties --- */
  const handlePlayerSelect = (
    date: string,
    timeSlot: string,
    court: number,
    idx: number,
    player: string
  ) => {
    const key = getCourtKey(date, timeSlot, court);
    const maxPlayers = getMatchType(date, timeSlot, court) === 'single' ? 2 : 4;
    setSelectedPlayers((prev) => {
      const arr = [...(prev[key] || [])];
      while (arr.length < maxPlayers) arr.push('');
      arr[idx] = player;
      return { ...prev, [key]: arr };
    });
  };

  const handleReservation = async (
    date: string,
    timeSlot: string,
    court: number
  ) => {
    if (!session) return alert('Log in om te reserveren.');
    const key = getCourtKey(date, timeSlot, court);
    const playersData = (selectedPlayers[key] || []).filter(Boolean);
    const matchType = getMatchType(date, timeSlot, court);
    const category = getCategory(date, timeSlot, court);
    const requiredPlayers = matchType === 'single' ? 2 : 4;

    if (playersData.length !== requiredPlayers) {
      alert(`Selecteer alle ${requiredPlayers} spelers voor dit terrein`);
      return;
    }

    // Alleen spelers die beschikbaar zijn
    const allowed = new Set(playersAvailableFor(date, timeSlot));
    if (playersData.some((p) => !allowed.has(p))) {
      alert('Een of meer spelers zijn niet beschikbaar in dit tijdslot.');
      return;
    }

    // Spelers mogen maar één keer per slot
    const slotPlayers = getPlayersInSlot(date, timeSlot);
    if (playersData.some((p) => slotPlayers.has(p)))
      return alert('Een van de gekozen spelers is al ingepland in dit uur.');

    // 🔥 Schrijf naar Firestore (upsert)
    await ensureAuth();
    const docId = `${date}_${timeSlot}_${court}`;
    await setDoc(
      doc(db, 'reservations', docId),
      {
        date,
        timeSlot,
        court,
        matchType,
        category,
        players: playersData,
        result: null,
      } as Reservation,
      { merge: true }
    );

    setSelectedPlayers((prev) => ({ ...prev, [key]: [] }));
  };

  const removeReservation = async (
    date: string,
    timeSlot: string,
    court: number
  ) => {
    const res = reservations.find(
      (r) => r.date === date && r.timeSlot === timeSlot && r.court === court
    );
    if (!res) return;
    if (!canModifyReservation(res))
      return alert('Je kan enkel je eigen wedstrijden verwijderen (of admin).');
    const ok = window.confirm(
      'Weet je zeker dat je deze reservatie wilt verwijderen?'
    );
    if (!ok) return;

    await ensureAuth();
    const docId = `${date}_${timeSlot}_${court}`;
    await deleteDoc(doc(db, 'reservations', docId));
  };

  const markWinner = async (res: Reservation, winner: string) => {
    if (!session) return;
    // Voor veiligheid: enkel admin of deelnemer
    if (!isAdmin && !res.players.includes(myName!)) {
      alert('Alleen admin of deelnemers kunnen de winnaar instellen.');
      return;
    }
    if (res.category !== 'wedstrijd' || res.matchType !== 'single') {
      alert('Winnaar kan enkel bij wedstrijden (single) worden ingesteld.');
      return;
    }
    const loser = res.players.find((p) => p !== winner)!;

    await ensureAuth();
    const docId = `${res.date}_${res.timeSlot}_${res.court}`;
    await updateDoc(doc(db, 'reservations', docId), {
      result: { winner, loser },
    });
  };

  /* --- Beschikbaarheid --- */
  const toggleAvailability = async (
    player: string,
    date: string,
    slot: string
  ) => {
    const cur = availability?.[date]?.[slot]?.[player];

    await ensureAuth();
    const docId = `${date}_${slot}_${player}`;
    await setDoc(
      doc(db, 'availability', docId),
      { date, timeSlot: slot, player, available: cur === false ? true : false },
      { merge: true }
    );
  };

  /* --- Planner (admin) --- */
  const buildCounts = (excludingDate?: string) => {
    const opponentCount: Record<string, number> = {};
    reservations.forEach((r) => {
      if (excludingDate && r.date === excludingDate) return;
      if (r.matchType === 'single') {
        const [a, b] = r.players;
        opponentCount[pairKey(a, b)] = (opponentCount[pairKey(a, b)] || 0) + 1;
      } else {
        const [x1, x2, y1, y2] = r.players;
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

  const planAllBalanced = async () => {
    if (!isAdmin) return;
    const { opponentCount } = buildCounts();
    const result: Reservation[] = [];

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
          result.push({
            date: hr.dateStr,
            timeSlot: hr.slotId,
            court,
            matchType: 'single',
            category: 'wedstrijd',
            players: [a, b],
          });
        } else {
          const grp = pickDoubles();
          if (!grp) return;
          const { teamA, teamB } = grp;
          const [x1, x2] = teamA,
            [y1, y2] = teamB;
          [x1, x2, y1, y2].forEach((p) => used.add(p));
          result.push({
            date: hr.dateStr,
            timeSlot: hr.slotId,
            court,
            matchType: 'double',
            category: 'training',
            players: [x1, x2, y1, y2],
          });
        }
      });
    });

    // 🔥 Firestore: seizoen wissen en nieuw schema zetten
    await ensureAuth();
    const existing = await getDocs(
      query(
        collection(db, 'reservations'),
        where('date', '>=', seasonStartStr),
        where('date', '<=', seasonEndStr)
      )
    );
    await Promise.all(existing.docs.map((d) => deleteDoc(d.ref)));
    await Promise.all(
      result.map((r) =>
        setDoc(doc(db, 'reservations', `${r.date}_${r.timeSlot}_${r.court}`), r, {
          merge: true,
        })
      )
    );

    // UI helpers resetten; niet meer nodig dankzij reservation records
    setMatchTypes({});
    setCategories({});
  };

  const planSelectedWeek = async () => {
    if (!isAdmin) return;
    const dateStr = selectedDate;

    const { opponentCount } = buildCounts(dateStr);
    const hours = TIME_SLOTS.map((slot) => ({
      dateStr,
      slotId: slot.id,
    }));
    const result: Reservation[] = [];
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
          result.push({
            date: hr.dateStr,
            timeSlot: hr.slotId,
            court,
            matchType: 'single',
            category: 'wedstrijd',
            players: [a, b],
          });
        } else {
          const grp = pickDoubles();
          if (!grp) return;
          const { teamA, teamB } = grp;
          const [x1, x2] = teamA,
            [y1, y2] = teamB;
          [x1, x2, y1, y2].forEach((p) => used.add(p));
          result.push({
            date: hr.dateStr,
            timeSlot: hr.slotId,
            court,
            matchType: 'double',
            category: 'training',
            players: [x1, x2, y1, y2],
          });
        }
      });
    });

    await ensureAuth();
    // Verwijder bestaande reservaties voor de geselecteerde datum
    const toDelete = await getDocs(
      query(collection(db, 'reservations'), where('date', '==', dateStr))
    );
    await Promise.all(toDelete.docs.map((d) => deleteDoc(d.ref)));

    // Schrijf nieuwe
    await Promise.all(
      result.map((r) =>
        setDoc(doc(db, 'reservations', `${r.date}_${r.timeSlot}_${r.court}`), r, {
          merge: true,
        })
      )
    );

    setMatchTypes({});
    setCategories({});
  };

  const clearAll = async () => {
    if (!isAdmin) return;
    const ok = window.confirm('Alle reservaties wissen?');
    if (!ok) return;

    await ensureAuth();
    const existing = await getDocs(
      query(
        collection(db, 'reservations'),
        where('date', '>=', seasonStartStr),
        where('date', '<=', seasonEndStr)
      )
    );
    await Promise.all(existing.docs.map((d) => deleteDoc(d.ref)));

    setSelectedPlayers({});
    setMatchTypes({});
    setCategories({});
    localStorage.setItem(RESERV_KEY, JSON.stringify([]));
    localStorage.setItem(MATCHTYPE_KEY, JSON.stringify({}));
    localStorage.setItem(CATEGORY_KEY, JSON.stringify({}));
  };

  /* --- Components --- */
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
      {r.result && (
        <div className="rounded-full px-2 py-1 text-[10px] font-semibold bg-green-100 text-green-700">
          ✅ {r.result.winner}
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
    const key = getCourtKey(date, timeSlot, court);
    const reservation = reservations.find(
      (r) => r.date === date && r.timeSlot === timeSlot && r.court === court
    );
    const matchType = getMatchType(date, timeSlot, court);
    const category = getCategory(date, timeSlot, court);
    const selected = selectedPlayers[key] || [];

    if (reservation) {
      const mayEdit = canModifyReservation(reservation);
      const canMarkWinner =
        reservation.category === 'wedstrijd' &&
        reservation.matchType === 'single' &&
        (!reservation.result || (reservation.result && isAdmin));

      const winner = reservation.result?.winner ?? undefined;

      const winnerButtons =
        canMarkWinner && mayEdit ? (
          <div className="absolute bottom-3 left-3 right-3 flex flex-wrap gap-2 justify-center">
            {reservation.players.map((p) => (
              <button
                key={p}
                onClick={() => markWinner(reservation, p)}
                className="px-3 py-1.5 rounded-full text-xs bg-white text-black hover:bg-white shadow border border-gray-200"
                title="Markeer winnaar"
              >
                ✅ {p} won
              </button>
            ))}
          </div>
        ) : null;

      return (
        <div className={courtClass}>
          <ReservationBadge r={reservation} />

          {reservation.matchType === 'single' ? (
            <>
              <div className="bg-blue-600 text-white text-center py-3 rounded border-2 border-white text-base font-semibold">
                <div className="flex items-center justify-center">
                  <PlayerChip
                    name={reservation.players[0]}
                    size="md"
                    highlight={winner === reservation.players[0]}
                  />
                </div>
              </div>
              <TennisNet />
              <div className="bg-blue-600 text-white text-center py-3 rounded border-2 border-white text-base font-semibold">
                <div className="flex items-center justify-center">
                  <PlayerChip
                    name={reservation.players[1]}
                    size="md"
                    highlight={winner === reservation.players[1]}
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1">
                <div className="bg-blue-600 text-white text-center py-2 rounded border-2 border-white text-sm font-semibold">
                  <div className="flex items-center justify-center">
                    <PlayerChip name={reservation.players[0]} size="sm" />
                  </div>
                </div>
                <div className="bg-blue-600 text-white text-center py-2 rounded border-2 border-white text-sm font-semibold">
                  <div className="flex items-center justify-center">
                    <PlayerChip name={reservation.players[1]} size="sm" />
                  </div>
                </div>
              </div>
              <TennisNet />
              <div className="space-y-1">
                <div className="bg-blue-600 text-white text-center py-2 rounded border-2 border-white text-sm font-semibold">
                  <div className="flex items-center justify-center">
                    <PlayerChip name={reservation.players[2]} size="sm" />
                  </div>
                </div>
                <div className="bg-blue-600 text-white text-center py-2 rounded border-2 border-white text-sm font-semibold">
                  <div className="flex items-center justify-center">
                    <PlayerChip name={reservation.players[3]} size="sm" />
                  </div>
                </div>
              </div>
            </>
          )}

          {mayEdit && (
            <button
              onClick={() => removeReservation(date, timeSlot, court)}
              className="absolute top-1 right-1 bg-red-500 text-white rounded-full w-6 h-6 text-xs hover:bg-red-600"
              title="Verwijder reservatie"
            >
              ×
            </button>
          )}

          {winnerButtons}
        </div>
      );
    }

    // Geen reservatie: select UI
    return (
      <div className={courtClass}>
        <div className="flex justify-center gap-2 mb-2">
          <button
            onClick={() => setMatchTypeFor(date, timeSlot, court, 'single')}
            className={`px-3 py-1 rounded text-sm font-bold ${
              matchType === 'single'
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-700'
            }`}
          >
            👤👤
          </button>
          <button
            onClick={() => setMatchTypeFor(date, timeSlot, court, 'double')}
            className={`px-3 py-1 rounded text-sm font-bold ${
              matchType === 'double'
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-700'
            }`}
          >
            👥👥
          </button>
          <select
            className="px-2 py-1 rounded text-sm bg-white border border-gray-300"
            value={category}
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

        {Array.from({ length: matchType === 'single' ? 2 : 4 }).map(
          (_, idx) => (
            <div key={`sel-${idx}`}>
              <select
                value={selected[idx] || ''}
                onChange={(e) =>
                  handlePlayerSelect(date, timeSlot, court, idx, e.target.value)
                }
                className={selectClass}
              >
                <option value="">Speler {idx + 1}</option>
                {playersAvailableFor(date, timeSlot).map((p) => (
                  <option key={p} value={p}>
                    {p} ({scoreOf(p)})
                  </option>
                ))}
              </select>
              {(matchType === 'single' ? idx === 0 : idx === 1) && (
                <TennisNet />
              )}
            </div>
          )
        )}

        <button
          onClick={() => handleReservation(date, timeSlot, court)}
          disabled={
            (selectedPlayers[key] || []).filter(Boolean).length !==
              (matchType === 'single' ? 2 : 4) ||
            (selectedPlayers[key] || []).some((p) => !p)
          }
          className="w-full bg-blue-600 text-white py-2 px-3 rounded text-sm disabled:opacity-50"
        >
          Reserveren
        </button>
      </div>
    );
  };

  /* --- Mijn beschikbaarheid (alleen eigen speler) --- */
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

  /* --- Ladder --- */
  const LadderPage = () => {
    const stats = useMemo(() => {
      const s: Record<string, { wins: number; losses: number; matches: number }> = {};
      PLAYERS.forEach((p) => (s[p] = { wins: 0, losses: 0, matches: 0 }));
      reservations.forEach((r) => {
        if (r.category !== 'wedstrijd' || r.matchType !== 'single' || !r.result)
          return;
        const { winner, loser } = r.result;
        if (!s[winner] || !s[loser]) return;
        s[winner].wins++;
        s[winner].matches++;
        s[loser].losses++;
        s[loser].matches++;
      });
      return s;
    }, [reservations]);

    const sorted = PLAYERS.slice().sort((a, b) => {
      const A = stats[a], B = stats[b];
      if (B.wins !== A.wins) return B.wins - A.wins;
      if (B.matches !== A.matches) return B.matches - A.matches;
      return a.localeCompare(b);
    });

    return (
      <div className="bg-white rounded-xl shadow-lg p-6">
        <h2 className="text-2xl font-bold text-gray-800 mb-2">🏆 Ladder</h2>
        <p className="text-sm text-gray-600 mb-6">
          De ladder telt enkel <b>Wedstrijden (single)</b> met geregistreerde
          winnaar.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead>
              <tr className="border-b">
                <th className="text-left py-3 px-4">Positie</th>
                <th className="text-left py-3 px-4">Speler</th>
                <th className="text-left py-3 px-4">Gespeeld</th>
                <th className="text-left py-3 px-4">Gewonnen</th>
                <th className="text-left py-3 px-4">Verloren</th>
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
                    <td className="py-3 px-4">
                      <PlayerChip name={player} size="md" />
                    </td>
                    <td className="py-3 px-4">{s.matches}</td>
                    <td className="py-3 px-4 text-green-600 font-semibold">
                      {s.wins}
                    </td>
                    <td className="py-3 px-4 text-red-600 font-semibold">
                      {s.losses}
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

  /* --- Login screen if not logged in --- */
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

          {loginName === ADMIN_NAME && (
            <div className="mb-4">
              <label className="block text-sm text-gray-700 mb-1">
                Wachtwoord (admin)
              </label>
              <input
                type="password"
                className={inputClass}
                placeholder="••••••••"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
              />
              <p className="text-[11px] text-gray-500 mt-1">
                Alleen vereist voor {ADMIN_NAME}.
              </p>
            </div>
          )}

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

  /* --- Main render --- */
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
            <nav className="-mb-px flex space-x-8">
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
                onClick={() => setActiveTab('ladder')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'ladder'
                    ? 'border-green-500 text-green-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                🏆 Ladder
              </button>
            </nav>
          </div>
        </div>

        {/* Tab: Reservatie (datum + terreinen) */}
        {activeTab === 'reservatie' && (
          <>
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

        {/* Tab: Beschikbaarheid (enkel eigen beschikbaarheid) */}
        {activeTab === 'beschikbaarheid' && (
          <MyAvailability playerName={myName!} />
        )}

        {/* Tab: Ladder */}
        {activeTab === 'ladder' && <LadderPage />}

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
