class UniqueMinQueue<T> {
  f: (a: T) => number;
  queue: T[];
  contains: Set<T>;

  constructor(f: (a: T) => number) {
    this.f = f;
    this.contains = new Set();
    this.queue = [];
  }

  push(value: T) {
    if (this.contains.has(value)) {
      return;
    }
    this.contains.add(value);
    this.queue.push(value);
    this._bubbleUp(this.queue.length - 1);
  }

  get length(): number {
    return this.queue.length;
  }

  pop(): T {
    if (this.queue.length === 0) {
      throw new Error("Queue is empty");
    }
    const result = this.queue[0];
    this.contains.delete(result);
    if (this.queue.length > 1) {
      this.queue[0] = <T>(this.queue.pop());
      this._bubbleDown(0);
    } else {
      this.queue.pop();
    }
    return result;
  }

  _bubbleUp(index: number) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.f(this.queue[parentIndex]) <= this.f(this.queue[index])) {
        break;
      }
      this._swap(parentIndex, index);
      index = parentIndex;
    }
  }

  _bubbleDown(index: number) {
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = index * 2 + 2;
      let nextIndex = index;
      if (
        leftIndex < this.queue.length &&
        this.f(this.queue[leftIndex]) < this.f(this.queue[nextIndex])
      ) {
        nextIndex = leftIndex;
      }
      if (
        rightIndex < this.queue.length &&
        this.f(this.queue[rightIndex]) < this.f(this.queue[nextIndex])
      ) {
        nextIndex = rightIndex;
      }
      if (nextIndex === index) {
        break;
      }
      this._swap(index, nextIndex);
      index = nextIndex;
    }
  }

  _swap(i: number, j: number) {
    const temp = this.queue[i];
    this.queue[i] = this.queue[j];
    this.queue[j] = temp;
  }
}

export {UniqueMinQueue};
