import {Flow, Consumer} from "./flow";

export class CheckboxUi extends HTMLElement {
  _checkbox: HTMLInputElement;
  _consumer: Consumer<boolean>;
  constructor(viewModel: Flow<boolean>, toggle: () => void) {
    super();
    this._checkbox = <HTMLInputElement>document.createElement('INPUT');
    this._checkbox.type = 'checkbox';
    this.appendChild(this._checkbox);
    this._consumer = viewModel.consume((value: boolean) => {
      this._checkbox.checked = value;
    });
    this._checkbox.addEventListener('change', () => {
      toggle();
    });
  }
  connectedCallback() {
    this._consumer.turn_on();
  }
  disconnectedCallback() {
    this._consumer.turn_off();
  }
}
customElements.define('checkbox-ui', CheckboxUi);

export function makeImage(src: URL, style: any = {}): HTMLImageElement {
  const element = <HTMLImageElement>document.createElement('img');
  element.src = src.href;
  for (let k in style) {
    element.style[k] = style[k];
  }
  return element;
}

export function makeButton(content: (string | HTMLElement), style: any = {}): HTMLElement {
  const button = document.createElement('div');
  button.classList.add('button');
  button.setAttribute('tabIndex', '0');
  if (typeof(content) === "string") {
    button.innerText = content;
  } else {
    button.appendChild(content);
  }
  for (let k in style) {
    button.style[k] = style[k];
  }
  // Listen for disable attribute changes
  const observer = new MutationObserver((mutationsList, observer) => {
    const disabled = button.hasAttribute('disabled');
    if (disabled) {
      button.classList.add('disabled');
      button.removeAttribute('tabIndex');
    } else {
      button.classList.remove('disabled');
      button.setAttribute('tabIndex', '0');
    }
  });
  return button;
}

// Click button with hotkey
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const button = document.activeElement;
    if (button instanceof HTMLElement && button.classList.contains('button')) {
      button.click();
    }
  }
});

export function makeTag(tagName: string, content?: string, style = {}): HTMLElement {
  let tag = document.createElement(tagName);
  if (content) {
    tag.innerText = content;
  }
  for (let k in style) {
    tag.style[k] = style[k];
  }
  return tag;
}