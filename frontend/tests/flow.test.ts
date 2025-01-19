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