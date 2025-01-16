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

export class NavigationController extends EventTarget {
  _baseTopBarItems: StateFlow<Array<HTMLElement>>;
  _topBarProviders: Array<Flow<Array<HTMLElement>>>;
  _topbarConsumer: Consumer<Array<HTMLElement>>;
  _stackFlow: StateFlow<Array<HTMLElement>>;
  _topbar: HTMLDivElement;
  _content: HTMLDivElement;
  _ctx: Context;
  constructor(ctx: Context, topbarButtons: Flow<Array<HTMLElement>>) {
    super();
    this._ctx = ctx;
    this._stackFlow = ctx.create_state_flow([]);
    this._topbar = <HTMLDivElement>document.createElement('div');
    this._content = <HTMLDivElement>document.createElement('div');
    document.body.appendChild(this._topbar);
    document.body.appendChild(this._content);
    this._topBarProviders = [];
    document.body.style.display = "flex";
    document.body.style.flexDirection = "column";
    document.body.style.position = "relative";
    document.body.style.left = "0";
    document.body.style.top = "0";
    document.body.style.width = "100%";
    document.body.style.height = "100%";

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
    this._content.style.display = 'flex';
    this._content.style.width = "100%";
    this._content.style.maxWidth = "30em";
    this._content.style.transform = "translate(-50%, 0)";

    const backButton = makeButton(makeImage(new URL('./assets/back.png', import.meta.url), {
      'height': '100%',
    }));
    backButton.addEventListener('click', () => {
      this.pop();
    })
    this._baseTopBarItems = topbarButtons;

    const backButtonFlow = ctx.create_state_flow(<Array<HTMLElement>>[], 'BackButton');
    this.addEventListener('stack-change', () => {
      if (this.length > 1) {
        backButtonFlow.value = [backButton];
      } else {
        backButtonFlow.value = [];
      }
    });

    this._topBarProviders.push(backButtonFlow);
    this._topBarProviders.push(this._baseTopBarItems);
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
    this._topbarConsumer.turn_on();
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

    view.style.flex = '1';
    view.style.width = "100%";
    this._content.appendChild(view);
    this.dispatchEvent(new CustomEvent("stack-change", {
      detail: {
        oldTopView: oldTopView,
        newTopView: view,
        stack: Array.from(this._content.children),
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
        stack: Array.from(this._content.children),
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
    document.body.appendChild(background);
  }
  dismiss() {
    if (document.body.lastElementChild === this._content) {
      throw Error("No view to dismiss");
    }
    document.body.removeChild(document.body.lastElementChild);
  }
  static navigation: NavigationController;
}
