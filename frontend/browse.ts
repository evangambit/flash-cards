import {Context, Flow, Consumer, StateFlow} from "./flow";
import {FlashCardDb, Deck, Card, Review, ReviewResponse, LearnState} from './db';
import {TableView} from './collection';
import { NavigationController, TopBarProvider } from "./navigation";
import { makeButton, makeTag, makeImage } from "./checkbox";

class ExpandedCardUi extends HTMLElement {
  _consumer: Consumer<[Array<Review>, LearnState | undefined]>;
  constructor(ctx: Context, db: FlashCardDb, card_id: string) {
    super();
    const detailsElement = document.createElement('div');
    this.appendChild(detailsElement);
    const historyElement = document.createElement('div');
    this.appendChild(historyElement);
    this._consumer = db.reviewsForCard(card_id).concat(db.learnStateForCard(card_id)).consume((state) => {
      const [reviews, learnState] = state;

      // Update details element
      // easiness_factor":2.6,"review_interval":224640,"scheduled_time
      if (learnState) {
        const easiness = (learnState.easiness_factor - 1.3) / (2.5 - 1.3);
        detailsElement.innerHTML = `
        <hr>
        <table>
        <tr><td>Next Review</td><td>${(new Date(learnState.scheduled_time * 1000)).toLocaleDateString()}</td></tr>
        <tr><td>Interval</td><td>${learnState.review_interval}</td></tr>
        <tr><td>Easiness</td><td>${easiness.toFixed(2)}</td></tr>
        `;
      } else {
        detailsElement.innerHTML = '';
      }

      // Update history element.
      if (reviews.length === 0) {
        historyElement.innerHTML = `<hr>Never reviewed`;
      } else if (reviews.length > 5) {
        historyElement.innerHTML = `<hr>Reviewed ${reviews.length} times`;
      } {
        historyElement.innerHTML = `<hr>`;
      }
      // TODO: add when this is scheduled for.
      for (const review of reviews.slice(0, 5)) {
        const div = document.createElement('div');
        const date = new Date(review.date_created * 1000);
        div.innerText = `${review.response <= ReviewResponse.incorrect_but_easy_to_recall ? "❌" : "✅"} ${review.response} -- ${date.toLocaleString()}`;
        historyElement.appendChild(div);
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
customElements.define('expanded-card-ui', ExpandedCardUi);

class CardCell extends HTMLElement {
  _consumer: Consumer<Card>;
  _lastCard: Card;
  constructor(ctx: Context, db: FlashCardDb, card_id: string, deck: Deck) {
    super();
    this.style.border = '1px solid black';
    this.style.margin = '0.5em';
    this.style.padding = '0.5em';
    this.style.borderRadius = '0.5em';
    this.style.display = 'flex';
    this.style.flexDirection = 'row';

    const cardDiv = document.createElement('div');
    cardDiv.style.flex = '1';
    const frontDiv = document.createElement('div');
    cardDiv.appendChild(frontDiv);
    cardDiv.appendChild(makeTag('hr'));
    const backDiv = document.createElement('div');
    cardDiv.appendChild(backDiv);
    this.appendChild(cardDiv);

    const actionsDiv = document.createElement('div');
    actionsDiv.style.display = 'flex';
    actionsDiv.style.flexDirection = 'column';
    const editButton = makeButton('Edit');
    editButton.addEventListener('click', () => {
      NavigationController.navigation.present(new CardMakerUi(ctx, db, deck, this._lastCard));
    });
    const deleteButton = makeButton('Delete');
    deleteButton.addEventListener('click', () => {
      // TODO.
    });
    actionsDiv.appendChild(editButton);
    actionsDiv.appendChild(deleteButton);
    this.appendChild(actionsDiv);

    db.cardFlowPromise(card_id).then(flow => {
      this._consumer = flow.consume(((card: Card) => {
        this._lastCard = card;
        frontDiv.innerHTML = card.front;
        backDiv.innerHTML = card.back;
      }), 'card cell consume');
      if (this.isConnected) {
        this._consumer.turn_on();
      }
    });
    const historyUi = new ExpandedCardUi(ctx, db, card_id);
    this.addEventListener('click', (e) => {
      const target: HTMLElement = <HTMLElement>e.target;
      if (target.classList.contains('button')) {
        return;
      }
      if (cardDiv.contains(historyUi)) {
        cardDiv.removeChild(historyUi);
      } else {
        cardDiv.appendChild(historyUi);
      }
    });


  }
  connectedCallback() {
    if (this._consumer) {
      this._consumer.turn_on();
    }
  }
  disconnectedCallback() {
    if (this._consumer) {
      this._consumer.turn_off();
    }
  }
}
customElements.define('card-cell', CardCell);

class CardMakerUi extends HTMLElement {
  constructor(ctx: Context, db: FlashCardDb, deck: Deck, card?: Card, front?: string, back?: string) {
    if (card && card.deck_id != deck.deck_id) {
      throw Error('Card must be in the deck');
    }
    if (card && (front || back)) {
      throw Error('Cannot provide both card and front/back');
    }
    const isEditting = !!card;
    super();
    this.style.display = 'flex';
    this.style.flexDirection = 'column';
    const frontElement = document.createElement('textarea');
    frontElement.placeholder = 'Front';
    this.appendChild(frontElement);
    const backElement = document.createElement('textarea');
    backElement.placeholder = 'Back';
    this.appendChild(backElement);

    if (card) {
      frontElement.value = card.front;
      backElement.value = card.back;
    } else {
      if (front) {
        frontElement.value = front;
      }
      if (back) {
        backElement.value = back;
      }
    }

    const initialFront = frontElement.value;
    const initialBack = backElement.value;

    const shouldDisabledButton = () => {
      // If either is empty, or either is the same as its initial value, disable the button.
      const isFrontEmpty = frontElement.value.replace(/\s+/g, '').length === 0;
      const isBackEmpty = backElement.value.replace(/\s+/g, '').length === 0;
      return (isFrontEmpty || isBackEmpty || (frontElement.value === initialFront && backElement.value === initialBack));
    }

    const buttonPanel = document.createElement('div');
    buttonPanel.style.display = 'flex';
    buttonPanel.style.flexDirection = 'row';

    const cancelButton = makeButton('Cancel');
    cancelButton.addEventListener('click', () => {
      NavigationController.navigation.dismiss();
    });
    buttonPanel.appendChild(cancelButton);

    buttonPanel.appendChild(makeTag('div', '', {
      'flex': 1,
    }))

    const saveButton = makeButton('Save');
    saveButton.addEventListener('click', () => {
      if (shouldDisabledButton()) {
        return;
      }
      if (isEditting) {
        db.update_card(card, frontElement.value, backElement.value).then(() => {
          NavigationController.navigation.dismiss();
        });
      } else {
        db.add_card(deck.deck_id, frontElement.value, backElement.value).then(() => {
          NavigationController.navigation.dismiss();
        });
      }
    });
    buttonPanel.appendChild(saveButton);
    const onchange = () => {
      if (shouldDisabledButton()) {
        saveButton.setAttribute('disabled', 'true');
      } else {
        saveButton.removeAttribute('disabled');
      }
    };

    this.appendChild(buttonPanel);

    frontElement.addEventListener('input', onchange);
    backElement.addEventListener('input', onchange);
    onchange();
  }
}
customElements.define('card-maker-ui', CardMakerUi);

class BrowseHeaderUi extends HTMLElement {
  constructor(ctx: Context, db: FlashCardDb, search_fn: (query: string, order: string) => void) {
    super();
    this.style.display = 'flex';
    this.style.flexDirection = 'row';
    this.style.padding = '0 0.5em';
    const searchBar = document.createElement('input');
    searchBar.style.flex = '1';
    searchBar.setAttribute('placeholder', 'Search');
    searchBar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        search_fn(searchBar.value, orderDropdown.value);
      }
    });
    this.appendChild(searchBar);
    const orderDropdown = <HTMLSelectElement>makeTag("select");
    orderDropdown.innerHTML = `
    <option>Oldest</option>
    <option>Newest</option>
    `;
    orderDropdown.addEventListener('change', () => {
      search_fn(searchBar.value, orderDropdown.value);
    });
    this.appendChild(orderDropdown);
  }
}
customElements.define('browse-header-ui', BrowseHeaderUi);

const kNormalize: Map<string, string> = new Map([
  ['ā', 'a'],
  ['á', 'a'],
  ['ǎ', 'a'],
  ['à', 'a'],

  ['ē', 'e'],
  ['é', 'e'],
  ['ě', 'e'],
  ['è', 'e'],

  ['ī', 'i'],
  ['í', 'i'],
  ['ǐ', 'i'],
  ['ì', 'i'],

  ['ō', 'o'],
  ['ó', 'o'],
  ['ǒ', 'o'],
  ['ò', 'o'],

  ['ū', 'u'],
  ['ú', 'u'],
  ['ǔ', 'u'],
  ['ù', 'u'],
]);

function normalize(text: string) {
  return text.split('').map(c => c.toLocaleLowerCase()).map(c => {
    return kNormalize.get(c) || c;
  }).join('');
}

class SearchDataSource {
  _query: StateFlow<string>;
  _order: StateFlow<string>;
  _flow: StateFlow<Array<Card>>;
  constructor(ctx: Context, db: FlashCardDb, deck_id: string) {
    this._query = ctx.create_state_flow('', 'SearchQuery');
    this._order = ctx.create_state_flow('Oldest', 'SearchOrder');
    this._flow = ctx.create_state_flow([], 'SearchDataSource');
    this._flow = this._query.concat2(this._order, db.cardsInDeck(deck_id)).map((value: [string, string, Array<Card>]) => {
      let [query, order, cards] = value;
      query = normalize(query);
      const filteredCards = cards.filter(card => {
        return normalize(card.front).includes(query) || normalize(card.back).includes(query);
      });
      if (order === 'Oldest') {
        filteredCards.sort((a, b) => (a.date_created - b.date_created) || a.card_id.localeCompare(b.card_id));
      } else {
        filteredCards.sort((a, b) => (b.date_created - a.date_created) || b.card_id.localeCompare(a.card_id));
      }
      return filteredCards;
    });
  }
  set query(query: string) {
    this._query.value = query;
  }
  set order(order: string) {
    this._order.value = order;
  }
  get flow() {
    return this._flow;
  }
}

export class BrowseUi extends HTMLElement implements TopBarProvider {
  _landscape: StateFlow<boolean>;
  _topBarItems: StateFlow<Array<HTMLElement>>;
  _searchDataSource: SearchDataSource;
  constructor(ctx: Context, db: FlashCardDb, deck: Deck) {
    super();

    this._searchDataSource = new SearchDataSource(ctx, db, deck.deck_id);

    this.style.overflow = 'hidden';
    this.style.overflowY = 'auto';
    this._landscape = ctx.create_state_flow(false, 'landscape');
    this.appendChild(new BrowseHeaderUi(ctx, db, (query: string, order: string) => {
      this._searchDataSource.query = query;
      this._searchDataSource.order = order;
    }));
    const tableView = new TableView({
      viewForId: (card_id: string) => {
        return new CardCell(ctx, db, card_id, deck);
      }
    }, this._searchDataSource.flow.map((cards: Array<Card>) => {
      return cards.map(card => card.card_id);
    }, 'Card -> ID'));
    tableView.style.maxHeight = '100%';
    this.appendChild(tableView);

    const newCardButton = makeButton(makeImage(new URL('./assets/new-card.png', import.meta.url), {
      'filter': 'brightness(0)',
      'height': '100%',
    }));
    newCardButton.addEventListener('click', () => {
      NavigationController.navigation.present(new CardMakerUi(ctx, db, deck));
    });
    this._topBarItems = ctx.create_state_flow([newCardButton]);
  }
  get topBarItems(): Flow<Array<HTMLElement>> {
    return this._topBarItems;
  }
}
customElements.define('browse-ui', BrowseUi);