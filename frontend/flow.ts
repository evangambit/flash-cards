import { Deque } from "./deque";
import { UniqueMinQueue } from "./unique_min_queue";

/**
 * Represents a flow in the system.
 * @template T The type of the value held by the flow.
 */
export class Flow<T> {
  _context: Context;
  _id: number;
  _sources: Array<Flow<any>>;
  _destinations: Array<WeakRef<Flow<any>>>;
  _name: string;
  _on: boolean;
  // Note: If an "on" descendant is garbage collected, _numLiveDescendants may be incorrect.
  //       We take the easy way out: users must guarantee "on" flows are never deleted.
  _numLiveDescendants: number;
  _value: T;

  /**
   * Creates a new Flow instance.
   * @param {Context} context - The context in which the flow operates.
   * @param {Array<Flow<any>>} sources - The source flows for this flow.
   * @param {string} [name] - The optional name of the flow.
   */
  constructor(context: Context, sources: Array<Flow<any>>, name?: string) {
    this._context = context;
    this._id = context.flowCount++;
    this._sources = sources;
    this._destinations = [];
    this._name = `${name || "Flow"}#${this._id}`;
    this._on = false;
    this._numLiveDescendants = 0;
    for (let source of sources) {
      source._destinations.push(new WeakRef(this));
    }
  }

  /**
   * Gets the name of the flow.
   * @returns {string} The name of the flow.
   */
  get name(): string {
    return this._name;
  }

  /**
   * Gets the destination flows (i.e. the flows that use this flow as an input).
   * @returns {Array<Flow<any>>} The destination flows.
   */
  get destinations(): Array<Flow<any>> {
    return this._destinations
      .map((ref) => ref.deref())
      .filter((flow): flow is Flow<any> => !!flow);
  }

  /**
   * Gets the source flows (i.e. the inputs to this flow).
   * @returns {Array<Flow<any>>} The source flows.
   */
  get sources(): Array<Flow<any>> {
    return this._sources;
  }

  /**
   * Whether the flow is "hot" (i.e. will recompute when one of its inputs has changed).
   * @returns {boolean}
   */
  get hot(): boolean {
    return this._on || this._numLiveDescendants > 0;
  }

  /**
   * Whether the flow is "cold" (i.e. will *not* recompute when one of its inputs has changed).
   * @returns {boolean}
   */
  get cold(): boolean {
    return !this.hot;
  }

  /**
   * A convenience identifier for debugging.
   * @returns {string}
   */
  get id(): number {
    return this._id;
  }

  /**
   * The current (i.e. last emitted) value of the flow.
   * @returns {T}
   */
  get value(): T {
    return this._value;
  }

  /**
   * This method is called (1) when a source flow has changed or (2) when this flow becomes hot.
   * @returns {boolean} Whether the value has changed (and needs to be propagated to destinations).
   */
  _source_changed(): boolean {
    throw Error("not implemented");
  }

  /**
   * This method is called when the flow is becoming cold.
   */
  _becoming_cold(): void {
  }

  /**
   * Tell context that this flow's value should be kept up-to-date.
   * Makes this flow, and all of its ancestors, hot.
   * @returns {boolean}
   */
  _turn_on(): void {
    if (this._on) {
      return;
    }
    this._on = true;
    this._context.add_recently_turned_on(this);
  }

  /**
   * Tell context that this flow's value doesn't need to be kept up-do-date.
   * @returns {boolean}
   */
  _turn_off(): void {
    if (!this._on) {
      return;
    }
    this._on = false;
    this._context.add_recently_turned_off(this);
  }

  concat<U>(that: Flow<U>): Flow<[T, U]> {
    return this.map2(that, (t, u) => [t, u]);
  }

  concat2<U, V>(that: Flow<U>, other: Flow<V>): Flow<[T, U, V]> {
    return this.map3(that, other, (t, u, v) => [t, u, v]);
  }

  map<U>(f: (value: T) => U, name?: string): Flow<U> {
    return new MapFlow(this, f, name);
  }

  map2<U, V>(that: Flow<U>, f: (t: T, u: U) => V, name?: string): Flow<V> {
    return new MapNFlow(this._context, [this, that], f, name);
  }

  map3<U, V, W>(
    that: Flow<U>,
    other: Flow<V>,
    f: (t: T, u: U, v: V) => W,
    name?: string
  ): Flow<W> {
    return new MapNFlow(this._context, [this, that, other], f, name);
  }

