import { Context, Flow, StateFlow } from "./flow";

export enum ReviewResponse {
  perfect = 5,
  correct_after_hesitation = 4,
  correct_with_serious_difficulty = 3,
  incorrect_but_easy_to_recall = 2,
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

const kSecondsPerDay = 60 * 60 * 24;
const kInitialReviewInterval = kSecondsPerDay;

// Locally-maintained table. One row per card.
export interface LearnState {
  card_id: string;
  deck_id: string;
  easiness_factor: number;
  review_interval: number;      // In seconds.
  scheduled_time: number;       // In seconds since the epoch.
}

interface Operation {
  type: string;
  table: string;
  data: SyncableRow;
}

interface FlashCardDb_Flows {
  get decks(): Flow<Array<Deck>>;
  get numChangesSinceLastSync(): Flow<number>;
  cardsInDeck(deck_id: string): Flow<Array<Card>>;
  numCardsOverdueInDeck(deck_id: string): Flow<number>;
  numCardsInDeck(deck_id: string): Flow<number>;
  reviewsForCard(card_id: string): Flow<Array<Review>>;
}

interface FlashCardDb_Actions {
  add_deck(deck_name: string): Promise<Deck>;
  add_card(deck_id: string, front: string, back: string): Promise<Card>;
  add_review_and_update_learn_state(card_id: string, deck_id: string, response: ReviewResponse): Promise<[Review, LearnState]>;
  reset(): Promise<void>;
  sync(): Promise<void>;
}

interface FlashCardDb_Queries {
  get_reviews_for_card(card_id: string): Promise<Array<Review>>;
  get_all_cards_in_deck(deck_id: string): Promise<Array<Card>>;
  get_learn_states_for_deck(deck_id: string): Promise<Array<LearnState>>;
  get_card(card_id: string): Promise<Card>;
}

export type FlashCardDbApi = FlashCardDb_Flows & FlashCardDb_Actions & FlashCardDb_Queries;

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
    db.addEventListener('insert', (event: CustomEvent) => {
      if (event.detail.table === 'learn_state') {
        const learnState = <LearnState>event.detail.data;
        if (!this._cardsToReview.has(learnState.deck_id)) {
          return;
        }
        const overdueCards = this._cardsToReview.get(learnState.deck_id);
        const isOverdue = get_now() > learnState.scheduled_time;
        if (isOverdue) {
          if (!overdueCards.has(learnState.card_id)) {
            overdueCards.add(learnState.card_id);
            this._numCardsOverdue.get(learnState.deck_id).value = overdueCards.size;
          }
        } else {
          if (overdueCards.has(learnState.card_id)) {
            overdueCards.delete(learnState.card_id);
            this._numCardsOverdue.get(learnState.deck_id).value = overdueCards.size;
          }
        }
      }
    });
    db.addEventListener('drop', (event: CustomEvent) => {
      if (event.detail.table === 'learn_state') {
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
    this._db.get_overdue_cards(deck_id, get_now()).then((overdueCards: Array<Card>) => {
      this._cardsToReview.set(deck_id, new Set(overdueCards.map(card => card.card_id)));
      flow.value = this._cardsToReview.get(deck_id).size;
    });
    return flow;
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
    db.addEventListener('insert', (event: CustomEvent) => {
      if (event.detail.table === 'cards') {
        const card = <Card>event.detail.data;
        if (this._flows.has(card.deck_id)) {
          const flow = this._flows.get(card.deck_id);
          const arr = flow.value.concat([card]);
          arr.sort((a, b) => a.date_created - b.date_created);
          flow.value = arr;

          this._countFlows.get(card.deck_id).value = arr.length;
        }
      }
    });
    db.addEventListener('drop', (event: CustomEvent) => {
      if (event.detail.table === 'cards') {
        for (let k of this._flows.keys()) {
          this._flows.get(k).value = [];
          this._countFlows.get(k).value = 0;
        }
      }
    });
  }
  deck(deck_id: string): Flow<Array<Card>> {
    if (this._flows.has(deck_id)) {
      return this._flows.get(deck_id);
    }
    this._flows.set(deck_id, this._ctx.create_state_flow([]));
    this._countFlows.set(deck_id, this._ctx.create_state_flow(0));
    this._fromScratch(deck_id);
  }
  _fromScratch(deck_id: string): void {
    this._db.get_all_cards_in_deck(deck_id).then((cards: Array<Card>) => {
      // We want the most recently created cards at the top of the list.
      cards.sort((a, b) => b.date_created - a.date_created);
      this._flows.get(deck_id).value = cards;
      this._countFlows.get(deck_id).value = cards.length;
    });
  }
  count(deck_id: string) {
    if (!this._countFlows.has(deck_id)) {
      this.deck(deck_id);  // Create count flow
    }
    return this._countFlows.get(deck_id);
  }
}

class DeckMaintainer {
  _decks: StateFlow<Array<Deck>>;
  constructor(db: FlashCardDb, ctx: Context) {
    this._decks = ctx.create_state_flow([], "DeckMaintainer");
    db.addEventListener('insert', (event: CustomEvent) => {
      if (event.detail.table === 'decks') {
        const decks = this._decks.value.concat(<Deck>event.detail.data);
        decks.sort((a, b) => a.date_created - b.date_created);
        this._decks.value = decks;
      }
    });
    db.addEventListener('drop', (event: CustomEvent) => {
      if (event.detail.table === 'decks') {
        this._decks.value = [];
      }
    });
    db.getAll<Deck>("decks").then((decks: Array<Deck>) => {
      decks.sort((a, b) => a.date_created - b.date_created);
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
  constructor(context: Context, onHot: () => T, onCold: () => T, name?: string) {
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
    const flow = new MonitorFlow(this._ctx, () => {
      // When we become hot, we grab the initial value from the database and
      // start listening.
      this._db.get_reviews_for_card(card_id).then((reviews: Array<Review>) => {
        reviews.sort((a, b) => b.date_created - a.date_created);
        flow.value = reviews;
      });
      this._db.addEventListener('insert', onchange);
      return <Array<Review>>[];
    }, () => {
      // When we become cold, we stop listening.
      this._db.removeEventListener('insert', onchange);
      return <Array<Review>>[];
    }, `Monitor-${card_id}`);
    this._flows.set(card_id, new WeakRef(flow));
    const onchange = (event: CustomEvent) => {
      if (event.detail.table === 'reviews') {
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
    const flow = new MonitorFlow<LearnState | undefined>(this._ctx, () => {
      // When we become hot, we grab the initial value from the database and
      // start listening.
      this._db._get_learn_state_for_card(card_id).then((learnState: LearnState) => {
        flow.value = learnState;
      });
      this._db.addEventListener('insert', onchange);
      return undefined;
    }, () => {
      // When we become cold, we stop listening.
      this._db.removeEventListener('insert', onchange);
      return undefined;
    }, `Monitor-${card_id}`);
    this._flows.set(card_id, new WeakRef(flow));
    const onchange = (event: CustomEvent) => {
      if (event.detail.table === 'learn_state') {
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

export class FlashCardDb extends EventTarget implements FlashCardDbApi {
  db: IDBDatabase;
  ctx: Context;
  _lastSyncTime: number;
  _numChangesSinceLastSync: StateFlow<number>;
  _numOverdue: NumOverdueMaintainer;
  _cardsInDecks: CardsInDeckMaintainer;
  _reviewsForCards: ReviewsForCardsMaintainer;
  _learnStateForCardsMaintainer: LearnStateForCardsMaintainer;
  _syncLocker: Locker<void>;
  _isOffline: StateFlow<boolean>;
  _decksMaintainer: DeckMaintainer;
  constructor(db: IDBDatabase, ctx: Context) {
    super();
    this.db = db;
    this.ctx = ctx;
    this._decksMaintainer = new DeckMaintainer(this, ctx);
    this._lastSyncTime = 0;
    this._numChangesSinceLastSync = ctx.create_state_flow(0, "db.numChanges"); // TODO: read this from the database.
    this._numOverdue = new NumOverdueMaintainer(this, ctx);
    this._cardsInDecks = new CardsInDeckMaintainer(this, ctx);
    this._reviewsForCards = new ReviewsForCardsMaintainer(this, ctx);
    this._learnStateForCardsMaintainer = new LearnStateForCardsMaintainer(this, ctx);
    this._syncLocker = new Locker(() => this._sync());
    this._isOffline = ctx.create_state_flow(true, "db.isOffline");

    this.addEventListener('insert', (event: CustomEvent) => {
      if (event.detail.table !== 'learn_state') {
        this._numChangesSinceLastSync.value++;
      }
    });
    this.get_unsynced_operations().then((operations: Array<Operation>) => {
      this._numChangesSinceLastSync.value = operations.length;
    });
    this._initialize_last_sync_time().then(() => this.sync());
  }
  _initialize_last_sync_time(): Promise<void> {
    return Promise.all([
      this._largest_remote_date("decks"),
      this._largest_remote_date("cards"),
      this._largest_remote_date("reviews"),
    ]).then(values => {
      this._lastSyncTime = Math.max.apply(null, values);
    });
  }
  _largest_remote_date(tableName: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(tableName, "readonly");
      const objectStore = transaction.objectStore(tableName);
      // Grab largest remote_date
      const request = objectStore.index('index_remote_date').openCursor(null, 'prev');
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
        alert('Something went wrong');
      }
    });
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
  get_decks(): Promise<Array<Deck>> {
    return this.getAll<Deck>("decks").then((decks: Array<Deck>) => {
      decks.sort((a, b) => a.date_created - b.date_created);
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
  _insert<T>(
    objectStoreName: string,
    obj: T,
    transaction: IDBTransaction | undefined = undefined,
    suppressEvent: boolean = false
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
        const date = ((<any>obj).remote_date);
        if (date > this._lastSyncTime) {
          this._lastSyncTime = date;
        }
      }
      if (!suppressEvent) {
        this.dispatchEvent(new CustomEvent("insert", {detail: {table: objectStoreName, data: obj}}));
      }
      return obj;
    });
  }
  add_deck(deck_name: string): Promise<Deck> {
    return this._insert<Deck>("decks", {
      deck_id: Math.random().toString(),
      deck_name: deck_name,
      date_created: get_now(),
      remote_date: kUnknownRemoteDate,
    });
  }
  add_card(deck_id: string, front: string, back: string): Promise<Card> {
    const txn = this.db.transaction(
      ["cards", "reviews", "learn_state"],
      "readwrite"
    );
    const card: Card = {
      card_id: Math.random().toString(),
      deck_id: deck_id,
      front: front,
      back: back,
      date_created: get_now(),
      remote_date: kUnknownRemoteDate,
    };
    return Promise.all([
      this._insert<Card>("cards", card, txn),
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
    return this._insert<LearnState>("learn_state", learnState, txn);
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
  _compute_incremental_learn_state(card_id: string, response: ReviewResponse): Promise<LearnState> {
    return this._get_learn_state_for_card(card_id).then((learnState: LearnState) => {
      learnState = Object.assign({}, learnState);
      this._update_learn_state(learnState, response);
      if (response <= ReviewResponse.incorrect_but_easy_to_recall) {
        learnState.scheduled_time = get_now() - 1;
      } else {
        learnState.scheduled_time = get_now() + learnState.review_interval;
      }
      return learnState;
    });
  }
  add_review_and_update_learn_state(card_id: string, deck_id: string, response: ReviewResponse): Promise<[Review, LearnState]> {
    return this._compute_incremental_learn_state(card_id, response).then((learnState: LearnState) => {
      const txn = this.db.transaction(["reviews", "learn_state"], "readwrite");
      return Promise.all([
        this._add_review(card_id, deck_id, response, txn),
        this._insert<LearnState>("learn_state", learnState, txn),
      ]);
    });
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
    learnState.easiness_factor += 0.1 - (5 - response) * (0.08 + (5 - response) * 0.02);
    learnState.easiness_factor = Math.max(1.3, learnState.easiness_factor);
    if (response <= ReviewResponse.incorrect_but_easy_to_recall) {
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
      const request = objectStore.index("index_card_id_and_date_created").getAll(keyRange);
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
    deck_id: string,
  ): Promise<LearnState> {
    // Unliked SM2, which takes pains to be O(1) time and space, we take advantage of the fact that
    // modern computers are fast and that the number of reviews for a card drops off exponentially,
    // so we can afford to be O(n) time and space.

    return this.get_reviews_for_card(card_id).then((reviews: Array<Review>) => {
      // Sort from most recent to least recent.
      reviews.sort((a, b) => b.date_created - a.date_created);
      // Remove reviews that are older than the most recent failed review.
      let lastFailedReview: Review | undefined = undefined;
      for (let review of reviews) {
        if (review.response <= ReviewResponse.incorrect_but_easy_to_recall) {
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
        scheduled_time: kUnknownClientDate,  // Fill in later.
      }

      for (let review of reviews.reverse()) {
        this._update_learn_state(learnState, review.response);
      }

      if (reviews.length > 0 && reviews[reviews.length - 1].response > ReviewResponse.incorrect_but_easy_to_recall) {
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
      review_id: Math.random().toString(),
      card_id: card_id,
      deck_id: deck_id,
      response: response,
      date_created: get_now(),
      remote_date: kUnknownRemoteDate,
    };
    return this._insert<Review>("reviews", review, txn);
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
    return this.get_learn_states_for_deck(deck_id).then((learnStates: Array<LearnState>) => {
      return learnStates.filter(learnState => now > learnState.scheduled_time);
    }).then((overdueLearnStates: Array<LearnState>) => {
      const promises = overdueLearnStates.map(learnState => this.get_card(learnState.card_id));
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
    this.dispatchEvent(new CustomEvent("drop", {detail: { table: "decks" }}));
    this.dispatchEvent(new CustomEvent("drop", {detail: { table: "cards" }}));
    this.dispatchEvent(new CustomEvent("drop", {detail: { table: "reviews" }}));
    this.dispatchEvent(new CustomEvent("drop", {detail: { table: "learn_state" }}));
    return new Promise<void>((resolve, reject) => {
      txn.oncomplete = () => {
        resolve();
      };
      txn.onerror = (event) => {
        reject(event);
      };
    }).then(() => {
      this._lastSyncTime = 0;
      return this.sync();
    }).then(() => {
      this.ctx.thaw();
    });
  }

  get_unsynced_operations(): Promise<Array<Operation>> {
    return Promise.all([
      this._get_unsynced_operations("decks"),
      this._get_unsynced_operations("cards"),
      this._get_unsynced_operations("reviews"),
    ]).then(([decks, cards, reviews]) => {
      return decks.concat(cards, reviews);
    });
  }
  _get_unsynced_operations(tableName: string): Promise<Array<Operation>> {
    if (!['decks', 'cards', 'reviews'].includes(tableName)) {
      throw new Error("Unknown table: " + tableName);
    }
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(tableName, "readonly");
      const objectStore = transaction.objectStore(tableName);
      const keyRange = IDBKeyRange.only(0);
      const request = objectStore.index("index_remote_date").getAll(keyRange);
      request.onsuccess = (event) => {
        const result = (<IDBRequest>event.target).result;
        resolve(result);
      };
      request.onerror = (event) => {
        reject(event);
      };
    }).then((rows: Array<SyncableRow>) => {
      return rows.map(row => ({type: "insert", table: tableName, data: row}));
    });
  }

  sync(): Promise<void> {
    return this._syncLocker.fire();
  }
  _sync(): Promise<void> {
    const now = get_now();

    // Note: we don't sync "learn_state" since it is derived from "reviews".
    const localOperations: Array<Operation> = [];
    return this.get_unsynced_operations()
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

      const txn = this.db.transaction(
        ["decks", "cards", "reviews", "learn_state"],
        "readwrite"
      );
      const insertionPromises: Array<any> = [];
      const newCardsByDeck = new Map<string, Array<Card>>();
      const affectedCards = new Map<string, string>();  // Map from card_id to deck_id.

      // Just need to update remote_date for these rows.
      for (let operation of localOperations) {
        // We suppressEvent since we don't want (e.g.) increment counters, since these rows already exist.
        // Realistically, nobody listening for events cares if remote_date is updated.
        insertionPromises.push(this._insert(operation.table, operation.data, txn, /* suppressEvent= */ true));
      }

      // Updating these are a bit more involved since we need to recompute learn state.
      for (let operation of remoteOperations) {
        if (operation.type === "insert") {
          insertionPromises.push(this._insert(operation.table, operation.data, txn));
          if (operation.table === "cards") {
            const card: Card = <Card>operation.data;
            if (!newCardsByDeck.has(card.deck_id)) {
              newCardsByDeck.set(card.deck_id, []);
            }
            newCardsByDeck.get(card.deck_id).push(card);
          }

          const cardId: string | undefined = (<any>operation.data).card_id;
          const deckId: string | undefined = (<any>operation.data).deck_id;
          if (cardId) {
            // IMPORTANT NOTE: every row with a card_id is guaranteed to have a deck_id!
            affectedCards.set(cardId, <string>deckId);
          }
        } else {
          throw new Error("Unknown operation: " + operation.type);
        }
      }

      // Slow. An alternative is to delete affected learn states and only recompute them
      // when they are needed, but that's possibly worse, since the user will definitely
      // be waiting on these values at that point. In any case, KISSing for now.
      let promises: Array<Promise<LearnState>> = [];
      affectedCards.forEach((deck_id, card_id) => {
        promises.push(this._compute_learn_state_from_scratch(card_id, deck_id));
      });
      return Promise.all(promises);
    })
    .then((nextReviewTimes: Array<LearnState>) => {
      // Insert the new learn states.
      const txn = this.db.transaction(["learn_state"], "readwrite");
      let promises = nextReviewTimes.map(learnState => this._insert<LearnState>("learn_state", learnState, txn));
      return Promise.all(promises);
    })
    .then((_) => {
      return this.get_unsynced_operations().then((operations: Array<Operation>) => {
        this._numChangesSinceLastSync.value = operations.length;
      });
    })
    // TODO: Clean up obsolete card histories to save space?
    // Reviewing 12 cards once each uses up 1/800k-th of our quota. Reviewing 1000 cards a day for a year
    // uses up 3.7% of our quota, so probably not a huge deal for now.
    .catch((error) => {
      if (error instanceof TypeError) {
        console.log("No internet connection");
        this._isOffline.value = true;
        return;
      }
      console.error(error);
      return error;
    })
  }
}