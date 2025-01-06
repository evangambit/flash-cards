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

export function makeButton(text: string): HTMLElement {
  const button = document.createElement('div');
  button.classList.add('button');
  button.setAttribute('tabIndex', '0');
  button.innerText = text;
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

export function makeTag(tagName: string, content?: string): HTMLElement {
  let tag = document.createElement(tagName);
  if (content) {
    tag.innerText = content;
  }
  return tag;
}