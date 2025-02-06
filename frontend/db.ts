import { Context, Flow, StateFlow } from "./flow";
import { SyncableDb, Deck, Card, Review, ReviewResponse, Operation, largest_remote_date, kUnknownRemoteDate, Deletable } from "./sync";

export function get_now(): number {
  return Date.now() / 1000;
}

const kUnknownClientDate = 0;
const kSecondsPerDay = 60 * 60 * 24;
const kInitialReviewInterval = kSecondsPerDay;

// Locally-maintained table. One row per card.
export interface LearnState extends Deletable {
  card_id: string;
  deck_id: string;
  easiness_factor: number;
  review_interval: number; // In seconds.
  scheduled_time: number; // In seconds since the epoch.
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
    db.addEventListener("add_learn_state", (event: CustomEvent) => {
      const learnState = <LearnState>event.detail.row;
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
    });
    db.addEventListener('delete_learn_state', (event: CustomEvent) => {
      const card_id = event.detail.card_id;
      for (let deck_id of this._cardsToReview.keys()) {
        const overdueCards = this._cardsToReview.get(deck_id);
        if (overdueCards.has(card_id)) {
          overdueCards.delete(card_id);
          this._numCardsOverdue.get(deck_id).value = overdueCards.size;
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
    db.addEventListener("add", (event: CustomEvent) => {
      if (event.detail.table !== "cards") {
        return;
      }
      const card = <Card>event.detail.row;
      if (!this._flows.has(card.deck_id)) {
        return;
      }
      const flow = this._flows.get(card.deck_id);
      const arr = flow.value.concat([card]);
      sort_cards(arr);
      if (arr.length !== flow.value.length + 1) {
        console.error('An add-card event should increase the card count by 1');
      }
      flow.value = arr;
      this._countFlows.get(card.deck_id).value = arr.length;
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
    db.addEventListener("modify", (event: CustomEvent) => {
      if (event.detail.table !== "cards") {
        return;
      }
      const card = <Card>event.detail.row;
      if (!this._flows.has(card.deck_id)) {
        return;
      }
      const flow = this._flows.get(card.deck_id);
      const arr = flow.value
        .filter((c) => c.card_id !== card.card_id)
        .concat([card]);
      sort_cards(arr);
      if (arr.length !== flow.value.length) {
        console.error('A modify-card event should not change how many cards are in a deck.');
      }
      flow.value = arr;
    });
    db.addEventListener("delete", (event: CustomEvent) => {
      if (event.detail.table !== "cards") {
        return;
      }
      const card = <Card>event.detail.row;
      if (!this._flows.has(card.deck_id)) {
        return;
      }
      const flow = this._flows.get(card.deck_id);
      const arr = flow.value.filter((c) => c.card_id !== card.card_id);
      if (arr.length !== flow.value.length - 1) {
        console.error('A delete-card event should decrease the card count by one');
      }
      flow.value = arr;
      this._countFlows.get(card.deck_id).value = arr.length;
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
    db.addEventListener("add", (event: CustomEvent) => {
      if (event.detail.table === "decks") {
        const decks = this._decks.value.concat(<Deck>event.detail.row);
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
        this._db.addEventListener("add", onchange);
        return <Array<Review>>[];
      },
      () => {
        // When we become cold, we stop listening.
        this._db.removeEventListener("add", onchange);
        return <Array<Review>>[];
      },
      `Monitor-${card_id}`
    );
    this._flows.set(card_id, new WeakRef(flow));
    const onchange = (event: CustomEvent) => {
      if (event.detail.table === "reviews") {
        const review = <Review>event.detail.row;
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
      const card: Card = <Card>event.detail.row;
      if (this._flows.has(card.card_id)) {
        const flow = this._flows.get(card.card_id).deref();
        if (flow) {
          flow.value = card;
        } else {
          this._flows.delete(card.card_id);
        }
      }
    };
    db.addEventListener("add", update);
    db.addEventListener("modify", update);
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
        this._db.addEventListener("add_learn_state", onchange);
        return undefined;
      },
      () => {
        // When we become cold, we stop listening.
        this._db.removeEventListener("add_learn_state", onchange);
        return undefined;
      },
      `Monitor-${card_id}`
    );
    this._flows.set(card_id, new WeakRef(flow));
    const onchange = (event: CustomEvent) => {
      const learnState = <LearnState>event.detail.row;
      if (learnState.card_id === card_id) {
        flow.value = learnState;
      }
    };
    return flow;
  }
}

function new_id() {
  return Math.random().toString();
}

const kTable2Key: Map<string, string> = new Map(
  Object.entries({
    decks: "deck_id",
    cards: "card_id",
    reviews: "review_id",
    learn_state: "card_id",
    people: "name",
  })
);

interface SignInResponse {
  signed_in: boolean;
  expiration: number | undefined;
  message: string;
}

export class FlashCardDb extends SyncableDb implements FlashCardDbApi {
  ctx: Context;
  _lastSyncTime: number; // The largest remote_date in the database.
  _numChangesSinceLastSync: StateFlow<number>;
  _numOverdue: NumOverdueMaintainer;
  _cardsInDecks: CardsInDeckMaintainer;
  _reviewsForCards: ReviewsForCardsMaintainer;
  _learnStateForCardsMaintainer: LearnStateForCardsMaintainer;
  _isOffline: StateFlow<boolean>;
  _decksMaintainer: DeckMaintainer;
  _cardMaintainer: CardMaintainer;
  _signedInFlow: StateFlow<boolean>;

  /**
   * Creates a database. Use this (not the constructor) since there are some
   * asynchronous operations that it is convenient to do before the object is
   * fully created.
   */
  static create(db: IDBDatabase, ctx: Context): Promise<FlashCardDb> {
    return largest_remote_date(db).then((largestRemoteDate: number) => {
      return new FlashCardDb(db, ctx, largestRemoteDate);
    });
  }
  constructor(db: IDBDatabase, ctx: Context, largestRemoteDate: number) {
    super(db, largestRemoteDate);
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
    this._isOffline = ctx.create_state_flow(true, "db.isOffline");
    this._cardMaintainer = new CardMaintainer(this, ctx);

    // Note: these operations only affect syncable tables, so (e.g.) we do not
    // count changes to the learn_state table.
    this.addEventListener("modify", (event: CustomEvent) => {
      this._numChangesSinceLastSync.value++;
    });
    this.addEventListener("add", (event: CustomEvent) => {
      this._numChangesSinceLastSync.value++;
    });
    this.addEventListener("delete", (event: CustomEvent) => {
      this._numChangesSinceLastSync.value++;
    });
    this.get_unsynced_operations().then((operations) => {
      this._numChangesSinceLastSync.value = operations.length;
    });

    this._signedInFlow = ctx.create_state_flow(false, "db.signedIn");
    fetch('/api/am_i_signed_in').then(r => r.json()).then((response: SignInResponse) => {
      this._signedInFlow.value = response.signed_in;
    });
  }
  static brandNew(db: IDBDatabase) {
    const r = SyncableDb.brandNew(db);
    const decks = r.decks;
    const cards = r.cards;
    const reviews = r.reviews;

    // This table is derived from the reviews table and doesn't need to be synced.
    const learnState = db.createObjectStore("learn_state", {
      keyPath: "card_id",
    });

    // Useful for getting all cards in a deck.
    cards.createIndex("index_deck_id", "deck_id", { unique: false });

    // Useful for getting next card to review.
    learnState.createIndex("index_deck_id", ["deck_id"], { unique: false });
    learnState.createIndex("index_card_id", ["card_id"], { unique: false });

    // Useful for recomputing "upcoming" for a card.
    reviews.createIndex(
      "index_card_id_and_date_created",
      ["card_id", "date_created"],
      { unique: false }
    );
    reviews.createIndex("index_card_id", ["card_id"], { unique: false });

    return r;
  }
  sign_in(username: string, password: string): Promise<boolean> {
    return fetch("/api/signin", {
      method: "POST",
      body: JSON.stringify({
        username: username,
        password: password,
      }),
      headers: { "Content-Type": "application/json" },
    }).then(r => r.json()).then((response: SignInResponse) => {
      console.log(response);
      this._signedInFlow.value = response.signed_in;
      return response.signed_in;
    });
  }

  sign_out(): Promise<boolean> {
    return fetch("/api/signout", {
      method: "POST",
    }).then((response) => {
      this._signedInFlow.value = false;
      return response.ok;
    });
  }

  get signedInStateFlow(): StateFlow<boolean> {
    return this._signedInFlow;
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
      return decks.filter((deck) => !deck.deleted);
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
  add_deck(deck_name: string): Promise<Deck> {
    return this._add<Deck>("decks", <Deck>{
      deck_id: new_id(),
      deck_name: deck_name,
      date_created: get_now(),
      remote_date: kUnknownRemoteDate,
    });
  }
  delete_card(card_id: string): Promise<void> {
    const txn = this.db.transaction(["reviews", "learn_state", "cards"], "readwrite");
    this._delete("cards", card_id, txn);
    txn.objectStore('learn_state').delete(card_id);
    return new Promise((resolve) => {
      txn.addEventListener('complete', () => {
        this.dispatchEvent(new CustomEvent('delete_learn_state', {
          detail: { table: 'learn_state', card_id: card_id }
        }));
        resolve();
      });
    });
  }
  modify_card(card: Card, front: string, back: string): Promise<Card> {
    card = Object.assign({}, card, { front: front, back: back });
    return this._modify<Card>("cards", card);
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
    const learnState: LearnState = {
      card_id: card.card_id,
      deck_id: deck_id,
      easiness_factor: 2.5,
      review_interval: kInitialReviewInterval,
      scheduled_time: card.date_created,
    };
    this._add<Card>("cards", card, txn),
    txn.objectStore("learn_state").put(learnState);
    return new Promise((resolve, reject) => {
      txn.oncomplete = (event) => {
        resolve(card);
      };
      txn.onerror = (event) => {
        reject(event);
      };
    });
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
        new CustomEvent("add_learn_state", {
          detail: { table: "add_learn_state", row: obj },
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
        const reviews: Array<Review> = (<IDBRequest>event.target).result;
        resolve(reviews.filter((review) => !review.deleted));
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
    return this._add<Review>("reviews", review, txn);
  }
  get_all_cards_in_deck(deck_id: string): Promise<Array<Card>> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("cards", "readonly");
      const objectStore = transaction.objectStore("cards");
      const request = objectStore.index("index_deck_id").getAll(deck_id);
      request.onsuccess = (event) => {
        const cards: Array<Card> = (<IDBRequest>event.target).result;
        resolve(cards.filter((card) => !card.deleted));
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
  _sync(): Promise<any> {
    return super._base_sync().then((remoteOperations: Array<Operation>) => {
      this._numChangesSinceLastSync.value = 0;
      // After we've synced all syncable tables, we need to recompute the learn state for all cards.
      const requiredLearnStateUpdates = new Set<string>();
      for (const operation of remoteOperations) {
        if (
          operation.table === "cards" ||
          operation.table === "reviews"
        ) {
          const card_id = (<any>operation.row).card_id;
          const deck_id = (<any>operation.row).deck_id;
          requiredLearnStateUpdates.add(`${card_id}::${deck_id}`);
        }
      }
      const promises = [];
      for (const key of requiredLearnStateUpdates) {
        const [card_id, deck_id] = key.split("::");
        promises.push(
          this._compute_learn_state_from_scratch(card_id, deck_id).then(
            (learnState) => {
              return this._insert_learn_state(learnState);
            }
          )
        );
      }
      return Promise.all(promises).then(() => remoteOperations);
    })
    .catch((error) => {
      if (error instanceof TypeError) {
        console.log("No internet connection", error);
        this._isOffline.value = true;
        return;
      }
      console.error(error);
      return error;
    });
    // TODO: Clean up obsolete card histories to save space?
    // Reviewing 12 cards once each uses up 1/800k-th of our quota. Reviewing 1000 cards a day for a year
    // uses up 3.7% of our quota, so probably not a huge deal for now.

  }
}