  mapn<U>(flows: Array<Flow<any>>, f: (...values: Array<any>) => U): Flow<U> {
    return new MapNFlow(this._context, [<Flow<any>>this].concat(flows), f);
  }

  consume(f: (value: T) => void, name?: string): Consumer<T> {
    return new Consumer(this._context, [this], f, name);
  }
}

export class StateFlow<T> extends Flow<T> {
  _value: T;
  constructor(context: Context, initialValue: T, name?: string) {
    super(context, [], name || "StateFlow");
    this._value = initialValue;
  }
  get value(): T {
    return this._value;
  }
  set value(value: T) {
    this._value = value;
    this._context.add_recently_updated(this);
  }
  _source_changed(): boolean {
    return true;
  }
}

export class Consumer<T> extends Flow<void> {
  _callback: (value: T) => void;
  constructor(
    context: Context,
    sources: Array<Flow<any>>,
    callback: (value: T) => void,
    name?: string
  ) {
    super(context, sources, name || "Consumer");
    this._callback = callback;
  }
  turn_on() {
    this._turn_on();
  }
  turn_off() {
    this._turn_off();
  }
  _source_changed(): boolean {
    try {
      this._callback(this.sources[0].value);
    } catch (e) {
      console.error(e);
    }
    return false;
  }
}

export class MapFlow<T, U> extends Flow<U> {
  _f: (value: T) => U;
  _source: Flow<T>;
  constructor(source: Flow<T>, f: (value: T) => U, name?: string) {
    super(source._context, [source], name || "MapFlow");
    this._f = f;
    this._source = source;
  }
  _source_changed(): boolean {
    try {
      this._value = this._f(this._source.value);
    } catch (e) {
      console.error(e);
      return false;
    }
    return true;
  }
}

export class MapNFlow<T> extends Flow<T> {
  _f: (...value: Array<any>) => T;
  constructor(
    context: Context,
    sources: Array<Flow<any>>,
    f: (...value: Array<any>) => T,
    name?: string
  ) {
    super(context, sources, name || "MapNFlow");
    this._f = f;
  }
  _source_changed(): boolean {
    try {
      this._value = this._f(...this.sources.map((flow) => flow.value));
    } catch (e) {
      console.error(e);
      return false;
    }
    return true;
  }
}

export class Context {
  flowCount: number;
  _needsUpdate: Set<Flow<any>>;
  _recentlyTurnedOn: Set<Flow<any>>;
  _recentlyTurnedOff: Set<Flow<any>>;
  _isUpdating: boolean;
  _frozen: boolean;
  _stateFlows: Set<WeakRef<StateFlow<any>>>; // Useful for debugging.
  constructor() {
    this.flowCount = 0;
    this._needsUpdate = new Set();
    this._recentlyTurnedOn = new Set();
    this._recentlyTurnedOff = new Set();
    this._isUpdating = false;
    this._stateFlows = new Set();
    this._frozen = false;
  }

  flatten<T>(flows: Array<Flow<Array<T>>>): Flow<Array<T>> {
    return new MapNFlow(this, flows, (...values) => {
      return values.reduce((acc, value) => acc.concat(value), []);
    });
  }

  add_recently_updated(flow: Flow<any>) {
    this._needsUpdate.add(flow);
    this._dispatch_update();
  }
  add_recently_turned_on(flow: Flow<any>) {
    this._recentlyTurnedOn.add(flow);
    this._dispatch_update();
  }
  add_recently_turned_off(flow: Flow<any>) {
    this._recentlyTurnedOff.add(flow);
    this._dispatch_update();
  }

  create_state_flow<T>(initialValue: T, name?: string): StateFlow<T> {
    const flow = new StateFlow(this, initialValue, name);
    this._stateFlows.add(new WeakRef(flow));
    return flow;
  }

  freeze() {
    this._frozen = true;
  }
  thaw() {
    this._frozen = false;
    if (this._recentlyTurnedOff.size > 0 || this._recentlyTurnedOn.size > 0 || this._needsUpdate.size > 0) {
      this._dispatch_update();
    }
  }

