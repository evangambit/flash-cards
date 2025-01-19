import { Context, Flow, StateFlow } from "./flow";

export enum ReviewResponse {
  perfect = 3,
  correct_but_difficult = 2,
  incorrect = 1,
  complete_blackout = 0,
}

interface SyncResponse {
  remote: Array<Operation>;
  local: Array<Operation>;
}

export function get_now(): number {
  return Date.now() / 1000;
}

const kUnknownClientDate = 0;

const kUnknownRemoteDate = 0;

interface SyncableRow {
  date_created: number;
  remote_date: number;
}

export interface Deck extends SyncableRow {
  deck_id: string;
  deck_name: string;
}

export interface Card extends SyncableRow {
  card_id: string;
  deck_id: string;
  front: string;
  back: string;
}

export interface Review extends SyncableRow {
  review_id: string;
  card_id: string;
  deck_id: string;
  response: ReviewResponse;
}

interface Deletion extends SyncableRow {
  deletion_id: string;
  table: string;
  row: SyncableRow;
}

const kSecondsPerDay = 60 * 60 * 24;
const kInitialReviewInterval = kSecondsPerDay;

// Locally-maintained table. One row per card.
export interface LearnState {
  card_id: string;
  deck_id: string;
  easiness_factor: number;
  review_interval: number; // In seconds.
  scheduled_time: number; // In seconds since the epoch.
}

interface Operation {
  type: string;
  table: string;
  row: SyncableRow; // The deleted row if type == "remove".
}

interface FlashCardDb_Flows {
  get decks(): Flow<Array<Deck>>;
  get numChangesSinceLastSync(): Flow<number>;
  cardsInDeck(deck_id: string): Flow<Array<Card>>;
  numCardsOverdueInDeck(deck_id: string): Flow<number>;
  numCardsInDeck(deck_id: string): Flow<number>;
  reviewsForCard(card_id: string): Flow<Array<Review>>;
  card(card_id: string): Flow<Card>;
}

interface FlashCardDb_Actions {
  add_deck(deck_name: string): Promise<Deck>;
  add_card(deck_id: string, front: string, back: string): Promise<Card>;
  add_review_and_update_learn_state(
    card_id: string,
    deck_id: string,
    response: ReviewResponse
  ): Promise<[Review, LearnState]>;
  reset(): Promise<void>;
  sync(): Promise<void>;
}

interface FlashCardDb_Queries {
  get_reviews_for_card(card_id: string): Promise<Array<Review>>;
  get_all_cards_in_deck(deck_id: string): Promise<Array<Card>>;
  get_learn_states_for_deck(deck_id: string): Promise<Array<LearnState>>;
  get_card(card_id: string): Promise<Card>;
}

export type FlashCardDbApi = FlashCardDb_Flows &
  FlashCardDb_Actions &
  FlashCardDb_Queries;

class NumOverdueMaintainer {
  _db: FlashCardDb;
  _ctx: Context;
  _cardsToReview: Map<string, Set<string>>;
  _numCardsOverdue: Map<string, StateFlow<number>>;
  constructor(db: FlashCardDb, ctx: Context) {
    this._db = db;
    this._ctx = ctx;
    this._cardsToReview = new Map();
    this._numCardsOverdue = new Map();
    db.addEventListener("insert", (event: CustomEvent) => {
      if (event.detail.table === "learn_state") {
        const learnState = <LearnState>event.detail.data;
        if (!this._cardsToReview.has(learnState.deck_id)) {
          return;
        }
        const overdueCards = this._cardsToReview.get(learnState.deck_id);
        const isOverdue = get_now() > learnState.scheduled_time;
        if (isOverdue) {
          if (!overdueCards.has(learnState.card_id)) {
            overdueCards.add(learnState.card_id);
            this._numCardsOverdue.get(learnState.deck_id).value =
              overdueCards.size;
          }
        } else {
          if (overdueCards.has(learnState.card_id)) {
            overdueCards.delete(learnState.card_id);
            this._numCardsOverdue.get(learnState.deck_id).value =
              overdueCards.size;
          }
        }
      }
    });
    db.addEventListener("drop", (event: CustomEvent) => {
      if (event.detail.table === "learn_state") {
        for (let deck_id of this._cardsToReview.keys()) {
          this._cardsToReview.set(deck_id, new Set());
          this._numCardsOverdue.get(deck_id).value = 0;
        }
      }
    });
  }
  numCardsOverdue(deck_id: string): Flow<number> {
    if (this._numCardsOverdue.has(deck_id)) {
      return this._numCardsOverdue.get(deck_id);
    }
    const flow = this._ctx.create_state_flow(0);
    this._cardsToReview.set(deck_id, new Set());
    this._numCardsOverdue.set(deck_id, flow);
    this._db
      .get_overdue_cards(deck_id, get_now())
      .then((overdueCards: Array<Card>) => {
        this._cardsToReview.set(
          deck_id,
          new Set(overdueCards.map((card) => card.card_id))
        );
        flow.value = this._cardsToReview.get(deck_id).size;
      });
    return flow;
  }
  recompute_all(): Promise<any> {
    const deckIds = Array.from(this._cardsToReview.keys());
    return Promise.all(
      deckIds.map((deckId) => {
        return this._db
          .get_overdue_cards(deckId, get_now())
          .then((overdueCards: Array<Card>) => {
            const overdueSet = new Set(
              overdueCards.map((card) => card.card_id)
            );
            this._cardsToReview.set(deckId, overdueSet);
            this._numCardsOverdue.get(deckId).value = overdueSet.size;
          });
      })
    );
  }
}

