import {FlashCardDb, LearnState} from './db';
import {Deck, Card, get_now} from './sync';
import {Deque} from './deque';
import {Context, StateFlow} from "./flow";

export enum ReviewQueueStateEnum {
  hasCard,
  queueExhaused,
  loadingCards,
};

export class ReviewQueueState {
  state: ReviewQueueStateEnum;
  outOfCards: boolean;
  currentCard: (Card|undefined);
  nextCardId: (string|undefined);
  numRemainingCards: number;
  constructor(state: ReviewQueueStateEnum, currentCard: (Card|undefined), nextCardId: (string|undefined), numRemainingCards: number) {
    this.state = state;
    this.currentCard = currentCard;
    this.nextCardId = nextCardId;
    this.numRemainingCards = numRemainingCards;
  }
  static create(currentCard: (Card|undefined), nextCardId: (string|undefined), numRemainingCards: number) {
    return new ReviewQueueState(ReviewQueueStateEnum.hasCard, currentCard, nextCardId, numRemainingCards);
  }
  static exhausted(): ReviewQueueState {
    return new ReviewQueueState(ReviewQueueStateEnum.queueExhaused, undefined, undefined, 0);
  }
  static loading(): ReviewQueueState {
    return new ReviewQueueState(ReviewQueueStateEnum.loadingCards, undefined, undefined, 0);
  }
}
export class ReviewQueue {
  _db: FlashCardDb;
  _deck: Deck;
  _state: StateFlow<ReviewQueueState>;
  _queue: Deque<Card>;
  constructor(deck: Deck, db: FlashCardDb, ctx: Context) {
    this._db = db;
    this._deck = deck;
    this._state = ctx.create_state_flow(ReviewQueueState.loading());
    this._queue = new Deque<Card>();
    this.load_more();
  }
  load_more() {
    return this._get_upcoming_card_ids(this._deck.deck_id)
    .then((response) => {
      const upcomingCards = response.cards;
      const promises: Promise<Card>[] = upcomingCards.map(card_id => this._db.get_card(card_id));
      return Promise.all(promises);
    })
    .then((upcomingCards: Array<Card>) => {
      for (let card of upcomingCards) {
        this._queue.push_back(card);
      }
      this.next();
    });
  }
  _get_upcoming_card_ids(deck_id: string): Promise<{cards: Array<string>, overdue: boolean}> {
    return this._db.get_learn_states_for_deck(deck_id).then((learnStates: Array<LearnState>) => {
      const now = get_now();
      learnStates.sort((a, b) => a.scheduled_time - b.scheduled_time);
      const overdue = learnStates.filter(learnState => now > learnState.scheduled_time);
      if (overdue.length > 0) {
        return {
          cards: overdue.map(card => card.card_id),
          overdue: true,
        };
      }
      return {
        cards: learnStates.slice(0, 10).map(learnState => learnState.card_id),
        overdue: false,
      };
    });
  }
  get state() {
    return this._state;
  }
  next() {
    if (this._queue.length === 0) {
      this._state.value = ReviewQueueState.exhausted();
      return;
    }
    let card = this._queue.pop_front();
    if (!card) {
      throw Error('no card from queue');
    }
    const next = this._queue.front();
    this._state.value = ReviewQueueState.create(card, next ? next.card_id : undefined, this._queue.length + 1);
  }
}