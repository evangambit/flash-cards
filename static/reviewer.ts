import {Flow, Consumer, Context, StateFlow} from "./flow";
import {FlashCardDb, Deck, Card, ReviewResponse} from "./db";
import {ReviewQueue, ReviewQueueState, ReviewQueueStateEnum} from "./review_queue";

export interface ButtonUiState {
  text: string;
  enabled: boolean;
  onClick: () => void;
}

export interface CardUiState {
  content: string;
  flip: () => void | undefined;
}

export class ReviewerActionHandler {
  show_back_of_card(card_id: string): void {
    throw Error('Should be implemented by subclass');
  }
  mark_reviewed(card_id: string, response: ReviewResponse): void {
    throw Error('Should be implemented by subclass');
  }
}

class CardUi extends HTMLElement {
  _content: HTMLElement;
  _showHistoryButton: HTMLButtonElement;
  _consumer: Consumer<CardUiState | undefined>;
  constructor(flow: Flow<CardUiState | undefined>) {
    super();
    this._content = document.createElement('DIV');
    this.appendChild(this._content);
    this.style.border = 'solid black 1px';
    this.style.borderRadius = '0.5em';
    this.style.padding = '0.5em';
    this.style.margin = '0.5em';
    this.style.userSelect = 'none';
    this.addEventListener('click', () => {
      if (flow.value.flip) {
        flow.value.flip();
      }
    });
    this._consumer = flow.consume((uiState: (CardUiState | undefined)) => {
      if (uiState === undefined) {
        this._content.innerText = '';
        this.style.display = 'none';
        return;
      }
      this.style.cursor = uiState.flip ? 'pointer' : 'default';
      this._content.innerText = uiState.content;
      this.style.display = 'block';
    }, 'ReviewCardUi.consume');
  }
  connectedCallback() {
    this._consumer.turn_on();
  }
  disconnectedCallback() {
    this._consumer.turn_off();
  }
}
customElements.define('card-ui', CardUi);

export interface ReviewerUiState {
  card_ui_state: CardUiState | undefined;
  buttons: Array<ButtonUiState>;
  numRemainingCards: number;
  action_handler: ReviewerActionHandler;
}

export class ReviewerViewModel {
  get flow(): Flow<ReviewerUiState> {
    throw Error('Should be implemented by subclass');
  }
}

class ButtonPanel extends HTMLElement {
  _consumer: Consumer<Array<ButtonUiState>>;
  constructor(flow: Flow<Array<ButtonUiState>>) {
    super();
    this._consumer = flow.consume((buttons: Array<ButtonUiState>) => {
      this.innerHTML = '';
      buttons.forEach((button: ButtonUiState) => {
        const buttonElement = document.createElement('button');
        buttonElement.innerText = button.text;
        buttonElement.disabled = !button.enabled;
        buttonElement.onclick = () => {
          buttonElement.setAttribute('disabled', 'true');
          button.onClick();
        };
        this.appendChild(buttonElement);
      });
    }, 'ButtonPanel.consume');
  }
  connectedCallback() {
    this._consumer.turn_on();
  }
  disconnectedCallback() {
    this._consumer.turn_off();
  }
}
customElements.define('button-panel', ButtonPanel);

export class ReviewerUi extends HTMLElement {
  _viewModel: ReviewerViewModel;

  _remainingDiv: HTMLElement;
  _cardUi: CardUi;
  _buttonPanel: ButtonPanel;

  _consumer: Consumer<ReviewerUiState>;
  constructor(viewModel: ReviewerViewModel) {
    super();
    this._viewModel = viewModel;

    this.style.display = 'flex';
    this.style.flexDirection = 'column';

    this._remainingDiv = document.createElement('div');
    this.appendChild(this._remainingDiv);

    this._cardUi = new CardUi(viewModel.flow.map((state: ReviewerUiState) => state.card_ui_state));
    this.appendChild(this._cardUi);

    this._buttonPanel = new ButtonPanel(viewModel.flow.map((state: ReviewerUiState) => state.buttons));
    this.appendChild(this._buttonPanel);

    this._consumer = viewModel.flow.consume((state: ReviewerUiState) => {
      this._remainingDiv.innerText = `Remaining: ${state.numRemainingCards}`;
    });
  }
  connectedCallback() {
    this._consumer.turn_on();
  }
  disconnectedCallback() {
    this._consumer.turn_off();
  }
}
customElements.define('reviewer-ui', ReviewerUi);

