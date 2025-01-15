import {Context, Flow, Consumer, StateFlow} from "./flow";
import {FlashCardDb, Deck, Card, Review, ReviewResponse, LearnState} from './db';
import {TableView} from './collection';
import { NavigationController, TopBarProvider } from "./navigation";
import { makeButton, makeTag, makeImage } from "./checkbox";

interface BrowseUiState {
  cards: Array<Card>;
}

class ExpandedCardUi extends HTMLElement {
  _consumer: Consumer<[Array<Review>, LearnState | undefined]>;
  _detailsElement: HTMLElement;
  _historyElement: HTMLElement;
  constructor(ctx: Context, db: FlashCardDb, card_id: string) {
    super();
    this._detailsElement = document.createElement('div');
    this.appendChild(this._detailsElement);
    this._historyElement = document.createElement('div');
    this.appendChild(this._historyElement);
    this._consumer = db.reviewsForCard(card_id).concat(db.learnStateForCard(card_id)).consume((state) => {
      const [reviews, learnState] = state;

      // Update details element
      // easiness_factor":2.6,"review_interval":224640,"scheduled_time
      if (learnState) {
        const easiness = (learnState.easiness_factor - 1.3) / (2.5 - 1.3);
        this._detailsElement.innerHTML = `
        <hr>
        <table>
        <tr><td>Next Review</td><td>${(new Date(learnState.scheduled_time * 1000)).toLocaleDateString()}</td></tr>
        <tr><td>Interval</td><td>${learnState.review_interval}</td></tr>
        <tr><td>Easiness</td><td>${easiness.toFixed(2)}</td></tr>
        `;
      } else {
        this._detailsElement.innerHTML = '';
      }

      // Update history element.
      if (reviews.length === 0) {
        this._historyElement.innerHTML = `<hr>Never reviewed`;
      } else if (reviews.length > 5) {
        this._historyElement.innerHTML = `<hr>Reviewed ${reviews.length} times`;
      } {
        this._historyElement.innerHTML = `<hr>`;
      }
      // TODO: add when this is scheduled for.
      for (let review of reviews.slice(0, 5)) {
        const div = document.createElement('div');
        const date = new Date(review.date_created * 1000);
        div.innerText = `${review.response <= ReviewResponse.incorrect_but_easy_to_recall ? "❌" : "✅"} ${review.response} -- ${date.toLocaleString()}`;
        this._historyElement.appendChild(div);
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
  _historyUi: ExpandedCardUi;
  _consumer: Consumer<Card>;
  _cardDiv: HTMLElement;
  _actionsDiv: HTMLElement;
  _lastCard: Card;
  constructor(ctx: Context, db: FlashCardDb, card_id: string, deck: Deck) {
    super();
    this.style.border = '1px solid black';
    this.style.margin = '0.5em';
    this.style.padding = '0.5em';
    this.style.borderRadius = '0.5em';
    this.style.display = 'flex';
    this.style.flexDirection = 'row';

    this._cardDiv = document.createElement('div');
    this._cardDiv.style.flex = '1';
    let frontDiv = document.createElement('div');
    this._cardDiv.appendChild(frontDiv);
    this._cardDiv.appendChild(makeTag('hr'));
    let backDiv = document.createElement('div');
    this._cardDiv.appendChild(backDiv);
    this.appendChild(this._cardDiv);

    this._actionsDiv = document.createElement('div');
    this._actionsDiv.style.display = 'flex';
    this._actionsDiv.style.flexDirection = 'column';
    const editButton = makeButton('Edit');
    editButton.addEventListener('click', () => {
      NavigationController.navigation.present(new CardMakerUi(ctx, db, deck, this._lastCard));
    });
    const deleteButton = makeButton('Delete');
    deleteButton.addEventListener('click', () => {
    });
    this._actionsDiv.appendChild(editButton);
    this._actionsDiv.appendChild(deleteButton);
    this.appendChild(this._actionsDiv);

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
    this._historyUi = new ExpandedCardUi(ctx, db, card_id);
    this.addEventListener('click', (e) => {
      const target: HTMLElement = <HTMLElement>e.target;
      if (target.classList.contains('button')) {
        return;
      }
      if (this._cardDiv.contains(this._historyUi)) {
        this._cardDiv.removeChild(this._historyUi);
      } else {
        this._cardDiv.appendChild(this._historyUi);
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
  constructor(ctx: Context, db: FlashCardDb) {
    super();
    this.style.display = 'flex';
    this.style.flexDirection = 'row';
    this.style.padding = '0 0.5em';
    const searchBar = document.createElement('input');
    searchBar.style.flex = '1';
    searchBar.setAttribute('placeholder', 'Search');
    this.appendChild(searchBar);
    const orderDropdown = makeButton('O');
    this.appendChild(orderDropdown);
  }
}
customElements.define('browse-header-ui', BrowseHeaderUi);

export class BrowseUi extends HTMLElement implements TopBarProvider {
  _landscape: StateFlow<boolean>;
  _topBarItems: StateFlow<Array<HTMLElement>>;
  constructor(ctx: Context, db: FlashCardDb, deck: Deck) {
    super();

    const cardsFlow = db.cardsInDeck(deck.deck_id);

    this.style.overflow = 'hidden';
    this.style.overflowY = 'auto';
    this._landscape = ctx.create_state_flow(false, 'landscape');
    this.appendChild(new BrowseHeaderUi(ctx, db));
    let tableView = new TableView({
      viewForId: (card_id: string) => {
        return new CardCell(ctx, db, card_id, deck);
      }
    }, cardsFlow.map((cards: Array<Card>) => {
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