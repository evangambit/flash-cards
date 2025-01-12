import json
import sqlite3
import time
import uuid

from flask import Flask, request, g, send_from_directory

app = Flask(__name__)

def get_db():
  db = getattr(g, '_database', None)
  if db is None:
    db = g._database = sqlite3.connect('database.db')
  return db

# Files in "./dist" are served as static files.
@app.route('/')
def index():
  return send_from_directory('dist', 'index.html')

@app.route('/media/<path:path>')
def media_files(path):
  return send_from_directory('media', path)

@app.route('/<path:path>')
def static_files(path):
  return send_from_directory('dist', path)

def tuple2deck(t):
  return {
    'deck_id': t[0],
    'deck_name': t[1],
    'date_created': t[2],
    'remote_date': t[3],
  }

def tuple2card(t):
  return {
    'card_id': t[0],
    'deck_id': t[1],
    'front': t[2],
    'back': t[3],
    'date_created': t[4],
    'remote_date': t[5],
  }

def tuple2review(t):
  return {
    'review_id': t[0],
    'card_id': t[1],
    'deck_id': t[2],
    'response': t[3],
    'date_created': t[4],
    'remote_date': t[5],
  }

def make_operation(table, data, type='insert'):
  return {
    'type': type,
    'table': table,
    'data': data
  }

@app.route('/api/sync', methods=['POST'])
def sync():
  client_operations = request.json['operations']
  last_sync = request.json['last_sync']
  print(f'SYNCING {last_sync}')

  print(last_sync)

  db = get_db()
  cursor = db.cursor()

  response = []
  cursor.execute('SELECT * FROM decks WHERE remote_date > ?', (last_sync,))
  response += [make_operation('decks', tuple2deck(t)) for t in cursor.fetchall()]
  cursor.execute('SELECT * FROM cards WHERE remote_date > ?', (last_sync,))
  response += [make_operation('cards', tuple2card(t)) for t in cursor.fetchall()]
  cursor.execute('SELECT * FROM reviews WHERE remote_date > ?', (last_sync,))
  response += [make_operation('reviews', tuple2review(t)) for t in cursor.fetchall()]

  if len(response) > 0:
    gCounter = max(x['data']['remote_date'] for x in response)
  else:
    # last_sync is apparently bigger than the remote_date for all server data. This should
    # probably never happen, but if it does... then last_sync is a valid value for gCounter.
    gCounter = last_sync
  gCounter += 1

  try:
    cursor.execute('begin')
    for operation in client_operations:
      operation['data']['remote_date'] = gCounter
      assert operation['type'] in ['insert']
      table = operation['table']
      data = operation['data']
      assert table in ['decks', 'cards', 'reviews']
      if table == 'decks':
        cursor.execute('INSERT OR REPLACE INTO decks VALUES (?, ?, ?, ?)', (data['deck_id'], data['deck_name'], data['date_created'], data['remote_date']))
      elif table == 'cards':
        cursor.execute('INSERT OR REPLACE INTO cards VALUES (?, ?, ?, ?, ?, ?)', (data['card_id'], data['deck_id'], data['front'], data['back'], data['date_created'], data['remote_date']))
      elif table == 'reviews':
        cursor.execute('INSERT OR REPLACE INTO reviews VALUES (?, ?, ?, ?, ?, ?)', (data['review_id'], data['card_id'], data['deck_id'], data['response'], data['date_created'], data['remote_date']))
    cursor.execute('commit')
  except:
    cursor.execute('rollback')
    raise

  return json.dumps({
    "remote": response,
    # Need to return client_operations to update the remote_date.
    "local": client_operations,
  }), 200

@app.route('/api/reset', methods=['GET', 'POST'])
def reset():
  import os
  if os.path.exists('database.db'):
    os.remove('database.db')
  db = get_db()
  cursor = db.cursor()
  cursor.execute('CREATE TABLE IF NOT EXISTS decks (deck_id STRING PRIMARY KEY, deck_name STRING, date_created REAL, remote_date INTEGER)')
  cursor.execute('CREATE TABLE IF NOT EXISTS cards (card_id STRING PRIMARY KEY, deck_id STRING, front STRING, back STRING, date_created REAL, remote_date INTEGER)')
  cursor.execute('CREATE TABLE IF NOT EXISTS reviews (review_id STRING PRIMARY KEY, card_id STRING, deck_id STRING, response STRING, date_created REAL, remote_date INTEGER)')

  decks = []
  for i in range(2):
    deck = {
      'deck_id': uuid.uuid4().hex,
      'cards': [],
      'name': f'Deck {i}'
    }
    for _ in range(10 if i == 0 else 3):
      deck['cards'].append({
        'card_id': uuid.uuid4().hex,
        'deck_id': deck['deck_id'],
        'front': f'Front {i + 1}',
        'back': f'Front {i + 1}',
      })
    decks.append(deck)
  
  with open('vocab.txt', 'r') as f:
    deck = {
      'deck_id': uuid.uuid4().hex,
      'cards': [],
      'name': f'Chinese | English'
    }
    lines = f.read().split('\n')
    for i in range(0, len(lines), 2):
      if lines[i + 0] == '' or lines[i + 1] == '':
        break
      a = f'Chinese for: {lines[i + 0]}'
      b = f'English for: {lines[i + 1]}'
      deck['cards'].append({
        'card_id': uuid.uuid4().hex, 'deck_id': deck['deck_id'], 'front': a, 'back': b,
      })
      deck['cards'].append({
        'card_id': uuid.uuid4().hex, 'deck_id': deck['deck_id'], 'front': b, 'back': a,
      })
    decks.append(deck)

  # Add some sample data.
  t = time.time()
  for deck in decks:
    deck_name = deck['name']
    deck_id = deck['cards'][0]['deck_id']
    cursor.execute('INSERT INTO decks VALUES (?, ?, ?, ?)', (deck_id, deck_name, t, 1))
    for card in deck['cards']:
      cursor.execute('INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?)', (card['card_id'], card['deck_id'], card['front'], card['back'], t, 1))

  db.commit()
  return 'Database reset.', 200

try:
  import socket;
  print('http://' + (([ip for ip in socket.gethostbyname_ex(socket.gethostname())[2] if not ip.startswith("127.")] or [[(s.connect(("8.8.8.8", 53)), s.getsockname()[0], s.close()) for s in [socket.socket(socket.AF_INET, socket.SOCK_DGRAM)]][0][1]]) + ["no IP found"])[0] + ':8000')
except Exception:
  pass

# flask --app server:app run --host localhost --port 5002
# gunicorn --certfile cert.pem --keyfile key.pem -b 0.0.0.0:5002 'server:app' --workers=1
# openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 -keyout key.pem -out cert.pem
if __name__ == '__main__':
  app.run(debug=True, port=5002)
