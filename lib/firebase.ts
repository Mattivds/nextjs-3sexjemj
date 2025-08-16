// lib/firebase.ts
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  onSnapshot,
  setDoc,
  writeBatch,
  serverTimestamp,
  type DocumentData,
} from 'firebase/firestore';

// ---- Env (NEXT_PUBLIC_*) ----
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  // measurementId is optional
};

// ---- App / Auth / DB singletons ----
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ---- Ensure anonymous auth ----
export async function ensureAuth(): Promise<User> {
  const cur = auth.currentUser;
  if (cur) return cur;

  // Wait for current state quickly
  const existing = await new Promise<User | null>((resolve) => {
    const unsub = onAuthStateChanged(auth, (u) => {
      unsub();
      resolve(u);
    });
  });
  if (existing) return existing;

  // Sign in anonymously
  const { user } = await signInAnonymously(auth);
  return user;
}

/* ============================================================
   syncData helper
   - Houdt "lichte" UI state bij in Firestore (matchTypes, selectedDate)
   - Biedt ook listeners voor reservations & availability
   ============================================================ */

type MatchType = 'single' | 'double';
type MatchCategory = 'training' | 'wedstrijd';

export interface Reservation {
  date: string; // yyyy-MM-dd
  timeSlot: string; // '18u30-19u30'
  court: number; // 1..3
  matchType: MatchType;
  category: MatchCategory;
  players: string[]; // single: [a,b], double: [x1,x2,y1,y2]
  result?: { winner: string; loser: string } | null;
}

type Availability = Record<string, Record<string, Record<string, boolean>>>;

const collReservations = collection(db, 'reservations');
const collAvailability = collection(db, 'availability');

// UI-state onder /ui/… (1 document per “helper”)
const docMatchTypes = doc(db, 'ui', 'matchTypes'); // { [courtKey]: 'single' | 'double' }
const docSelectedDate = doc(db, 'ui', 'selectedDate'); // { value: 'yyyy-MM-dd' }

export const syncData = {
  // --- Reservations (collection) ---
  onReservationsChange(cb: (data: Reservation[]) => void) {
    return onSnapshot(collReservations, (snap) => {
      const list: Reservation[] = [];
      snap.forEach((d) => {
        const r = d.data() as DocumentData;
        list.push({
          date: r.date,
          timeSlot: r.timeSlot ?? r.time_slot,
          court: r.court,
          matchType: (r.matchType ?? r.match_type) as MatchType,
          category: r.category as MatchCategory,
          players: r.players ?? [],
          result: r.result ?? null,
        });
      });
      cb(list);
    });
  },

  async setReservations(reservations: Reservation[]) {
    await ensureAuth();
    const batch = writeBatch(db);
    reservations.forEach((r) => {
      const id = `${r.date}_${r.timeSlot}_${r.court}`;
      batch.set(
        doc(db, 'reservations', id),
        {
          ...r,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    });
    await batch.commit();
  },

  // --- Availability (collection) ---
  onAvailabilityChange(cb: (data: Availability) => void) {
    return onSnapshot(collAvailability, (snap) => {
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
      cb(av);
    });
  },

  async setAvailability(av: Availability) {
    await ensureAuth();
    const batch = writeBatch(db);
    Object.entries(av).forEach(([date, bySlot]) => {
      Object.entries(bySlot).forEach(([slot, byPlayer]) => {
        Object.entries(byPlayer).forEach(([player, available]) => {
          const id = `${date}_${slot}_${player}`;
          batch.set(
            doc(db, 'availability', id),
            {
              date,
              timeSlot: slot,
              player,
              available,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        });
      });
    });
    await batch.commit();
  },

  // --- Match types (één doc met map) ---
  onMatchTypesChange(cb: (data: Record<string, MatchType>) => void) {
    return onSnapshot(docMatchTypes, (snap) => {
      const data = snap.data() as Record<string, MatchType> | undefined;
      cb(data || {});
    });
  },

  async setMatchTypes(map: Record<string, MatchType>) {
    await ensureAuth();
    await setDoc(
      docMatchTypes,
      { ...map, updatedAt: serverTimestamp() },
      { merge: true }
    );
  },

  // --- Selected date (één doc) ---
  onSelectedDateChange(cb: (date: string) => void) {
    return onSnapshot(docSelectedDate, (snap) => {
      const data = snap.data() as { value?: string } | undefined;
      cb(data?.value ?? '');
    });
  },

  async setSelectedDate(value: string) {
    await ensureAuth();
    await setDoc(
      docSelectedDate,
      { value, updatedAt: serverTimestamp() },
      { merge: true }
    );
  },
};
