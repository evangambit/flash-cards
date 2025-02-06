import { Context, Consumer, Flow } from "./flow";
import { ReviewerUi, ReviewerViewModelImpl } from "./reviewer";
import { FlashCardDb } from "./db";
import { Deck, Card, Account } from "./sync";
import { BrowseUi } from "./browse";
import { makeButton, makeImage, makeTag } from "./checkbox";
import { NavigationController, TopBarProvider } from "./navigation";
import { DeckPanel } from "./deck_panel";

const USE_DEBUG_DATA = window.location.search.includes('debugdata=1');
const SHOW_DEBUG_BUTTONS = false;

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

  FlashCardDb.brandNew(db);
};

const account: Account = {
  username: "alice",
  password: "test",
}

dbPromise.then((db: IDBDatabase) => FlashCardDb.create(db, new Context(), account)).then((db: FlashCardDb) => {
  console.log("Creating context");
  const ctx = db.ctx;
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

class SettingsUi extends HTMLElement {
  constructor(db: FlashCardDb, ctx: Context) {
    super();
    const logoutButton = makeButton("Logout");
    logoutButton.addEventListener("click", () => {
      db.logout();
      NavigationController.navigation.pop();
    });
    this.appendChild(logoutButton);
  }
}
customElements.define("settings-ui", SettingsUi);

class SyncButton extends HTMLElement {
  _consumer: Consumer<number>;
  _ctx: Context;
  constructor(db: FlashCardDb, ctx: Context) {
    super();
    this._ctx = ctx;
    this.setAttribute("tabIndex", "0");
    this.classList.add("button");
    this.addEventListener("click", () => {
      db.sync().then(() => {
        console.log("Synced");
      });
    });

    const icon = makeImage(new URL("./assets/sync.png", import.meta.url), {
      height: "100%",
    });
    this.appendChild(icon);

    const countSpan = makeTag("span", "0");
    this.appendChild(countSpan);

    this._consumer = db.numChangesSinceLastSync.consume((numChanges) => {
      countSpan.innerText = numChanges.toString();
    }, "SyncConsumer");
  }
  connectedCallback() {
    this._consumer.turn_on();
  }
  disconnectedCallback() {
    this._consumer.turn_off();
  }
}
customElements.define("sync-button", SyncButton);

class HomeView extends HTMLElement implements TopBarProvider {
  _topBarItems: Flow<Array<HTMLElement>>;
  _db: FlashCardDb;
  _ctx: Context;
  constructor(db: FlashCardDb, ctx: Context) {
    super();

    this._db = db;
    this._ctx = ctx;

    const reviewDeck = (deck: Deck) => {
      let viewModel = new ReviewerViewModelImpl(deck, db, ctx, () => {
        NavigationController.navigation.pop();
      });
      const ui = new ReviewerUi(viewModel);
      NavigationController.navigation.push(ui);
    };
    const browseDeck = (deck: Deck) => {
      const ui = new BrowseUi(ctx, db, deck);
      NavigationController.navigation.push(ui);
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
      this._topBarItems = this._ctx.create_state_flow(<Array<HTMLElement>>[], "TopBarButtons");
      return this._topBarItems;
    }

    this._topBarItems = NavigationController.navigation.stackFlow.map((stack) => {
      if (stack[stack.length - 1] === this) {
        return <Array<HTMLElement>>[];
      } else {
        return <Array<HTMLElement>>[];
      }
    });
    return this._topBarItems;
  }
}
customElements.define("home-ui", HomeView);

function main(db: FlashCardDb, ctx: Context) {
  console.log("Creating main view");

  let debugButton = makeButton("🪳");
  debugButton.addEventListener("click", () => {
    ctx.print_graph();
    db.getAll("decks")
      .then((decks: Array<Deck>) => {
        console.log("decks");
        decks.forEach((val) => console.log(val));
      })
      .then(() => db.getAll("cards"))
      .then((cards: Array<Card>) => {
        console.log("cards");
        cards.forEach((val) => console.log(val));
      })
      .then(() => db.getAll("reviews"))
      .then((reviews: Array<Card>) => {
        console.log("reviews");
        reviews.forEach((val) => console.log(val));
      })
      .then(() => db.getAll("learn_state"))
      .then((learnStates: Array<Card>) => {
        console.log("learnStates");
        learnStates.forEach((val) => console.log(val));
      });
  });

  const settingsButton = makeButton(makeImage(new URL("./assets/gear.png", import.meta.url), { height: "100%" }));
  settingsButton.addEventListener("click", () => {
    NavigationController.navigation.push(new SettingsUi(db, ctx));
  });
  const buttons = [settingsButton, new SyncButton(db, ctx)];
  if (SHOW_DEBUG_BUTTONS) {
    buttons.push(debugButton);
  }
  const buttonsFlow = ctx.create_state_flow([], "TopBarButtons");

  NavigationController.navigation = new NavigationController(
    ctx,
    buttonsFlow
  );
  NavigationController.navigation.addEventListener("stack-change", (e: CustomEvent) => {
    buttonsFlow.value = buttons.filter((button) => {
      if (button === debugButton) {
        return SHOW_DEBUG_BUTTONS;
      }
      if (button === settingsButton) {
        const settingsUiCurrentlyInStack =
        e.detail.stack.filter(
          (element: HTMLElement) => element.tagName === "SETTINGS-UI"
        ).length > 0;
        return !settingsUiCurrentlyInStack;
      }
      return true;
    });
  });
  NavigationController.navigation.push(new HomeView(db, ctx));
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(
    new URL("./serviceworker.js", import.meta.url)
  );
}
