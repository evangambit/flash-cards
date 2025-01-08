import { Context, Consumer, Flow } from "./flow";
import { ReviewerUi, ReviewerViewModelImpl } from "./reviewer";
import { FlashCardDb, Deck, Card } from "./db";
import { BrowseViewModel, BrowseUi } from "./browse";
import { TableView } from "./collection";
import { makeButton, makeTag } from "./checkbox";
import { NavigationView, TopBarProvider } from "./navigation";

const USE_DEBUG_DATA = false;
const SHOW_DEBUG_BUTTONS = true;

if (USE_DEBUG_DATA) {
  window.indexedDB.deleteDatabase("flashcards");
}
const DBOpenRequest = window.indexedDB.open("flashcards", /* version= */ 1);
const dbPromise = new Promise((resolve, reject) => {
  DBOpenRequest.onsuccess = (event) => {
    console.log("Database opened");
    resolve((<IDBRequest>event.target).result);
  };
  DBOpenRequest.onerror = (event) => {
    console.error("Database error:", event);
    reject(event);
  };
});
DBOpenRequest.onupgradeneeded = (event: IDBVersionChangeEvent) => {
  if (!event.target) {
    throw Error("Database is null");
  }
  const request = <IDBOpenDBRequest>event.target;
  if (!request) {
    throw Error("Database is null");
  }
  const db: IDBDatabase = request.result;
  db.onerror = (event) => {
    console.error("Database error:", event);
  };

  console.log("Creating object stores");

  const decks = db.createObjectStore("decks", { keyPath: "deck_id" }); // Deck
  const cards = db.createObjectStore("cards", { keyPath: "card_id" }); // Card
  const reviews = db.createObjectStore("reviews", { keyPath: "review_id" }); // Review
  const learnState = db.createObjectStore("learn_state", {
    keyPath: "card_id",
  }); // Upcoming

  // Useful for getting next card to review.
  learnState.createIndex("index_deck_id", ["deck_id"], { unique: false });

  // Useful for getting all cards in a deck.
  cards.createIndex("index_deck_id", "deck_id", { unique: false });

  // Useful for syncing.
  decks.createIndex("index_remote_date", "remote_date", { unique: false });
  cards.createIndex("index_remote_date", "remote_date", { unique: false });
  reviews.createIndex("index_remote_date", "remote_date", { unique: false });

  // Useful for recomputing "upcoming" for a card.
  reviews.createIndex(
    "index_card_id_and_date_created",
    ["card_id", "date_created"],
    { unique: false }
  );
};

dbPromise.then((rawDb: IDBDatabase) => {
  console.log("Creating context");
  const ctx = new Context();
  const db = new FlashCardDb(rawDb, ctx);
  if (!USE_DEBUG_DATA) {
    main(db, ctx);
    return;
  }
  console.log("Adding debug data");
  db.add_deck("deck_name")
    .then((deck) => {
      let promises = [];
      for (let i = 0; i < 20; ++i) {
        promises.push(db.add_card(deck.deck_id, `front ${i}`, `back ${i}`));
      }
      return Promise.all(promises);
    })
    .then(() => {
      main(db, ctx);
    });
});

function td_with_child(child: HTMLElement): HTMLElement {
  const td = document.createElement("td");
  td.appendChild(child);
  return td;
}

class DeckCell extends HTMLElement {
  _consumer: Consumer<any>;
  constructor(db: FlashCardDb, deck: Deck, reviewDeck: (deck: Deck) => void, browseDeck: (deck: Deck) => void) {
    super();
      this._consumer = db
        .numCardsOverdueInDeck(deck.deck_id)
        .concat(db.numCardsInDeck(deck.deck_id))
        .consume(([numOverdue, numCardsInDeck]) => {
          this.innerHTML = '';
          this.style.display = 'flex';
          this.style.flexDirection = 'column';
          this.style.padding = '0.5em';
          this.style.border = '1px solid black';
          this.style.borderRadius = '0.5em';
          this.style.margin = '0.5em';

          const label = document.createElement('div');
          label.style.whiteSpace = 'nowrap';
          label.innerText = `${deck.deck_name} (${numCardsInDeck} cards)`;
          this.appendChild(label);

          this.appendChild(makeTag('div', `Overdue: ${numOverdue}`));

          const buttonPanel = document.createElement('div');
  
          const reviewButton = makeButton("Review");
          reviewButton.addEventListener('click', () => {
            reviewDeck(deck);
          });
          buttonPanel.appendChild(reviewButton);
  
          const browseButton = makeButton("Browse");
          browseButton.addEventListener('click', () => {
            browseDeck(deck);
          });
          buttonPanel.appendChild(browseButton);

          this.appendChild(buttonPanel);
        });
  }
  connectedCallback() {
    this._consumer.turn_on();
  }
  disconnectedCallback() {
    this._consumer.turn_off();
  }
}
customElements.define("deck-cell", DeckCell);

