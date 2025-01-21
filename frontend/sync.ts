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

interface SyncableRow {
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

export interface Deletion extends SyncableRow {
  deletion_id: string; // Primary ID
  table: string;
  row_key: string;
}

const kTable2Key = new Map([
  ["decks", "deck_id"],
  ["cards", "card_id"],
  ["reviews", "review_id"],
  ["deletions", "deletion_id"],
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
    _largest_remote_date(db, "deletions"),
  ]).then(values => Math.max.apply(null, values));
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
  _lastRemoteSyncTime: number;
  _syncPromise: Promise<void> | undefined;
  constructor(db: IDBDatabase, lastRemoteSyncTime: number) {
    super();
    this.db = db;
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
    const deletions = db.createObjectStore("deletions", {
      keyPath: kTable2Key.get("deletions"),
    });

    // Useful for syncing.
    decks.createIndex("index_remote_date", ["remote_date", "date_created"], { unique: false });
    cards.createIndex("index_remote_date", ["remote_date", "date_created"], { unique: false });
    reviews.createIndex("index_remote_date", ["remote_date", "date_created"], { unique: false });
    deletions.createIndex("index_remote_date", ["remote_date", "date_created"], { unique: false });

    return {
      decks,
      cards,
      reviews,
      deletions,
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
  ) {
    transaction =
      transaction || this.db.transaction([objectStoreName], "readwrite");
    const store = transaction.objectStore(objectStoreName);
    const key = (<any>obj)[kTable2Key.get(objectStoreName)];
    const r = store.get(key);
    let insertType : string | undefined;
    r.onsuccess = (e: CustomEvent) => {
      if ((<any>e.target).result) {
        insertType = 'modify';
        store.put(obj);
      } else {
        insertType = 'add';
        store.add(obj);
      }
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
  _delete<T>(
    objectStoreName: string,
    key: string,
    transaction: IDBTransaction | undefined = undefined
  ): Promise<void> {
    transaction =
      transaction || this.db.transaction(["deletions"], "readwrite");
    const deletion = <Deletion>{
      remote_date: kUnknownRemoteDate,
      date_created: get_now(),
      deletion_id: new_id(),
      table: objectStoreName,
      row_key: key,
    };
    transaction.objectStore("deletions").put(deletion);
    return new Promise((resolve, reject) => {
      transaction.addEventListener("complete", () => {
        this.dispatchEvent(
          new CustomEvent("delete", {
            detail: { table: objectStoreName, row: deletion },
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
      this._get_unsynced_operations("deletions"),
    ]).then((ops) => {
      const [decks, cards, reviews, deletions] = ops;
      return decks.concat(cards, reviews, deletions);
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
        for (const operations of [remoteOperations, localOperations]) {
          for (const operation of operations) {
            console.log(operation);
            if (operation.row.remote_date <= this._lastRemoteSyncTime) {
              throw Error("Bad remote date");
            }
          }
        }

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
          ["decks", "cards", "reviews", "deletions"],
          "readwrite"
        );

        // Any operations on rows that will be deleted should be ignored. Otherwise local
        // modifications may overwrite remote deletions.
        const deleted = new Set<string>();
        for (const operations of [remoteOperations, localOperations]) {
          for (const operation of operations) {
            const row = operation.row;
            const key = (<any>row)[kTable2Key.get(operation.table)];
            if (operation.table === "deletions") {
              deleted.add(`${operation.table}::${key}`);
            }
          }
        }

        const events: Array<[string, string, any]> = [];

        // Re-inserting local operations helps our updates win over the remote updates.
        for (const operations of [remoteOperations, localOperations]) {
          for (const operation of operations) {
            const row: any = operation.row;
            const dkey = `${operation.table}::${
              row[kTable2Key.get(operation.table)]
            }`;
            if (operation.table != 'deletions') {
              // Don't modify a row that has been deleted (this could resurrect it!)
              if (deleted.has(dkey)) {
                continue;
              }
              // TODO: generalize the idea that when a unique primary key is deleted,
              // any insertions containing that key *anywhere* should be ignored as well.
              if (operation.table === "reviews" && deleted.has(`cards::${row.card_id}`)) {
                // Don't insert a review for a card that has been deleted.
                continue;
              }
              if (operation.table === "cards" && deleted.has(`decks::${row.deck_id}`)) {
                // Don't insert a review for a card that has been deleted.
                continue;
              }
              // TODO: decide whether to use add or modify event
              const key = (<any>operation.row)[kTable2Key.get(operation.table)];
              txn.objectStore(operation.table).get(key).onsuccess = (e: CustomEvent) => {
                if ((<any>e.target).result) {
                  txn.objectStore(operation.table).put(operation.row);
                  events.push(["modify", operation.table, row]);
                } else {
                  txn.objectStore(operation.table).add(operation.row);
                  events.push(["add", operation.table, row]);
                }
              };
            } else {
              const deletion = <Deletion>operation.row;
              txn.objectStore(deletion.table).delete(deletion.row_key);
            }
          }
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

            // TODO: delete all deletions that have been synced?

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
