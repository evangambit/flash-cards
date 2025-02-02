export enum ReviewResponse {
  perfect = 3,
  correct_but_difficult = 2,
  incorrect = 1,
  complete_blackout = 0,
}

export function get_now(): number {
  return Date.now() / 1000;
}

export const kUnknownRemoteDate = 0;

function new_id() {
  return Math.random().toString();
}

export interface Operation {
  table: string;
  row: SyncableRow;
}

interface SyncResponse {
  remote: Array<Operation>;
  local: Array<Operation>;
}

export interface Deletable {
  deleted?: boolean;
}

interface SyncableRow extends Deletable {
  remote_date: number;
  date_created: number;
}

export interface Deck extends SyncableRow {
  deck_id: string; // Primary ID
  deck_name: string;
}

export interface Card extends SyncableRow {
  card_id: string; // Primary ID
  deck_id: string;
  front: string;
  back: string;
}

export interface Review extends SyncableRow {
  review_id: string; // Primary ID
  card_id: string;
  deck_id: string;
  response: ReviewResponse;
}

function less_than_or_equal(a: any, b: any) {
  if (typeof(a) === 'string') {
    return a.localeCompare(b) <= 0;
  }
  if (typeof(a) === 'number') {
    return a < b;
  }
  throw Error('Unrecognized Type');
}

function less_than(a: any, b: any) {
  if (typeof(a) === 'string') {
    return a.localeCompare(b) < 0;
  }
  if (typeof(a) === 'number') {
    return a < b;
  }
  throw Error('Unrecognized Type');
}

// We're a bit lazy, and don't index by (table, index).
const kIndices = new Map<string, Array<string>>([
  ["index_remote_date", ["remote_date", "date_created"]],

  ["index_deck_id", ["deck_id"]],

  ["index_card_id", ["card_id"]],

  ["index_card_id_and_date_created", ["card_id", "date_created"]],

  ["index_card_id_and_date_created", ["card_id", "date_created"]],
]);


const kTable2Key = new Map([
  ["decks", "deck_id"],
  ["cards", "card_id"],
  ["reviews", "review_id"],
]);

/**
 * A simple locker that ensures
 * 1) the function f is only called once at a time, and
 * 2) the function f will be called "soon" after it is requested to be called.
 */
class Locker<T> {
  _f: () => Promise<T>;

  // The current promise that is being executed (if any).
  _currentPromise: Promise<T> | undefined;

  // A promise that will be executed after the current promise is done.
  _nextPromise: Promise<T> | undefined;

  constructor(f: () => Promise<T>) {
    this._f = f;
    this._currentPromise = undefined;
    this._nextPromise = undefined;
  }
  fire(): Promise<T> {
    if (!this._currentPromise) {
      this._currentPromise = this._f().then((result) => {
        return result;
      });
      return this._currentPromise;
    }
    if (this._nextPromise) {
      // "nextPromise" is guaranteed to not yet be executing,
      // so returning here fulfills our promise that "f" will
      // be called after "fire".
      return this._nextPromise;
    }
    this._nextPromise = new Promise((resolve) => {
      this._currentPromise.then(() => {
        this._currentPromise = this._nextPromise;
        this._nextPromise = undefined;
        this._f().then((result) => {
          resolve(result);
        });
      });
    });
    return this._nextPromise;
  }
}

function _largest_remote_date(
  db: IDBDatabase,
  tableName: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(tableName, "readonly");
    const objectStore = transaction.objectStore(tableName);
    // Grab largest remote_date
    const request = objectStore
      .index("index_remote_date")
      .openCursor(null, "prev");
    request.onsuccess = (event) => {
      const cursor: IDBCursorWithValue = (<IDBRequest>event.target).result;
      if (!cursor || !cursor.value) {
        // No entries in table.
        resolve(0);
        return;
      }
      resolve(cursor.value.remote_date);
    };
    request.onerror = (err) => {
      console.warn(err);
      alert("Something went wrong");
    };
  });
}

export function largest_remote_date(
  db: IDBDatabase,
): Promise<number> {
  return Promise.all([
    _largest_remote_date(db, "decks"),
    _largest_remote_date(db, "cards"),
    _largest_remote_date(db, "reviews"),
  ]).then(values => Math.max.apply(null, values));
}

export interface Account {
  account_id: string;  // A unique identifier for the account.
  token: string;  // This is a secret token that should be kept secret.
}

/**
 * Base DB class that only knows about syncable rows (i.e. not LearnState).
 *
 * It maintains zero flows, and is only responsible for syncing with the server
 * and dispatching mutation events to its listeners.
 *
 * Not intended to be used outside of db.ts.
 */