class CardsInDeckMaintainer {
  _flows: Map<string, StateFlow<Array<Card>>>;
  _countFlows: Map<string, StateFlow<number>>;
  _db: FlashCardDb;
  _ctx: Context;
  constructor(db: FlashCardDb, ctx: Context) {
    this._db = db;
    this._ctx = ctx;
    this._flows = new Map();
    this._countFlows = new Map();
    db.addEventListener("insert", (event: CustomEvent) => {
      if (event.detail.table !== "cards") {
        return;
      }
      const card = <Card>event.detail.data;
      if (this._flows.has(card.deck_id)) {
        const flow = this._flows.get(card.deck_id);
        const arr = flow.value.concat([card]);
        sort_cards(arr);
        flow.value = arr;
        this._countFlows.get(card.deck_id).value = arr.length;
      }
    });
    db.addEventListener("drop", (event: CustomEvent) => {
      if (event.detail.table !== "cards") {
        return;
      }
      for (let k of this._flows.keys()) {
        this._flows.get(k).value = [];
        this._countFlows.get(k).value = 0;
      }
    });
    db.addEventListener("update", (event: CustomEvent) => {
      if (event.detail.table !== "cards") {
        return;
      }
      const card = <Card>event.detail.data;
      const flow = this._flows.get(card.deck_id);
      const arr = flow.value
        .filter((c) => c.card_id !== card.card_id)
        .concat([card]);
      sort_cards(arr);
      if (arr.length !== flow.value.length) {
        throw new Error(
          "Updating a card should not change the number of cards in a deck"
        );
      }
      flow.value = arr;
    });
  }
  deck(deck_id: string): Flow<Array<Card>> {
    if (this._flows.has(deck_id)) {
      return this._flows.get(deck_id);
    }
    this._flows.set(deck_id, this._ctx.create_state_flow([]));
    this._countFlows.set(deck_id, this._ctx.create_state_flow(0));
    this.fromScratch(deck_id);
  }
  fromScratch(deck_id: string, if_necessary: boolean = false): void {
    if (if_necessary && !this._flows.has(deck_id)) {
      return;
    }
    this._db.get_all_cards_in_deck(deck_id).then((cards: Array<Card>) => {
      // We want the most recently created cards at the top of the list.
      sort_cards(cards);
      this._flows.get(deck_id).value = cards;
      this._countFlows.get(deck_id).value = cards.length;
    });
  }
  count(deck_id: string) {
    if (!this._countFlows.has(deck_id)) {
      this.deck(deck_id); // Create count flow
    }
    return this._countFlows.get(deck_id);
  }
}

function sort_cards(cards: Array<Card>) {
  cards.sort(
    (a, b) =>
      a.date_created - b.date_created || a.card_id.localeCompare(b.card_id)
  );
}

function sort_decks(decks: Array<Deck>) {
  decks.sort(
    (a, b) =>
      a.date_created - b.date_created || a.deck_id.localeCompare(b.deck_id)
  );
}

class DeckMaintainer {
  _decks: StateFlow<Array<Deck>>;
  constructor(db: FlashCardDb, ctx: Context) {
    this._decks = ctx.create_state_flow([], "DeckMaintainer");
    db.addEventListener("insert", (event: CustomEvent) => {
      if (event.detail.table === "decks") {
        const decks = this._decks.value.concat(<Deck>event.detail.data);
        sort_decks(decks);
        this._decks.value = decks;
      }
    });
    db.addEventListener("drop", (event: CustomEvent) => {
      if (event.detail.table === "decks") {
        this._decks.value = [];
      }
    });
    db.getAll<Deck>("decks").then((decks: Array<Deck>) => {
      sort_decks(decks);
      this._decks.value = decks;
      return decks;
    });
  }
  get decks(): Flow<Array<Deck>> {
    return this._decks;
  }
}

class MonitorFlow<T> extends StateFlow<T> {
  _onHot: () => T;
  _onCold: () => T;
  constructor(
    context: Context,
    onHot: () => T,
    onCold: () => T,
    name?: string
  ) {
    super(context, undefined, name || "MonitorFlow");
    this._onHot = onHot;
    this._onCold = onCold;
  }
  _source_changed(): boolean {
    // Since we have not sources, this is only called when we become hot.
    const oldValue = this.value;
    this._value = this._onHot();
    return oldValue !== this._value;
  }
  _becoming_cold(): void {
    this._onCold();
  }
}

