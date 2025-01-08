export class Deque<T> {
  _data: Array<(T | undefined)>;
  _start: number = 0;
  _length: number = 0;

  constructor() {
    this._data = new Array(10);
  }
  _double_capacity() {
    const newData = new Array(this._data.length * 2);
    for (let i = 0; i < this._length; ++i) {
      newData[i] = this._data[(this._start + i) % this._data.length];
    }
    this._data = newData;
    this._start = 0;
  }
  _last_index(): number {
    return (this._start + this._length - 1) % this._data.length;
  }
  _first_index(): number {
    return this._start;
  }
  get length() {
    return this._length;
  }
  push_back(value: T) {
    if (this._length === this._data.length) {
      this._double_capacity();
    }
    const i = (this._start + this._length) % this._data.length;;
    this._data[i] = value;
    ++this._length;
  }
  pop_back(): T {
    if (this._length === 0) {
      throw Error('Cannot pop empty collection!');
    }
    const i = this._last_index();
    const value: T = <T>this._data[i];
    this._data[i] = undefined;
    --this._length;
    return value;
  }
  push_front(value: T) {
    if (this._length === this._data.length) {
      this._double_capacity();
    }
    this._start = (this._start - 1 + this._data.length) % this._data.length;
    this._data[this._first_index()] = value;
    ++this._length;
  }
  pop_front(): T {
    if (this._length === 0) {
      throw Error('Cannot pop empty collection!');
    }
    const i = this._first_index();
    const value: T = <T>this._data[i];
    this._data[i] = undefined;
    --this._length;
    this._start = (this._start + 1) % this._data.length;
    return value;
  }
  front(): T | undefined {
    if (this._length === 0) {
      return undefined;
    }
    return <T>this._data[this._first_index()];
  }
}