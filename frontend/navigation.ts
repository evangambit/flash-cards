import { Context, Consumer, Flow, StateFlow } from "./flow";
import { makeButton, makeImage } from "./checkbox";

function iff<T>(condition: T | undefined | null, f: (arg: T) => void) {
  if (condition) {
    f(<T>condition);
  }
}

export interface TopBarProvider {
  // A flow that provides the items to be displayed in the top bar.
  // IMPORTANT: This flow must be constant (though, of course, its value may change).
  topBarItems: Flow<Array<HTMLElement>>;
}

export class NavigationView extends HTMLElement {
  _baseTopBarItems: StateFlow<Array<HTMLElement>>;
  _topBarProviders: Array<Flow<Array<HTMLElement>>>;
  _topbarConsumer: Consumer<Array<HTMLElement>>;
  _stackFlow: StateFlow<Array<HTMLElement>>;
  _topbar: HTMLDivElement;
  _content: HTMLDivElement;
  _ctx: Context;
  constructor(ctx: Context, rootView: HTMLElement, topbarButtons: Array<HTMLElement>) {
    super();
    this._ctx = ctx;
    this._stackFlow = ctx.create_state_flow([]);
    this._topbar = <HTMLDivElement>document.createElement('div');
    this._content = <HTMLDivElement>document.createElement('div');
    this.appendChild(this._topbar);
    this.appendChild(this._content);
    this._topBarProviders = [];
    this.style.display = "flex";
    this.style.flexDirection = "column";
    this.style.position = "relative";
    this.style.left = "0";
    this.style.top = "0";
    this.style.width = "100%";
    this.style.height = "100%";

    this._topbar.style.display = 'flex';
    this._topbar.style.flexDirection = 'row';
    this._topbar.style.maxWidth = "30em";
    this._topbar.style.position = "relative";
    this._topbar.style.left = "50%";
    this._topbar.style.top = "0";
    this._topbar.style.transform = "translate(-50%, 0)";
    this._topbar.classList.add('topbar');

    this._content.style.flex = '1';
    this._content.style.position = "relative";
    this._content.style.left = "50%";
    this._content.style.top = "0";
    this._content.style.width = "100%";
    this._content.style.maxWidth = "30em";
    this._content.style.height = "100%";
    this._content.style.transform = "translate(-50%, 0)";

    const backButton = makeButton(makeImage(new URL('./assets/back.png', import.meta.url), {
      'height': '100%',
    }));
    backButton.addEventListener('click', () => {
      this.pop();
    })
    this._baseTopBarItems = ctx.create_state_flow((topbarButtons));
    this.addEventListener('stack-change', () => {
      if (this.length > 1) {
        if (!this._baseTopBarItems.value.includes(backButton)) {
          this._baseTopBarItems.value = [backButton].concat(this._baseTopBarItems.value);
        }
      } else {
        if (this._baseTopBarItems.value.includes(backButton)) {
          this._baseTopBarItems.value = this._baseTopBarItems.value.filter(element => element !== backButton);
        }
      }
    });

    this._topBarProviders.push(this._baseTopBarItems);
    this.push(rootView);
    this._updateTopBar();
  }
  _updateTopBar() {
    if (this._topbarConsumer) {
      this._topbarConsumer.turn_off();
      this._topbarConsumer = null;
    }
    const flow: Flow<Array<HTMLElement>> = this._ctx.flatten(this._topBarProviders);
    this._topbarConsumer = flow.consume((elements: Array<HTMLElement>) => {
      this._topbar.innerHTML = '';
      for (let element of elements) {
        this._topbar.appendChild(element);
      }
    });
    if (this.isConnected) {
      this._topbarConsumer.turn_on();
    }
  }
  get length() {
    return this._content.children.length;
  }
  get stackFlow(): Flow<Array<HTMLElement>> {
    return this._stackFlow;
  }
  push(view: HTMLElement) {
    const oldTopView = this._content.lastElementChild;
    iff(this._content.lastElementChild, (lastChild) => {
      (<HTMLElement>lastChild).style.display = "none";
    });

    view.style.display = "block";
    view.style.position = "absolute";
    view.style.left = "50%";
    view.style.top = "50%";
    view.style.transform = "translate(-50%, -50%)";
    view.style.width = "100%";
    view.style.maxHeight = "100%";
    this._content.appendChild(view);
    this.dispatchEvent(new CustomEvent("stack-change", {
      detail: {
        oldTopView: oldTopView,
        newTopView: view,
      }
    }));
    this._stackFlow.value = <Array<HTMLElement>>Array.from(this._content.children);
    if ((<any>view).topBarItems) {
      this._topBarProviders.push((<any>view).topBarItems);
      this._updateTopBar();
    }
  }
  pop() {
    const removedChild = this._content.lastElementChild;
    iff(this._content.lastElementChild, (lastChild) => {
      this._content.removeChild(lastChild);
    });
    iff(this._content.lastElementChild, (lastChild) => {
      (<HTMLElement>lastChild).style.display = "block";
    });
    this.dispatchEvent(new CustomEvent("stack-change", {
      detail: {
        newTopView: this._content.lastElementChild,
        oldTopView: removedChild,
      }
    }));
    this._stackFlow.value = <Array<HTMLElement>>Array.from(this._content.children);
    if ((<any>removedChild).topBarItems) {
      this._topBarProviders.pop();
      this._updateTopBar();
    }
  }
  present(view: HTMLElement) {
    view.style.position = "absolute";
    view.style.left = "50%";
    view.style.top = "50%";
    view.style.transform = "translate(-50%, -50%)";
    view.style.maxWidth = "30em";
    view.style.maxHeight = "30em";

    const background = document.createElement('div');
    background.style.position = "fixed";
    background.style.left = "0";
    background.style.top = "0";
    background.style.width = "100%";
    background.style.height = "100%";
    background.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
    background.style.zIndex = "100";
    background.appendChild(view);
    this.appendChild(background);
  }
  dismiss() {
    if (this.lastElementChild === this._content) {
      throw Error("No view to dismiss");
    }
    this.removeChild(this.lastElementChild);
  }
  static above(view: HTMLElement): NavigationView {
    let parent = view.parentElement;
    while (parent && !(parent instanceof NavigationView)) {
      parent = parent.parentElement;
    }
    if (!parent) {
      throw Error("No NavigationView found");
    }
    return <NavigationView>parent;
  }
  connectedCallback() {
    this._topbarConsumer.turn_on();
  }
  disconnectedCallback() {
    this._topbarConsumer.turn_off();
  }
}
customElements.define("navigation-view", NavigationView);