export class ReviewerViewModelImpl extends ReviewerViewModel implements ReviewerActionHandler {
  _deck: Deck;
  _db: FlashCardDb;
  _queue: ReviewQueue;
  _flow: Flow<ReviewerUiState>;
  _isFlipped: StateFlow<boolean>;
  constructor(deck: Deck, db: FlashCardDb, ctx: Context, dismiss: () => void) {
    super();
    this._deck = deck;
    this._db = db;
    this._queue = new ReviewQueue(deck, db, ctx);
    this._isFlipped = ctx.create_state_flow(false);
    this._flow = this._queue.state.map2(this._isFlipped, (queueState: ReviewQueueState, isFlipped: boolean): ReviewerUiState => {
      if (queueState.state === ReviewQueueStateEnum.loadingCards) {
        return {
          card_ui_state: undefined,
          buttons: [],
          numRemainingCards: queueState.numRemainingCards,
          action_handler:   this,
        };
      }
      if (queueState.state === ReviewQueueStateEnum.queueExhaused) { 
        const buttons: Array<ButtonUiState> = [
          {
            text: 'Home',
            enabled: true,
            onClick: () => {
              dismiss();
            }
          },
          {
            text: 'GIMME MOAR',
            enabled: true,
            onClick: () => {
              this._queue.load_more();
            }
          },
        ];
        return {
          card_ui_state: undefined,
          buttons: buttons,
          numRemainingCards: queueState.numRemainingCards,
          action_handler: this
        };
      }
      const card: Card = queueState.currentCard;
      if (!card) {
        throw Error('missing card');
      }

      let buttons: Array<ButtonUiState> = [];
      if (isFlipped) {
        const loadNext = (result: ReviewResponse) => {
          this._isFlipped.value = false;
          this.mark_reviewed(card.card_id, result);
          this._queue.next();
        };
        buttons = buttons.concat([
          {
            text: "Easy! (1)",
            enabled: true,
            onClick: () => {
              loadNext(ReviewResponse.perfect);
            },
          },
          {
            text: "Correct (2)",
            enabled: true,
            onClick: () => {
              loadNext(ReviewResponse.correct_after_hesitation);
            },
          },
          {
            text: "Hard (3)",
            enabled: true,
            onClick: () => {
              loadNext(ReviewResponse.correct_with_serious_difficulty);
            },
          },
          {
            text: "Wrong (but close!) (4)",
            enabled: true,
            onClick: () => {
              loadNext(ReviewResponse.incorrect_but_easy_to_recall);
            },
          },
          {
            text: "Fail (5)",
            enabled: true,
            onClick: () => {
              loadNext(ReviewResponse.complete_blackout);
            },
          },
        ]);
      }

      const cardUiState: CardUiState = {
        content: isFlipped ? card.back : card.front,
        flip: isFlipped ? undefined : () => { this.show_back_of_card(card.card_id); }
      };
      return {
        card_ui_state: cardUiState,
        buttons: buttons,
        numRemainingCards: queueState.numRemainingCards,
        action_handler: this
      };
    }, 'ReviewerViewModel.flow');
  }
  get flow(): Flow<ReviewerUiState> {
    return this._flow;
  }

  show_back_of_card(card_id: string) {
    this._isFlipped.value = true;
  }
  mark_reviewed(card_id: string, response: ReviewResponse) {
    this._db.add_review_and_update_learn_state(card_id, this._deck.deck_id, response);
  }
}