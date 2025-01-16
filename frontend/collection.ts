import {Consumer, Flow} from "./flow";

const gMouse = {
  down: false,
  downPos: {
    'x': 0,
    'y': 0,
  }
};
window.addEventListener('mousedown', (e) => {
  gMouse.down = true;
  gMouse.downPos.x = e.clientX;
  gMouse.downPos.y = e.clientY;
})
window.addEventListener('mouseup', (e) => {
  gMouse.down = false;
})

interface ViewFactoryInterface {
  viewForId(id: string): HTMLElement;
}

interface DiffResults {
  added: Set<string>;
  removed: Set<string>;
  items: Array<string>;
}

function differ() {
  let cache = new Set<string>();
  return (itemsArr: Array<string>) => {
    const itemsSet = new Set(itemsArr);
    const addedItems = itemsArr.filter(item => !cache.has(item));
    const removedItems = Array.from(cache).filter(item => !itemsSet.has(item));
    cache = itemsSet;
    return {
      'added': new Set(addedItems),
      'removed': new  Set(removedItems),
      'items': itemsArr,
    };
  };
}

class TableView extends HTMLElement {
  viewFactory: ViewFactoryInterface;
  content: HTMLElement;
  _consumer: Consumer<DiffResults>;
  _children: Map<string, HTMLElement>;
  constructor(viewFactory: ViewFactoryInterface, idsFlow: Flow<Array<string>>) {
    super();
    this.viewFactory = viewFactory;
    this._children = new Map<string, HTMLElement>();

    this.content = <HTMLDivElement>document.createElement('div');
    this.appendChild(this.content);

    this.content.style.display = 'block';

    this._consumer = idsFlow.map(differ()).consume((deltas: DiffResults) => {
      const addedIds: Set<string> = deltas['added'];
      const removedIds: Set<string> = deltas['removed'];
      const newIds: Array<string> = deltas['items'];
      for (let id of removedIds) {
        const child = this._children.get(id);
        if (!child) {
          console.error('child not found for id', id);
        } else {
          this.content.removeChild(child);
          this._children.delete(id);
        }
      }
      for (let id of newIds) {
        if (addedIds.has(id)) {
          let cell = this.viewFactory.viewForId(id);
          cell.setAttribute('cell-id', id);
          cell.setAttribute('display', 'block');
          this._children.set(id, cell);
        }
        // TODO: more efficiently update the order of cells.
        this.content.appendChild(this._children.get(id));
      }
    }, 'TableView.consumer');
  }
  connectedCallback() {
    this._consumer.turn_on();
  }
  disconnectedCallback() {
    this._consumer.turn_off();
  }
}
customElements.define('table-view', TableView);

export {TableView, ViewFactoryInterface};