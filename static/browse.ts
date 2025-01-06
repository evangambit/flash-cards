import {Context, Flow, Consumer, StateFlow} from "./flow";
import {FlashCardDb, Deck, Card, Review, ReviewResponse} from './db';
import {TableView} from './collection';
import { NavigationView, TopBarProvider } from "./navigation";
import { makeButton, makeTag } from "./checkbox";

interface BrowseUiState {
  cards: Array<Card>;
}

export class BrowseViewModel {
  _flow: Flow<BrowseUiState>;
  get flow(): Flow<BrowseUiState> {
    return this._flow;
  }

  constructor(deck: Deck, db: FlashCardDb, ctx: Context) {
    this._flow = db.cardsInDeck(deck.deck_id).map((cards: Array<Card>) => {
      return <BrowseUiState>{
        cards: cards,
      };
    }, 'cards -> BrowseUiState');
  }
}

interface CardCellUiState {
  card: Card;
  history: Array<Review> | undefined;
}

class CardHistoryUi extends HTMLElement {
  _consumer: Consumer<Array<Review>>;
  constructor(ctx: Context, db: FlashCardDb, card_id: string) {
    super();
    this._consumer = db.reviewsForCard(card_id).consume((reviews: Array<Review>) => {
      if (reviews.length === 0) {
        this.innerHTML = '<hr>No reviews';
        return;
      }
      if (reviews.length === 0) {
        this.innerHTML = `<hr>Never reviewed`;
      } else if (reviews.length > 5) {
        this.innerHTML = `<hr>Reviewed ${reviews.length} times`;
      } {
        this.innerHTML = `<hr>`;
      }
      // TODO: add when this is scheduled for.
      for (let review of reviews.slice(0, 5)) {
        const div = document.createElement('div');
        const date = new Date(review.date_created * 1000);
        div.innerText = `${review.response <= ReviewResponse.incorrect_but_easy_to_recall ? "❌" : "✅"} ${date.toLocaleString()}`;
        this.appendChild(div);
      }
    });
  }
  connectedCallback() {
    this._consumer.turn_on();
  }
  disconnectedCallback() {
    this._consumer.turn_off();
  }
}
customElements.define('card-history-ui', CardHistoryUi);

class CardCell extends HTMLElement {
  _historyUi: CardHistoryUi;
  _consumer: Consumer<CardCellUiState>;
  constructor(ctx: Context, db: FlashCardDb, card_id: string, flow: Flow<CardCellUiState>) {
    super();
    let idDiv = document.createElement('div');
    this.appendChild(idDiv);
    this.appendChild(makeTag('hr'));
    let frontDiv = document.createElement('div');
    this.appendChild(frontDiv);
    this.appendChild(makeTag('hr'));
    let backDiv = document.createElement('div');
    this.appendChild(backDiv);
    this.style.border = '1px solid black';
    this.style.margin = '0.5em';
    this.style.padding = '0.5em';
    this.style.borderRadius = '0.5em';
    this._consumer = flow.consume(((uiState: CardCellUiState) => {
      if (!uiState) {
        this.style.display = 'none';
        return;
      }
      const card = uiState.card;
      this.style.display = 'block';
      idDiv.innerText = card.card_id;
      frontDiv.innerText = card.front;
      backDiv.innerText = card.back;
    }), 'card cell consume');
    this._historyUi = new CardHistoryUi(ctx, db, card_id);
    this.addEventListener('click', () => {
      if (this.contains(this._historyUi)) {
        this.removeChild(this._historyUi);
      } else {
        this.appendChild(this._historyUi);
      }
    });


  }
  connectedCallback() {
    this._consumer.turn_on();
  }
  disconnectedCallback() {
    this._consumer.turn_off();
  }
}
customElements.define('card-cell', CardCell);

class CardMakerUi extends HTMLElement {
  constructor(ctx: Context, db: FlashCardDb, deck: Deck) {
    super();
    this.style.display = 'flex';
    this.style.flexDirection = 'column';
    const front = document.createElement('textarea');
    front.placeholder = 'Front';
    this.appendChild(front);
    const back = document.createElement('textarea');
    back.placeholder = 'Back';
    this.appendChild(back);
    const saveButton = makeButton('Save');
    saveButton.addEventListener('click', () => {
      db.add_card(deck.deck_id, front.value, back.value).then(() => {
        NavigationView.above(this).dismiss();
      });
    });
    this.appendChild(saveButton);
  }
}
customElements.define('card-maker-ui', CardMakerUi);

export class BrowseUi extends HTMLElement implements TopBarProvider {
  _landscape: StateFlow<boolean>;
  _topBarItems: StateFlow<Array<HTMLElement>>;
  constructor(ctx: Context, db: FlashCardDb, deck: Deck, viewModel: BrowseViewModel) {
    super();
    this.style.overflow = 'hidden';
    this.style.overflowY = 'auto';
    this._landscape = ctx.create_state_flow(false, 'landscape');
    const cardMap = viewModel.flow.map((uiState: BrowseUiState) => {
      let r = new Map<string, Card>();
      for (let card of uiState.cards) {
        r.set(card.card_id, card);
      }
      return r;
    }, 'BrowseUiState -> Map');
    let tableView = new TableView({
      viewForId: (card_id: string) => {
        const flow = cardMap.map(map => {
          const result = map.get(card_id);
          return <CardCellUiState>{
            card: result,
            history: undefined,
          };
        }, 'Map -> Card');
        return new CardCell(ctx, db, card_id, flow);
      }
    }, viewModel.flow.map(uiState => {
      return uiState.cards.map(card => card.card_id);
    }, 'Card -> ID'));
    tableView.style.maxHeight = '100%';
    this.appendChild(tableView);

    const newCardButton = makeButton('New Card');
    newCardButton.addEventListener('click', () => {
      NavigationView.above(this).present(new CardMakerUi(ctx, db, deck));
    });
    this._topBarItems = ctx.create_state_flow([newCardButton]);
  }
  get topBarItems(): Flow<Array<HTMLElement>> {
    return this._topBarItems;
  }
}
customElements.define('browse-ui', BrowseUi);