class ReviewsForCardsMaintainer {
  _db: FlashCardDb;
  _ctx: Context;
  _flows: Map<string, WeakRef<MonitorFlow<Array<Review>>>>;
  constructor(db: FlashCardDb, ctx: Context) {
    this._db = db;
    this._ctx = ctx;
    this._flows = new Map();
  }
  flow(card_id: string): Flow<Array<Review>> {
    if (this._flows.has(card_id) && this._flows.get(card_id).deref()) {
      return this._flows.get(card_id).deref();
    }
    const flow = new MonitorFlow(
      this._ctx,
      () => {
        // When we become hot, we grab the initial value from the database and
        // start listening.
        this._db
          .get_reviews_for_card(card_id)
          .then((reviews: Array<Review>) => {
            reviews.sort((a, b) => b.date_created - a.date_created);
            flow.value = reviews;
          });
        this._db.addEventListener("insert", onchange);
        return <Array<Review>>[];
      },
      () => {
        // When we become cold, we stop listening.
        this._db.removeEventListener("insert", onchange);
        return <Array<Review>>[];
      },
      `Monitor-${card_id}`
    );
    this._flows.set(card_id, new WeakRef(flow));
    const onchange = (event: CustomEvent) => {
      if (event.detail.table === "reviews") {
        const review = <Review>event.detail.data;
        if (review.card_id === card_id) {
          const reviews = flow.value.concat(review);
          reviews.sort((a, b) => b.date_created - a.date_created);
          flow.value = reviews;
        }
      }
    };
    return flow;
  }
}

class CardMaintainer {
  _db: FlashCardDb;
  _ctx: Context;
  _flows: Map<string, WeakRef<StateFlow<Card | undefined>>>;
  constructor(db: FlashCardDb, ctx: Context) {
    this._db = db;
    this._ctx = ctx;
    this._flows = new Map();
    const update = (event: CustomEvent) => {
      if (event.detail.table !== "cards") {
        return;
      }
      const card: Card = <Card>event.detail.data;
      if (this._flows.has(card.card_id)) {
        const flow = this._flows.get(card.card_id).deref();
        if (flow) {
          flow.value = card;
        } else {
          this._flows.delete(card.card_id);
        }
      }
    };
    db.addEventListener("insert", update);
    db.addEventListener("update", update);
  }
  flowPromise(card_id: string): Promise<Flow<Card>> {
    return this._db.get_card(card_id).then((card: Card) => {
      return <Flow<Card>>this.flow(card_id, card);
    });
  }
  flow(card_id: string, initialValue?: Card): Flow<Card | undefined> {
    if (this._flows.has(card_id) && this._flows.get(card_id).deref()) {
      return this._flows.get(card_id).deref();
    }
    const flow = this._ctx.create_state_flow(
      initialValue,
      `CardMaintainer-${card_id}`
    );
    this._flows.set(card_id, new WeakRef(flow));
    this._db.get_card(card_id).then((card: Card) => {
      flow.value = card;
    });
    return flow;
  }
}

class LearnStateForCardsMaintainer {
  _db: FlashCardDb;
  _ctx: Context;
  _flows: Map<string, WeakRef<MonitorFlow<LearnState | undefined>>>;
  constructor(db: FlashCardDb, ctx: Context) {
    this._db = db;
    this._ctx = ctx;
    this._flows = new Map();
  }
  flow(card_id: string): Flow<LearnState | undefined> {
    if (this._flows.has(card_id) && this._flows.get(card_id).deref()) {
      return this._flows.get(card_id).deref();
    }
    const flow = new MonitorFlow<LearnState | undefined>(
      this._ctx,
      () => {
        // When we become hot, we grab the initial value from the database and
        // start listening.
        this._db
          ._get_learn_state_for_card(card_id)
          .then((learnState: LearnState) => {
            flow.value = learnState;
          });
        this._db.addEventListener("insert", onchange);
        return undefined;
      },
      () => {
        // When we become cold, we stop listening.
        this._db.removeEventListener("insert", onchange);
        return undefined;
      },
      `Monitor-${card_id}`
    );
    this._flows.set(card_id, new WeakRef(flow));
    const onchange = (event: CustomEvent) => {
      if (event.detail.table === "learn_state") {
        const learnState = <LearnState>event.detail.data;
        if (learnState.card_id === card_id) {
          flow.value = learnState;
        }
      }
    };
    return flow;
  }
}

/**
 * A simple locker that ensures
 * 1) the function f is only called once at a time, and
 * 2) the function f will be called "soon" after it is requested to be called.
 */
class Locker<T> {
  _f: () => Promise<T>;

  // The current promise that is being executed (if any).
  _currentPromise: Promise<T> | undefined;

  // A promise that will be executed after the current promise is done.
  _nextPromise: Promise<T> | undefined;

  constructor(f: () => Promise<T>) {
    this._f = f;
    this._currentPromise = undefined;
    this._nextPromise = undefined;
  }
  fire(): Promise<T> {
    if (!this._currentPromise) {
      this._currentPromise = this._f().then((result) => {
        return result;
      });
      return this._currentPromise;
    }
    if (this._nextPromise) {
      // "nextPromise" is guaranteed to not yet be executing,
      // so returning here fulfills our promise that "f" will
      // be called after "fire".
      return this._nextPromise;
    }
    this._nextPromise = new Promise((resolve) => {
      this._currentPromise.then(() => {
        this._currentPromise = this._nextPromise;
        this._nextPromise = undefined;
        this._f().then((result) => {
          resolve(result);
        });
      });
    });
    return this._nextPromise;
  }
}

function new_id() {
  return Math.random().toString();
}

function largest_remote_date(
  db: IDBDatabase,
  tableName: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(tableName, "readonly");
    const objectStore = transaction.objectStore(tableName);
    // Grab largest remote_date
    const request = objectStore
      .index("index_remote_date")
      .openCursor(null, "prev");
    request.onsuccess = (event) => {
      const cursor: IDBCursorWithValue = (<IDBRequest>event.target).result;
      if (!cursor || !cursor.value) {
        // No entries in table.
        resolve(0);
        return;
      }
      resolve(cursor.value.remote_date);
    };
    request.onerror = (err) => {
      console.warn(err);
      alert("Something went wrong");
    };
  });
}