class DeckPanel extends HTMLElement {
  _tableView: TableView;
  _consumer: Consumer<[Array<Deck>, Map<string, number>]>;
  constructor(
    db: FlashCardDb,
    reviewDeck: (deck: Deck) => void,
    browseDeck: (deck: Deck) => void
  ) {
    super();
    const decks: Map<string, Deck> = new Map();
    this._tableView = new TableView(
      {
        viewForId(deck_id: string): HTMLElement {
          return new DeckCell(db, decks.get(deck_id), reviewDeck, browseDeck);
        },
      },
      db.decks.map((decksArr) => {
        for (let deck of decksArr) {
          decks.set(deck.deck_id, deck);
        }
        return Array.from(decks.keys());
      })
    );
    this.appendChild(this._tableView);
  }
}
customElements.define("deck-panel", DeckPanel);

class SyncButton extends HTMLElement {
  _consumer: Consumer<number>;
  constructor(db: FlashCardDb, ctx: Context) {
    super();
    this.innerText = "Sync";
    this.setAttribute('tabIndex', '0');
    this.addEventListener("click", () => {
      db.sync().then(() => {
        console.log("Synced");
      });
    });
  
    this._consumer = db.numChangesSinceLastSync
      .consume((numChanges) => {
        this.innerText = `Sync (${numChanges})`;
        if (numChanges === 0) {
          this.setAttribute('disabled', 'true');
        } else {
          this.removeAttribute('disabled');
        }
      }, "SyncConsumer");
    this.classList.add('button');
  }
  connectedCallback() {
    this._consumer.turn_on();
  }
  disconnectedCallback() {
    this._consumer.turn_off();
  }
}
customElements.define('sync-button', SyncButton);

class HomeView extends HTMLElement implements TopBarProvider {
  _topBarItems: Flow<Array<HTMLElement>>;
  _db: FlashCardDb;
  constructor(db: FlashCardDb, ctx: Context) {
    super();

    this._db = db;

    const reviewDeck = (deck: Deck) => {
      let viewModel = new ReviewerViewModelImpl(deck, db, ctx, () => {
        NavigationView.above(ui).pop();
      });
      const ui = new ReviewerUi(viewModel);
      NavigationView.above(this).push(ui);
    };
    const browseDeck = (deck: Deck) => {
      let viewModel = new BrowseViewModel(deck, db, ctx);
      const ui = new BrowseUi(ctx, db, deck, viewModel);
      NavigationView.above(this).push(ui);
    };
    const deckPanel = new DeckPanel(db, reviewDeck, browseDeck);
    this.appendChild(deckPanel);

    db.get_decks(); // Refresh the decks.
  }
  get topBarItems(): Flow<Array<HTMLElement>> {
    if (this._topBarItems) {
      return this._topBarItems;
    }

    if (!SHOW_DEBUG_BUTTONS) {
      this._topBarItems = NavigationView.above(this).stackFlow.map(() => <Array<HTMLElement>>[]);
      return this._topBarItems;
    }
    const resetButton = makeButton("Reset");
    resetButton.addEventListener("click", () => {
      this._db.reset();
    });

    this._topBarItems = NavigationView.above(this).stackFlow.map((stack) => {
      if (stack[stack.length - 1] === this) {
        return [resetButton];
      } else {
        return [];
      }
    });
    return this._topBarItems;
  }
}
customElements.define("home-ui", HomeView);


function main(db: FlashCardDb, ctx: Context) {
  console.log("Creating main view");

  let debugButton = makeButton("Debug");
  debugButton.addEventListener("click", () => {
    ctx.print_graph();
    db.getAll("decks")
      .then((decks: Array<Deck>) => {
        console.log('decks');
        decks.forEach(val => console.log(val));
      })
      .then(() => db.getAll("cards"))
      .then((cards: Array<Card>) => {
        console.log('cards');
        cards.forEach(val => console.log(val));
      })
      .then(() => db.getAll("reviews"))
      .then((reviews: Array<Card>) => {
        console.log('reviews');
        reviews.forEach(val => console.log(val));
      })
      .then(() => db.getAll("learn_state"))
      .then((learnStates: Array<Card>) => {
        console.log('learnStates');
        learnStates.forEach(val => console.log(val));
      });
  });

  const buttons: Array<HTMLElement> = [new SyncButton(db, ctx)];
  if (SHOW_DEBUG_BUTTONS) {
    buttons.push(debugButton);
  }

  const navigationView = new NavigationView(ctx, new HomeView(db, ctx), buttons);
  document.body.appendChild(navigationView);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('./serviceworker.js', import.meta.url));
}
