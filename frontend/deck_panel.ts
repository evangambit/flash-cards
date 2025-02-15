import { Consumer } from "./flow";
import { FlashCardDb } from "./db";
import { Deck } from "./sync";
import { TableView } from "./collection";
import { makeButton, makeTag } from "./checkbox";


class DeckCell extends HTMLElement {
  _consumer: Consumer<any>;
  constructor(
    db: FlashCardDb,
    deck: Deck,
    reviewDeck: (deck: Deck) => void,
    browseDeck: (deck: Deck) => void
  ) {
    super();
    this._consumer = db
      .numCardsOverdueInDeck(deck.deck_id)
      .concat(db.numCardsInDeck(deck.deck_id))
      .consume(([numOverdue, numCardsInDeck]) => {
        this.innerHTML = "";
        this.style.display = "flex";
        this.style.flexDirection = "column";
        this.style.padding = "0.5em";
        this.style.borderRadius = "0.5em";
        this.style.margin = "0.5em";

        const label = document.createElement("div");
        label.innerText = `${deck.deck_name} (${numCardsInDeck} cards)`;
        this.appendChild(label);

        this.appendChild(makeTag("div", `Overdue: ${numOverdue}`));

        const buttonPanel = document.createElement("div");

        const reviewButton = makeButton("Review");
        reviewButton.addEventListener("click", () => {
          reviewDeck(deck);
        });
        buttonPanel.appendChild(reviewButton);

        const browseButton = makeButton("Browse");
        browseButton.addEventListener("click", () => {
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

export class DeckPanel extends HTMLElement {
  _consumer: Consumer<[Array<Deck>, Map<string, number>]>;
  constructor(
    db: FlashCardDb,
    reviewDeck: (deck: Deck) => void,
    browseDeck: (deck: Deck) => void
  ) {
    super();
    const decks: Map<string, Deck> = new Map();
    const tableView = new TableView(
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
    this.appendChild(tableView);
  }
}
customElements.define("deck-panel", DeckPanel);