export class SyncableDb extends EventTarget {
  db: IDBDatabase;
  _account: Account;
  _lastRemoteSyncTime: number;
  _syncPromise: Promise<void> | undefined;
  constructor(db: IDBDatabase, lastRemoteSyncTime: number, account: Account) {
    super();
    this.db = db;
    this._account = account;
    this._lastRemoteSyncTime = lastRemoteSyncTime;
    this._syncPromise = undefined;
  }
  static brandNew(db: IDBDatabase) {
    console.log("Creating object stores");

    // These tables are synced with the server.
    const decks = db.createObjectStore("decks", {
      keyPath: kTable2Key.get("decks"),
    });
    const cards = db.createObjectStore("cards", {
      keyPath: kTable2Key.get("cards"),
    });
    const reviews = db.createObjectStore("reviews", {
      keyPath: kTable2Key.get("reviews"),
    });

    // Useful for syncing.
    decks.createIndex("index_remote_date", ["remote_date", "date_created"], { unique: false });
    cards.createIndex("index_remote_date", ["remote_date", "date_created"], { unique: false });
    reviews.createIndex("index_remote_date", ["remote_date", "date_created"], { unique: false });

    return {
      decks,
      cards,
      reviews,
    };
  }
  getAll<T>(tableName: string): Promise<Array<T>> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(tableName, "readonly");
      const objectStore = transaction.objectStore(tableName);
      const request = objectStore.getAll();
      request.onsuccess = (event) => {
        resolve(<Array<T>>(<IDBRequest>event.target).result);
      };
      request.onerror = (event) => {
        console.error(event);
        reject(event);
      };
    });
  }
  /**
   * @param objectStoreName
   * @param obj
   * @param transaction
   * @param isUpdate
   * @returns
   */
  _add<T extends SyncableRow>(
    objectStoreName: string,
    obj: T,
    transaction: IDBTransaction | undefined = undefined
  ): Promise<T> {
    transaction =
      transaction || this.db.transaction([objectStoreName], "readwrite");
    transaction.objectStore(objectStoreName).add(obj);
    return new Promise((resolve, reject) => {
      transaction.addEventListener("complete", () => {
        this.dispatchEvent(
          new CustomEvent("add", {
            detail: { table: objectStoreName, row: obj },
          })
        );
        resolve(obj);
      });
    });
  }
  _modify<T extends SyncableRow>(
    objectStoreName: string,
    obj: T,
    transaction: IDBTransaction | undefined = undefined
  ): Promise<T> {
    transaction =
      transaction || this.db.transaction([objectStoreName], "readwrite");
    obj.remote_date = kUnknownRemoteDate;
    transaction.objectStore(objectStoreName).put(obj);
    return new Promise((resolve, reject) => {
      transaction.addEventListener("complete", () => {
        this.dispatchEvent(
          new CustomEvent("modify", {
            detail: { table: objectStoreName, row: obj },
          })
        );
        resolve(obj);
      });
      transaction.addEventListener('error', (e) => {
        console.error(e);
      });
    });
  }
  // Use this when you're not sure if this is an add or a modify.
  // IMPORTANT: the caller should think about whether they want
  // remote_date to be kUnknownRemoteDate or not!
  _insert<T extends SyncableRow>(
    objectStoreName: string,
    obj: T,
    transaction: IDBTransaction | undefined = undefined
  ): Promise<T> {
    transaction =
      transaction || this.db.transaction([objectStoreName], "readwrite");
    const store = transaction.objectStore(objectStoreName);
    const key = (<any>obj)[kTable2Key.get(objectStoreName)];
    const r = store.get(key);
    let insertType : string | undefined;
    r.onsuccess = (e: CustomEvent) => {
      const oldObj: T | undefined = (<any>e.target).result;
      const wasAbsent = !oldObj || oldObj.deleted;
      const isAbsent = obj.deleted;
      if (wasAbsent && isAbsent) {
        insertType = '';  // Best to not dispatch an event in this case.
      } else if (wasAbsent && !isAbsent) {
        insertType = 'add';
      } else if (!wasAbsent && isAbsent) {
        insertType = 'delete';
      } else {
        insertType = 'modify';
      }
      store.put(obj);
    };
    return new Promise((resolve, reject) => {
      transaction.addEventListener("complete", () => {
        this.dispatchEvent(
          new CustomEvent(insertType, {
            detail: { table: objectStoreName, row: obj },
          })
        );
        resolve(obj);
      });
    });
  }

  _delete(
    objectStoreName: string,
    key: string,
    transaction: IDBTransaction | undefined = undefined
  ): Promise<void> {
    if (!['decks', 'cards', 'reviews'].includes(objectStoreName)) {
      if (transaction) {
        transaction.abort();
      }
      throw Error(`Invalid object store name: ${objectStoreName}`);
    }
    transaction =
    transaction || this.db.transaction([objectStoreName], "readwrite");
    const store = transaction.objectStore(objectStoreName);
    const r = store.get(key);
    let row: SyncableRow | undefined;
    r.onsuccess = (e: CustomEvent) => {
      row = (<any>e.target).result;
      if (row) {
        row.deleted = true;
        row.remote_date = kUnknownRemoteDate;
        store.put(row);
      } else {
        console.error(`Could not find row with key ${key}`);
        transaction.abort();
      }
    };
    return new Promise((resolve, reject) => {
      transaction.addEventListener("complete", () => {
        this.dispatchEvent(
          new CustomEvent('delete', {
            detail: { table: objectStoreName, row: row },
          })
        );
        resolve();
      });
    });
  }

  _get_unsynced_operations(tableName: string): Promise<Array<Operation>> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(tableName, "readonly");
      const keyRange = IDBKeyRange.upperBound([kUnknownRemoteDate, Infinity]);
      const request = transaction
        .objectStore(tableName)
        .index("index_remote_date")
        .getAll(keyRange);
      request.onsuccess = (event) => {
        const rows: Array<SyncableRow> = (<IDBRequest>event.target).result;
        resolve(rows.map(row => {
          return {
            table: tableName,
            row: row,
          }
        }));
      };
      request.onerror = (event) => {
        reject(event);
      };
    });
  }

  // Returns all rows with "remote_date == kUnknownRemoteDate"
  get_unsynced_operations(): Promise<Array<Operation>> {
    return Promise.all([
      this._get_unsynced_operations("decks"),
      this._get_unsynced_operations("cards"),
      this._get_unsynced_operations("reviews"),
    ]).then((ops) => {
      const [decks, cards, reviews] = ops;
      return decks.concat(cards, reviews);
    })
  }

  sync(): Promise<void> {
    /**
     * Some comments on our syncing strategy:
     *
     * First, every row is generated with a unique key, which ensures that
     * the same row cannot be created by two different clients. If we didn't
     * support editting and deleting this would be sufficient.
     *
     * Second, every syncable row has a "remote_date" field. This is the "time"
     * at which the server learned about the row. This is used to determine
     * which row is the "latest" when there are conflicts. If we didn't support
     * deletions, this would be sufficient.
     *
     * Consider two scenarios:
     *
     * 1) We create a row and sync
     * 2) Another client deletes the row and syncs
     * 3) We edit the row and sync
     *
     * 1) We create a row and sync.
     * 2) We edit the row and sync
     *
     * Under a "last write wins" scenario we'd re-create the row. This would
     * force us to never delete Review rows (since any deleted card may be
     * resurrected at any time).
     *
     * It would also force us to keep careful track of whether an operation is
     * a modification or an addition, since we need to publish the correct
     * event to our observers.
     *
     * These are both not good. Instead, we'll use a "last delete wins" strategy.
     */
    if (this._syncPromise) {
      return this._syncPromise;
    }

    this._syncPromise = this._sync().then(() => {});
    return this._syncPromise;
  }

  // Subclass implementations of this should call _base_sync (below).
  _sync(): Promise<any> {
    return this._base_sync();
  }

  // Don't override this method -- see "_sync" (above).
  _base_sync(): Promise<Array<Operation>> {
    return this.get_unsynced_operations()
      .then((ops) => {
        return fetch("/api/sync", {
          method: "POST",
          body: JSON.stringify({
            operations: ops,
            account: this._account,
            last_sync: this._lastRemoteSyncTime,
          }),
          headers: {
            "Content-Type": "application/json",
          },
        });
      })
      .then((response) => {
        return response.json();
      })
      .then((response: SyncResponse) => {
        const remoteOperations: Array<Operation> = response.remote;
        const localOperations: Array<Operation> = response.local;

        // Operations should already be sorted by remote_date, and then date_created, but let's be safe!
        remoteOperations.sort(
          (a, b) =>
            a.row.remote_date - b.row.remote_date ||
            a.row.date_created - b.row.date_created
        );
        localOperations.sort(
          (a, b) =>
            a.row.remote_date - b.row.remote_date ||
            a.row.date_created - b.row.date_created
        );

        const txn = this.db.transaction(
          ["decks", "cards", "reviews"],
          "readwrite"
        );

        const events: Array<[string, string, any]> = [];

        const allOperations = remoteOperations.concat(localOperations);

        // Re-inserting local operations helps our updates win over the remote updates.
        for (const operation of allOperations) {
          const row: any = operation.row;
          const key = (<any>operation.row)[kTable2Key.get(operation.table)];
          this._insert(operation.table, operation.row, txn);
        }

        return new Promise<Array<Operation>>((resolve, reject) => {
          txn.addEventListener("complete", () => {
            this._syncPromise = undefined;
            if (localOperations.length > 0) {
              // Note: all returned operations should have the same remote_date.
              this._lastRemoteSyncTime = localOperations[0].row.remote_date;
            } else if (remoteOperations.length > 0) {
              // Note: all returned operations may *not* have the same remote_date.
              this._lastRemoteSyncTime =
                remoteOperations[remoteOperations.length - 1].row.remote_date;
            }

            for (const [type, table, row] of events) {
              this.dispatchEvent(
                new CustomEvent(type, {
                  detail: { table, row },
                })
              );
            }
            resolve(remoteOperations);
          });
          txn.addEventListener('error', (e) => {
            console.error(e);
          });
        });
      });
  }
}