  print_graph() {
    const seen = new Set();
    const upcoming = new Deque<Flow<any>>();
    Array.from(this._stateFlows)
      .map((ref) => ref.deref())
      .filter((flow) => flow !== undefined)
      .forEach((flow: Flow<any>) => {
        seen.add(flow.id);
        upcoming.push_back(flow);
      });
    let text = "";
    while (upcoming.length > 0) {
      const flow = upcoming.pop_front();
      text += `"${flow.name}"\n`;
      for (let dest of flow.destinations) {
        text += `"${flow.name}" -> "${dest.name}"\n`;
        if (!seen.has(dest.id)) {
          upcoming.push_back(dest);
          seen.add(dest.id);
        }
      }
    }
    console.log(text);
  }

  _dispatch_update(): void {
    if (this._frozen) {
      return;
    }
    Promise.resolve().then(() => {
      this._update();
    });
  }

  _update(): void {
    if (this._isUpdating) {
      throw Error("already updating");
    }
    if (this._isUpdating) {
      return;
    }
    this._isUpdating = true;

    // Steps:
    // 1. Walk backward from turned_on/turned_off flows, updating _numLiveDescendants.
    // 2. Walk forward from flows that need updating, updating their values.

    // Step 1
    let turnedOn = Array.from(this._recentlyTurnedOn);
    let turnedOff = Array.from(this._recentlyTurnedOff);
    this._recentlyTurnedOn.clear();
    this._recentlyTurnedOff.clear();
    // TODO: find a better way to do this.
    const newlyHot = new Set<Flow<any>>();
    for (let flow of turnedOn) {
      this._walkBackward([flow], (flow) => {
        flow._numLiveDescendants++;
        if (flow._numLiveDescendants === 1) {
          newlyHot.add(flow);
        }
        return true;
      });
    }
    for (let flow of turnedOff) {
      this._walkBackward([flow], (flow) => {
        flow._numLiveDescendants--;
        if (flow._numLiveDescendants === 0) {
          flow._becoming_cold();
        }
        return true;
      });
    }

    const set: Set<number> = new Set(Array.from(this._needsUpdate.values()).map(flow => flow.id));
    const needsUpdate = Array.from(this._needsUpdate).concat(
      Array.from(newlyHot)
    );
    this._needsUpdate.clear();
    this._walkForward(needsUpdate, (flow) => {
      if (flow.cold) {
        return false;
      }
      if (newlyHot.has(flow)) {
        return flow._source_changed();
      }
      if (set.has(flow.id)) {
        return true;
      }
      return flow._source_changed();
    });

    this._isUpdating = false;
  }

  /**
   * Walks to every node downstream from the given origins, calling "f"
   * @param origins
   * @param f returns "true" if the journey should continue, "false" otherwise.
   */
  _walkForward(origins: Flow<any>[], f: (flow: Flow<any>) => boolean) {
    return this._walk(origins, f, true);
  }
  /**
   * Walks to every node upstream from the given origins, calling "f"
   * @param origins
   * @param f returns "true" if the journey should continue, "false" otherwise.
   * @returns
   */
  _walkBackward(origins: Flow<any>[], f: (flow: Flow<any>) => boolean) {
    return this._walk(origins, f, false);
  }

  /**
   * Walks to every node in the graph reachable from the given origins, calling "f"
   * @param origins
   * @param f returns "true" if the journey should continue, "false" otherwise.
   * @param forward whether to walk forward (to "destinations") or backward (to "sources").
   * @returns
   */
  _walk(
    origins: Flow<any>[],
    f: (flow: Flow<any>) => boolean,
    forward: boolean
  ) {
    if (origins.length === 0) {
      return;
    }
    origins.forEach((flow) => {
      if (flow._context !== this) {
        throw Error("flow not in context");
      }
    });
    let seen: Set<number> = new Set();
    // By requiring source flows to be created before destination flows, we can use a min queue
    // to guarantee we evaluate flows in the correct order.
    let Q = new UniqueMinQueue<Flow<any>>((flow: Flow<any>) =>
      forward ? flow.id : -flow.id
    );
    for (let source of origins) {
      Q.push(source);
      seen.add(source.id);
    }
    while (Q.length > 0) {
      let flow = Q.pop();
      if (!f(flow)) {
        continue;
      }
      let neighbors = forward ? flow.destinations : flow.sources;
      for (let neighbor of neighbors) {
        if (!seen.has(neighbor.id)) {
          seen.add(neighbor.id);
          Q.push(neighbor);
        }
      }
    }
  }
}
