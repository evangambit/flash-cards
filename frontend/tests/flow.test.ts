// npx jest frontend/tests/flow.test.ts
// (or just "npx jest")

import assert from 'assert';
import { Context, StateFlow, Flow } from '../flow';

describe('Context', () => {
  it('freeze', () => {
    const outputs: Array<number> = [];
    const ctx = new Context();
    const source = ctx.create_state_flow(0);
    const consumer = source.consume((v) => {
      outputs.push(v);
    });
    consumer.turn_on();
    assert.equal(outputs.length, 0);
    return Promise.resolve()
    .then(() => {
      assert.equal(outputs.length, 1);
      source.value = 1;
      return Promise.resolve();
    })
    .then(() => {
      assert.equal(outputs.length, 2);
      ctx.freeze();
      source.value = 2;
      return Promise.resolve();
    })
    .then(() => {
      assert.equal(outputs.length, 2);
      ctx.thaw();
      return Promise.resolve();
    })
    .then(() => {
      assert.equal(outputs.length, 3);
      source.value = 3;
    })
    .then(() => {
      assert.deepEqual(outputs, [0, 1, 2, 3]);
    });
  });
});

describe('Map', () => {
  it('map', () => {
    const outputs: Array<number> = [];
    const ctx = new Context();
    const source = ctx.create_state_flow(0);
    const mapped = source.map((v) => v + 1);
    const consumer = mapped.consume((v) => {
      outputs.push(v);
    });
    consumer.turn_on();
    assert.equal(outputs.length, 0);
    return Promise.resolve()
    .then(() => {
      assert.equal(outputs.length, 1);
      source.value = 1;
      return Promise.resolve();
    })
    .then(() => {
      assert.equal(outputs.length, 2);
      source.value = 2;
      return Promise.resolve();
    })
    .then(() => {
      assert.deepEqual(outputs, [1, 2, 3]);
    });
  });
});

describe('Concat', () => {
  it('concat', () => {
    const outputs: Array<[number, number]> = [];
    const ctx = new Context();
    const source1 = ctx.create_state_flow(0);
    const source2 = ctx.create_state_flow(0);
    const concated = source1.concat(source2);
    const consumer = concated.consume((values) => {
      outputs.push(values);
    });
    consumer.turn_on();
    assert.equal(outputs.length, 0);
    return Promise.resolve()
    .then(() => {
      assert.equal(outputs.length, 1);
      source1.value = 1;
      return Promise.resolve();
    })
    .then(() => {
      assert.equal(outputs.length, 2);
      source2.value = 2;
      return Promise.resolve();
    })
    .then(() => {
      assert.equal(outputs.length, 3);
      source1.value = 3;
      source2.value = 3;
      return Promise.resolve();
    })
    .then(() => {
      assert.equal(outputs.length, 4);
      source2.value = 4;
      return Promise.resolve();
    })
    .then(() => {
      assert.deepEqual(outputs, [[0, 0], [1, 0], [1, 2], [3, 3], [3, 4]]);
    });
  });
});

describe('DistinctUntilChanged', () => {
  it('distinct', () => {
    const outputsBefore: Array<number> = [];
    const outputsAfter: Array<number> = [];
    const ctx = new Context();
    const source = ctx.create_state_flow(0);
    const distinct = source.distinctUntilChanged((a, b) => {
      return a == b;
    })
    const consumeBeforeDistinct = source.consume((value: number) => {
      outputsBefore.push(value);
    });
    const consumerAfterDistinct = distinct.consume((value: number) => {
      outputsAfter.push(value);
    });
    consumeBeforeDistinct.turn_on();
    consumerAfterDistinct.turn_on();
    assert.equal(outputsBefore.length, 0);
    assert.equal(outputsAfter.length, 0);
    return Promise.resolve()  // Wait for flows to be processed.
    .then(() => {
      assert.deepEqual(outputsBefore, [0]);
      assert.deepEqual(outputsAfter, [0]);
      source.value = 1;
      return Promise.resolve();
    })
    .then(() => {
      assert.deepEqual(outputsBefore, [0, 1]);
      assert.deepEqual(outputsAfter, [0, 1]);
      source.value = 1;
      return Promise.resolve();
    })
    .then(() => {
      assert.deepEqual(outputsBefore, [0, 1, 1]);
      assert.deepEqual(outputsAfter, [0, 1]);
      source.value = 1;
      return Promise.resolve();
    });
  })
});

describe('Flow', () => {
  it('ignore-synchronous', () => {
    const outputs: Array<number> = [];
    const ctx = new Context();
    const source = ctx.create_state_flow(0);
    const consumer = source.consume((v) => {
      outputs.push(v);
    });
    consumer.turn_on();
    source.value = 1;
    source.value = 2;
    assert.equal(outputs.length, 0);
    return Promise.resolve()
    .then(() => {
      assert.deepEqual(outputs, [2]);
    });
  });
});

function externalPromise<T>(): { promise: Promise<T>, resolve: (value: T) => void, reject: (reason?: any) => void } {
  let resolve, reject;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resolveAfter<T>(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

describe('MapAsync', () => {
  it('asyncMap', () => {
    const outputs: Array<number> = [];
    const ctx = new Context();
    const source = ctx.create_state_flow(0);
    const promises = [
      externalPromise<number>(),
      externalPromise<number>(),
      externalPromise<number>(),
      externalPromise<number>()
    ];
    const consumer = source.mapAsync((index: number) => {
      setTimeout(() => {
        promises[index].resolve(index);
      }, 10);  // Every function takes 10ms to resolve.
      return promises[index].promise;
    }, -1).consume((v) => {
      outputs.push(v);
    });
    consumer.turn_on();
    return Promise.resolve()
    .then(() => {
      assert.deepEqual(outputs, [-1]);
      return Promise.resolve();
    })
    .then(() => {
      // The first promise hasn't resolved yet.
      assert.deepEqual(outputs, [-1]);
      return resolveAfter(20);  // Wait for the first promise to resolve.
    })
    .then(() => {
      assert.deepEqual(outputs, [-1, 0]);
      source.value = 1;
    })
    .then(() => {
      // The second promise hasn't resolved yet (it began 0ms ago).
      return Promise.resolve();
    })
    .then(() => {
      // The second promise is still pending.
      assert.deepEqual(outputs, [-1, 0]);
      return resolveAfter(20);  // Wait for the second promise to resolve.
    })
    .then(() => {
      assert.deepEqual(outputs, [-1, 0, 1]);
      // Now test that interrupted asyncMap works correctly.
      source.value = 2;
      return resolveAfter(5);
    })
    .then(() => {
      // The third promise hasn't resolved yet.
      assert.deepEqual(outputs, [-1, 0, 1]);
      source.value = 3;
      return resolveAfter(20);  // Wait for the fourth promise to resolve.
    })
    .then(() => {
      assert.deepEqual(outputs, [-1, 0, 1, 3]);
    })
  }); 
});