const kTable2Key: Map<string, string> = new Map(
  Object.entries({
    decks: "deck_id",
    cards: "card_id",
    reviews: "review_id",
    deletions: "deletion_id",
    learn_state: "card_id",
    people: "name",
  })
);

export class FlashCardDb extends EventTarget implements FlashCardDbApi {
  db: IDBDatabase;
  ctx: Context;
  _lastSyncTime: number; // The largest remote_date in the database.
  _numChangesSinceLastSync: StateFlow<number>;
  _numOverdue: NumOverdueMaintainer;
  _cardsInDecks: CardsInDeckMaintainer;
  _reviewsForCards: ReviewsForCardsMaintainer;
  _learnStateForCardsMaintainer: LearnStateForCardsMaintainer;
  _syncLocker: Locker<void>;
  _isOffline: StateFlow<boolean>;
  _decksMaintainer: DeckMaintainer;
  _cardMaintainer: CardMaintainer;
  /**
   * Creates a database. Use this (not the constructor) since there are some
   * asynchronous operations that it is convenient to do before the object is
   * fully created.
   */
  static create(db: IDBDatabase, ctx: Context): Promise<FlashCardDb> {
    return Promise.all([
      largest_remote_date(db, "decks"),
      largest_remote_date(db, "cards"),
      largest_remote_date(db, "reviews"),
    ])
      .then((values: Array<number>) => {
        return Math.max.apply(null, values);
      })
      .then((largestRemoteDate: number) => {
        return new FlashCardDb(db, ctx, largestRemoteDate);
      });
  }
  constructor(db: IDBDatabase, ctx: Context, largestRemoteDate: number) {
    super();
    this.db = db;
    this.ctx = ctx;
    this._decksMaintainer = new DeckMaintainer(this, ctx);
    this._lastSyncTime = largestRemoteDate;
    this._numChangesSinceLastSync = ctx.create_state_flow(0, "db.numChanges"); // TODO: read this from the database.
    this._numOverdue = new NumOverdueMaintainer(this, ctx);
    this._cardsInDecks = new CardsInDeckMaintainer(this, ctx);
    this._reviewsForCards = new ReviewsForCardsMaintainer(this, ctx);
    this._learnStateForCardsMaintainer = new LearnStateForCardsMaintainer(
      this,
      ctx
    );
    this._syncLocker = new Locker(() => this._sync());
    this._isOffline = ctx.create_state_flow(true, "db.isOffline");
    this._cardMaintainer = new CardMaintainer(this, ctx);

    this.addEventListener("insert", (event: CustomEvent) => {
      if (event.detail.table !== "learn_state") {
        this._numChangesSinceLastSync.value++;
      }
    });
    this.addEventListener("update", (event: CustomEvent) => {
      if (event.detail.table !== "learn_state") {
        this._numChangesSinceLastSync.value++;
      }
    });
    this.get_unsynced_operations().then((operations: Array<Operation>) => {
      this._numChangesSinceLastSync.value = operations.length;
    });
  }
  static brandNew(db: IDBDatabase) {
    console.log("Creating object stores");

    // These tables are synced with the server.
    const decks = db.createObjectStore("decks", {
      keyPath: kTable2Key.get("decks"),
    });
    const cards = db.createObjectStore("cards", {
      keyPath: kTable2Key.get("cards"),
    });
    const reviews = db.createObjectStore("reviews", {
      keyPath: kTable2Key.get("reviews"),
    });
    const deletions = db.createObjectStore("deletions", {
      keyPath: kTable2Key.get("deletions"),
    });
    console.log("creating people", kTable2Key.get("people"));
    const people = db.createObjectStore("people", {
      keyPath: kTable2Key.get("people"),
    });

    console.log(people);

    // Useful for syncing.
    decks.createIndex("index_remote_date", "remote_date", { unique: false });
    cards.createIndex("index_remote_date", "remote_date", { unique: false });
    reviews.createIndex("index_remote_date", "remote_date", { unique: false });
    deletions.createIndex("index_remote_date", "remote_date", {
      unique: false,
    });

    // This table is derived from the reviews table and doesn't need to be synced.
    const learnState = db.createObjectStore("learn_state", {
      keyPath: "card_id",
    });

    // Remaining indexes:

    // Useful for getting all cards in a deck.
    cards.createIndex("index_deck_id", "deck_id", { unique: false });

    // Useful for getting next card to review.
    learnState.createIndex("index_deck_id", ["deck_id"], { unique: false });

    // Useful for recomputing "upcoming" for a card.
    reviews.createIndex(
      "index_card_id_and_date_created",
      ["card_id", "date_created"],
      { unique: false }
    );
  }
  card(card_id: string): Flow<Card | undefined> {
    return this._cardMaintainer.flow(card_id);
  }
  cardFlowPromise(card_id: string): Promise<Flow<Card>> {
    return this._cardMaintainer.flowPromise(card_id);
  }
  reviewsForCard(card_id: string): Flow<Array<Review>> {
    return this._reviewsForCards.flow(card_id);
  }
  learnStateForCard(card_id: string): Flow<LearnState> {
    return this._learnStateForCardsMaintainer.flow(card_id);
  }
  numCardsOverdueInDeck(deck_id: string): Flow<number> {
    return this._numOverdue.numCardsOverdue(deck_id);
  }
  get decks(): Flow<Array<Deck>> {
    return this._decksMaintainer.decks;
  }
  cardsInDeck(deck_id: string): Flow<Array<Card>> {
    return this._cardsInDecks.deck(deck_id);
  }
  numCardsInDeck(deck_id: string): Flow<number> {
    return this._cardsInDecks.count(deck_id);
  }
  get numChangesSinceLastSync(): Flow<number> {
    return this._numChangesSinceLastSync;
  }
  get_deck(deck_id: string): Promise<Deck> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("decks", "readonly");
      const objectStore = transaction.objectStore("decks");
      const request = objectStore.get(deck_id);
      request.onsuccess = (event) => {
        resolve((<IDBRequest>event.target).result);
      };
      request.onerror = (event) => {
        reject(event);
      };
    });
  }
  get_decks(): Promise<Array<Deck>> {
    return this.getAll<Deck>("decks").then((decks: Array<Deck>) => {
      sort_decks(decks);
      return decks;
    });
  }
  getAll<T>(tableName: string): Promise<Array<T>> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(tableName, "readonly");
      const objectStore = transaction.objectStore(tableName);
      const request = objectStore.getAll();
      request.onsuccess = (event) => {
        resolve(<Array<T>>(<IDBRequest>event.target).result);
      };
      request.onerror = (event) => {
        console.error(event);
        reject(event);
      };
    });
  }
  /**
   * @param objectStoreName 
   * @param obj 
   * @param transaction 
   * @param isUpdate 
   * @returns 
   */
  _insert_syncable<T extends SyncableRow>(
    objectStoreName: string,
    obj: T,
    transaction: IDBTransaction | undefined = undefined,
    isUpdate: boolean = false
  ): Promise<T> {
    transaction =
      transaction || this.db.transaction([objectStoreName], "readwrite");
    const objectStore = transaction.objectStore(objectStoreName);
    return new Promise((resolve, reject) => {
      const objectStoreRequest = objectStore.put(obj);
      objectStoreRequest.onsuccess = (event) => {
        resolve(<T>obj);
      };
      objectStoreRequest.onerror = (event) => {
        console.error(event);
        reject(event);
      };
    }).then((obj: T) => {
      if (obj.hasOwnProperty("remote_date")) {
        const date = (<any>obj).remote_date;
        if (date > this._lastSyncTime) {
          this._lastSyncTime = date;
        }
      }
      const eventName = isUpdate ? "update" : "insert";
      this.dispatchEvent(
        new CustomEvent(eventName, {
          detail: { table: objectStoreName, data: obj },
        })
      );
      return obj;
    });
  }
  _remove<T extends SyncableRow>(
    objectStoreName: string,
    row: T,
    transaction: IDBTransaction | undefined = undefined
  ): Promise<void> {
    transaction =
      transaction ||
      this.db.transaction([objectStoreName, "deletions"], "readwrite");
    // We delete the given row and insert a deletion record.
    const objectStore = transaction.objectStore(objectStoreName);
    const key = (<any>row)[kTable2Key.get(objectStoreName)];
    return new Promise<void>((resolve, reject) => {
      const objectStoreRequest = objectStore.delete(key);
      objectStoreRequest.onsuccess = (event) => {
        resolve();
      };
      objectStoreRequest.onerror = (event) => {
        console.error(event);
        reject(event);
      };
    })
      .then(() => {
        const deletion: Deletion = {
          deletion_id: new_id(),
          table: objectStoreName,
          row: row,
          date_created: get_now(),
          remote_date: kUnknownRemoteDate,
        };
        return this._insert_syncable("deletions", deletion, transaction);
      })
      .then(() => {});
  }
  add_deck(deck_name: string): Promise<Deck> {
    return this._insert_syncable<Deck>("decks", {
      deck_id: new_id(),
      deck_name: deck_name,
      date_created: get_now(),
      remote_date: kUnknownRemoteDate,
    });
  }
  update_card(card: Card, front: string, back: string): Promise<Card> {
    card = Object.assign({}, card, { front: front, back: back });
    card.remote_date = kUnknownRemoteDate; // Indicates the server doesn't know about this change.
    return this._insert_syncable<Card>("cards", card, undefined, true);
  }
  add_card(deck_id: string, front: string, back: string): Promise<Card> {
    const txn = this.db.transaction(
      ["cards", "reviews", "learn_state"],
      "readwrite"
    );
    const card: Card = {
      card_id: new_id(),
      deck_id: deck_id,
      front: front,
      back: back,
      date_created: get_now(),
      remote_date: kUnknownRemoteDate,
    };
    return Promise.all([
      this._insert_syncable<Card>("cards", card, txn),
      this._add_new_learn_state(card.card_id, deck_id, card.date_created, txn),
    ]).then(() => {
      return card;
    });
  }
  _add_new_learn_state(
    card_id: string,
    deck_id: string,
    scheduled_time: number,
    txn: IDBTransaction | undefined = undefined
  ): Promise<LearnState> {
    txn = txn || this.db.transaction(["learn_state"], "readwrite");
    const learnState: LearnState = {
      card_id: card_id,
      deck_id: deck_id,
      easiness_factor: 2.5,
      review_interval: kInitialReviewInterval,
      scheduled_time: scheduled_time,
    };
    return this._insert_learn_state(learnState, txn);
  }

  _insert_learn_state(
    learnState: LearnState,
    transaction?: IDBTransaction | undefined
  ) {
    transaction =
      transaction || this.db.transaction(["learn_state"], "readwrite");
    const objectStore = transaction.objectStore("learn_state");
    return new Promise((resolve, reject) => {
      const objectStoreRequest = objectStore.put(learnState);
      objectStoreRequest.onsuccess = (event) => {
        resolve(learnState);
      };
      objectStoreRequest.onerror = (event) => {
        console.error(event);
        reject(event);
      };
    }).then((obj: LearnState) => {
      this.dispatchEvent(
        new CustomEvent("learn_state", {
          detail: { table: "learn_state", data: obj },
        })
      );
      return obj;
    });
  }

  _get_learn_state_for_card(card_id: string): Promise<LearnState> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("learn_state", "readonly");
      const objectStore = transaction.objectStore("learn_state");
      const request = objectStore.get(card_id);
      request.onsuccess = (event) => {
        resolve((<IDBRequest>event.target).result);
      };
      request.onerror = (event) => {
        reject(event);
      };
    });
  }
  _compute_incremental_learn_state(
    card_id: string,
    response: ReviewResponse
  ): Promise<LearnState> {
    return this._get_learn_state_for_card(card_id).then(
      (learnState: LearnState) => {
        learnState = Object.assign({}, learnState);
        this._update_learn_state(learnState, response);
        if (response <= ReviewResponse.incorrect) {
          learnState.scheduled_time = get_now() - 1;
        } else {
          learnState.scheduled_time = get_now() + learnState.review_interval;
        }
        return learnState;
      }
    );
  }
  add_review_and_update_learn_state(
    card_id: string,
    deck_id: string,
    response: ReviewResponse
  ): Promise<[Review, LearnState]> {
    return this._compute_incremental_learn_state(card_id, response).then(
      (learnState: LearnState) => {
        const txn = this.db.transaction(
          ["reviews", "learn_state"],
          "readwrite"
        );
        return Promise.all([
          this._add_review(card_id, deck_id, response, txn),
          this._insert_learn_state(learnState, txn),
        ]);
      }
    );
  }
  get isOfflineFlow(): Flow<boolean> {
    return this._isOffline;
  }

  /**
   * Synchronously update the learn state using the SM2 algorithm.
   * @param learnState Mutated in place.
   * @param response The user's response to the card.
   */
  _update_learn_state(learnState: LearnState, response: ReviewResponse): void {
    const a = -0.1 / 3;
    const b = 0.8 / 3;
    const c = -0.4;
    learnState.easiness_factor += a * response * response + b * response + c;
    learnState.easiness_factor = Math.max(1.3, learnState.easiness_factor);
    if (response <= ReviewResponse.incorrect) {
      learnState.review_interval = kInitialReviewInterval;
    } else {
      learnState.review_interval *= learnState.easiness_factor;
    }
  }

  // Returns the reviews for a card, sorted from most recent to least recent.
  get_reviews_for_card(card_id: string): Promise<Array<Review>> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("reviews", "readonly");
      const objectStore = transaction.objectStore("reviews");
      const keyRange = IDBKeyRange.bound([card_id], [card_id + "\uffff"]);
      const request = objectStore
        .index("index_card_id_and_date_created")
        .getAll(keyRange);
      request.onsuccess = (event) => {
        resolve((<IDBRequest>event.target).result);
      };
      request.onerror = (event) => {
        reject(event);
      };
    });
  }
  _compute_learn_state_from_scratch(
    card_id: string,
    deck_id: string
  ): Promise<LearnState> {
    console.log("Computing learn state from scratch");
    // Unliked SM2, which takes pains to be O(1) time and space, we take advantage of the fact that
    // modern computers are fast and that the number of reviews for a card drops off exponentially,
    // so we can afford to be O(n) time and space.

    return this.get_reviews_for_card(card_id).then((reviews: Array<Review>) => {
      // Sort from most recent to least recent.
      reviews.sort((a, b) => b.date_created - a.date_created);
      // Remove reviews that are older than the most recent failed review.
      let lastFailedReview: Review | undefined = undefined;
      for (let review of reviews) {
        if (review.response <= ReviewResponse.incorrect) {
          lastFailedReview = review;
          break;
        }
      }
      if (lastFailedReview) {
        reviews = reviews.filter(
          (review) => review.date_created >= lastFailedReview.date_created
        );
      }

      const learnState: LearnState = {
        card_id: card_id,
        deck_id: deck_id,
        easiness_factor: 2.5,
        review_interval: kSecondsPerDay,
        scheduled_time: kUnknownClientDate, // Fill in later.
      };

      for (let review of reviews.reverse()) {
        this._update_learn_state(learnState, review.response);
      }

      if (
        reviews.length > 0 &&
        reviews[reviews.length - 1].response > ReviewResponse.incorrect
      ) {
        learnState.scheduled_time = get_now() + learnState.review_interval;
      } else {
        learnState.scheduled_time = get_now() - 1;
      }
      return learnState;
    });
  }

  // Remember to update the "learn_state" table when you add a review.
  _add_review(
    card_id: string,
    deck_id: string,
    response: ReviewResponse,
    txn: IDBTransaction | undefined = undefined
  ): Promise<Review> {
    txn = txn || this.db.transaction(["reviews"], "readwrite");
    const review: Review = {
      review_id: new_id(),
      card_id: card_id,
      deck_id: deck_id,
      response: response,
      date_created: get_now(),
      remote_date: kUnknownRemoteDate,
    };
    return this._insert_syncable<Review>("reviews", review, txn);
  }
  get_all_cards_in_deck(deck_id: string): Promise<Array<Card>> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("cards", "readonly");
      const objectStore = transaction.objectStore("cards");
      const request = objectStore.index("index_deck_id").getAll(deck_id);
      request.onsuccess = (event) => {
        resolve((<IDBRequest>event.target).result);
      };
      request.onerror = (event) => {
        reject(event);
      };
    });
  }
  get_overdue_cards(deck_id: string, now: number): Promise<Array<Card>> {
    return this.get_learn_states_for_deck(deck_id)
      .then((learnStates: Array<LearnState>) => {
        return learnStates.filter(
          (learnState) => now > learnState.scheduled_time
        );
      })
      .then((overdueLearnStates: Array<LearnState>) => {
        const promises = overdueLearnStates.map((learnState) =>
          this.get_card(learnState.card_id)
        );
        return Promise.all(promises);
      });
  }
  get_learn_states_for_deck(deck_id: string): Promise<Array<LearnState>> {
    const transaction = this.db.transaction(["learn_state"], "readonly");
    const latestReviews = transaction.objectStore("learn_state");
    // TODO: why do I need this hack?
    const keyRange = IDBKeyRange.bound([deck_id], [deck_id + "\uffff"]);
    const index = latestReviews.index("index_deck_id");
    return new Promise((resolve, reject) => {
      const request = index.getAll(keyRange);
      request.onsuccess = (event) => {
        resolve((<IDBRequest>event.target).result);
      };
      request.onerror = (event) => {
        reject(event);
      };
    });
  }
  get_card(card_id: string): Promise<Card> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("cards", "readonly");
      const objectStore = transaction.objectStore("cards");
      objectStore.get(card_id).onsuccess = (event) => {
        resolve((<IDBRequest>event.target).result);
      };
    });
  }

  reset(): Promise<void> {
    // Drop all tables and re-download everything.
    this.ctx.freeze();
    const txn = this.db.transaction(
      ["decks", "cards", "reviews", "learn_state"],
      "readwrite"
    );
    txn.objectStore("decks").clear();
    txn.objectStore("cards").clear();
    txn.objectStore("reviews").clear();
    txn.objectStore("learn_state").clear();
    this.dispatchEvent(new CustomEvent("drop", { detail: { table: "decks" } }));
    this.dispatchEvent(new CustomEvent("drop", { detail: { table: "cards" } }));
    this.dispatchEvent(
      new CustomEvent("drop", { detail: { table: "reviews" } })
    );
    this.dispatchEvent(
      new CustomEvent("drop", { detail: { table: "learn_state" } })
    );
    return new Promise<void>((resolve, reject) => {
      txn.oncomplete = () => {
        resolve();
      };
      txn.onerror = (event) => {
        reject(event);
      };
    })
      .then(() => {
        this._lastSyncTime = 0;
        return this.sync();
      })
      .then(() => {
        this.ctx.thaw();
      });
  }

  /**
   * @returns A list of operations that need to be synced with the server, in the order they were created (and should be applied).
   */
  get_unsynced_operations(): Promise<Array<Operation>> {
    return Promise.all([
      this._get_unsynced_operations("decks"),
      this._get_unsynced_operations("cards"),
      this._get_unsynced_operations("reviews"),
      this._get_unsynced_operations("deletions"),
    ]).then(([decks, cards, reviews, deletions]) => {
      const results = decks.concat(cards, reviews, deletions);
      // Note "a.data.remote_date - b.data.remote_date || " isn't required, since all remote_dates should be zero.
      results.sort((a, b) => a.row.date_created - b.row.date_created);
      return results;
    });
  }
  _get_unsynced_operations(tableName: string): Promise<Array<Operation>> {
    if (!["decks", "cards", "reviews", "deletions"].includes(tableName)) {
      throw new Error("Unknown table: " + tableName);
    }
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(tableName, "readonly");
      const objectStore = transaction.objectStore(tableName);
      const keyRange = IDBKeyRange.only(kUnknownRemoteDate);
      const request = objectStore.index("index_remote_date").getAll(keyRange);
      request.onsuccess = (event) => {
        const rows: Array<SyncableRow> = (<IDBRequest>event.target).result;
        const operations = rows.map(
          (row: SyncableRow) =>
            <Operation>{
              type: "insert",
              table: tableName,
              row: row,
              key: undefined,
            }
        );
        let removals: Array<Operation> = [];
        if (tableName === "deletions") {
          removals = rows.map((row: SyncableRow) => {
            const deletion = <Deletion>row;
            return <Operation>{
              type: "remove",
              table: deletion.table,
              row: deletion.row,
            };
          });
        }
        resolve(operations.concat(removals));
      };
      request.onerror = (event) => {
        reject(event);
      };
    });
  }

  sync(): Promise<void> {
    return this._syncLocker.fire();
  }
  _sync(): Promise<void> {
    const now = get_now();

    /**
     * Consider two scenarios:
     * 
     * 1) We create a row and sync
     * 2) Another client deletes the row and syncs
     * 3) We edit the row and sync
     * 
     * 1) We create a row and sync.
     * 2) We edit the row and sync
     * 
     * Under a "last write wins" scenario we'd re-create the row. This would
     * force us to never delete Review rows (since any deleted card may be
     * resurrected at any time).
     * 
     * It would also force us to keep careful track of whether an operation is
     * an modification or an addition, since we need to publish the correct
     * event to our observers.
     * 
     * Considering "last write wins" was an arbitrary choice, it'd be foolish
     * to stick with it if it causes these kinds of problems.
     * 
     * Our new philosophy:
     * 
     * Last write wins (against other writes), but deletions always win.
     * 
     * Edits that occur after a deletion are simply dropped.
     */

    // Note: we don't sync "learn_state" since it is derived from "reviews".
    const localOperations: Array<Operation> = [];
    return (
      this.get_unsynced_operations()
        .then((ops) => {
          return fetch("/api/sync", {
            method: "POST",
            body: JSON.stringify({
              operations: ops,
              last_sync: this._lastSyncTime,
            }),
            headers: {
              "Content-Type": "application/json",
            },
          });
        })
        .then((response) => {
          this._isOffline.value = false;
          return response.json();
        })
        .then((response: SyncResponse) => {
          const remoteOperations: Array<Operation> = response.remote;
          const localOperations: Array<Operation> = response.local;
          for (const operations of [remoteOperations, localOperations]) {
            for (const operation of operations) {
              console.log(operation);
              if (operation.row.remote_date <= this._lastSyncTime) {
                throw Error("Bad remote date");
              }
            }
          }

          // Operations should already be sorted by remote_date, and then date_created, but let's be safe!
          remoteOperations.sort(
            (a, b) =>
              a.row.remote_date - b.row.remote_date ||
              a.row.date_created - b.row.date_created
          );
          localOperations.sort(
            (a, b) =>
              a.row.remote_date - b.row.remote_date ||
              a.row.date_created - b.row.date_created
          );

          const txn = this.db.transaction(
            ["decks", "cards", "reviews", "learn_state", "deletions"],
            "readwrite"
          );

          // It's pretty tricky to keep all incremental updates happy. The two feasible options are:
          // 1) *unapply* local operations, then apply remote operations, then reapply local operations.
          // 2) Apply remote operations, then reapply local operations so that local updates/removals
          //    overwrite the server's. Then recompute all necessary flows from scratch. (Note: in this
          //    case there is no need to dispatch events during syncing).
          //
          // 1 is probably the most faithful to the spirit of what we're doing, and since our general
          // philosophy is to assume the CPU can run circles around what a person can do, that's what
          // we're doing!

          // TODO: only undo operations with overlapping IDs betwee local and remote operations.

          const insertionPromises: Array<Promise<any>> = [];

          for (const operation of localOperations.reverse()) {
            if (operation.type === "insert") {
              insertionPromises.push(
                this._remove(operation.table, operation.row, txn)
              );
            } else if (operation.type === "remove") {
              insertionPromises.push(
                this._insert_syncable(operation.table, operation.row, txn)
              );
            } else {
              throw new Error("Unknown operation: " + operation.type);
            }
          }

          for (const operations of [remoteOperations, localOperations]) {
            for (const operation of operations) {
              if (operation.type === "insert") {
                insertionPromises.push(
                  this._insert_syncable(operation.table, operation.row, txn)
                );
              } else if (operation.type === "remove") {
                insertionPromises.push(
                  this._remove(operation.table, operation.row, txn)
                );
              } else {
                throw new Error("Unknown operation: " + operation.type);
              }
            }
          }

          // TODO: remove this hack.
          const requiredLearnStateUpdates = new Set<string>();
          for (const operations of [remoteOperations, localOperations]) {
            for (const operation of operations) {
              if (
                operation.table === "cards" ||
                operation.table === "reviews"
              ) {
                const card_id = (<any>operation.row).card_id;
                const deck_id = (<any>operation.row).deck_id;
                requiredLearnStateUpdates.add(`${card_id}::${deck_id}`);
              }
            }
          }
          console.log(requiredLearnStateUpdates);
          for (const key of requiredLearnStateUpdates) {
            const [card_id, deck_id] = key.split("::");
            insertionPromises.push(
              this._compute_learn_state_from_scratch(card_id, deck_id).then(
                (learnState) => {
                  return this._insert_learn_state(learnState);
                }
              )
            );
          }

          return Promise.all(insertionPromises);
        })
        .then(() => {
          // TODO: remove this hack.
          this._numOverdue.recompute_all();
        })
        .then(() => {
          this._numChangesSinceLastSync.value = 0;
        })
        // TODO: Clean up obsolete card histories to save space?
        // Reviewing 12 cards once each uses up 1/800k-th of our quota. Reviewing 1000 cards a day for a year
        // uses up 3.7% of our quota, so probably not a huge deal for now.
        .catch((error) => {
          // if (error instanceof TypeError) {
          //   console.log("No internet connection", error);
          //   this._isOffline.value = true;
          //   return;
          // }
          console.error(error);
          return error;
        })
    );
  }
}
