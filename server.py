import base64
import json
import os
import shutil
import sqlite3
import time
import uuid
import hashlib

from flask import Flask, request, g, send_from_directory
import jwt

app = Flask(__name__)

def get_db(account_id):
  db = getattr(g, '_database', None)
  if db is None:
    db = g._database = sqlite3.connect(os.path.join('account-dbs', f'{account_id}.db'))
  return db

def get_account_db():
  db = getattr(g, '_account_database', None)
  if db is None:
    db = g._account_database = sqlite3.connect('accounts.db')
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
  return send_from_directory('dist', path, mimetype={
    '.ts': 'text/javascript',
  }.get(path[-3:], None))

# Note: sqlite3 "helpfully"/unbelievably will cast strings into ints/floats
# if it can. This is bad because IndexDB is sane and treats "4" and 4 as
# distinct (obviously this is very important for primary keys). So we cast
# all expected strings to strings here to avoid this issue.

def tuple2deck(t):
  return {
    'deck_id': str(t[0]),
    'deck_name': str(t[1]),
    'date_created': t[2],
    'remote_date': t[3],
  }

def tuple2card(t):
  return {
    'card_id': str(t[0]),
    'deck_id': str(t[1]),
    'front': str(t[2]),
    'back': str(t[3]),
    'date_created': t[4],
    'remote_date': t[5],
  }

def tuple2review(t):
  return {
    'review_id': str(t[0]),
    'card_id': str(t[1]),
    'deck_id': str(t[2]),
    'response': t[3],
    'date_created': t[4],
    'remote_date': t[5],
  }

def make_operation(table, row):
  return {
    'table': table,
    'row': row,
  }

@app.route('/api/signup', methods=['POST'])
def signup():
  db = get_account_db()
  cursor = db.cursor()
  username = request.json['username']
  password = request.json['password']
  cursor.execute('SELECT * FROM accounts WHERE username = ?', (username,))
  if cursor.fetchone() is not None:
    return 'Username already exists.', 400
  cursor.execute('INSERT INTO accounts VALUES (?, ?)', (username, hashlib.sha256(password.encode()).hexdigest()))
  db.commit()
  return 'Account created.', 200

SECRET_KEY = 'your_secret_key_here'

def username2accountid(username: str):
  return base64.b64encode(username.encode(), altchars=b'-_').decode()

@app.route('/api/signin', methods=['POST'])
def get_token():
  db = get_account_db()
  cursor = db.cursor()
  # TODO: Use a more secure password hashing algorithm.
  username = request.json['username']
  password = request.json['password']
  hashed_password = hashlib.sha256(password.encode()).hexdigest()
  cursor.execute('SELECT * FROM accounts WHERE username = ? AND password_sha256 = ?', (username, hashed_password))
  if cursor.fetchone() is None:
    return 'Invalid username or password.', 400

  expiration = time.time() + 3600  # Token expires in 1 hour
  token = jwt.encode({'username': username, 'exp': expiration}, SECRET_KEY, algorithm='HS256')
  response = app.make_response(json.dumps({
    'signed_in': True,
    'expiration': expiration,
    'message': 'Signed in.',
  }))
  response.set_cookie('token', token, httponly=True, secure=True, samesite='Lax')
  return response, 200

@app.route('/api/signout', methods=['POST'])
def signout():
  response = app.make_response('Signed out.')
  response.set_cookie('token', '', httponly=True, secure=True, samesite='Lax', expires=0)
  return response, 200

def check_token(request):
  token = request.cookies.get('token')

  try:
    payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
  except jwt.ExpiredSignatureError:
    return json.dumps({
      'signed_in': False,
      'expiration': None,
      'message': 'Token has expired.',
    }), False, None
  except jwt.InvalidTokenError:
    return json.dumps({
      'signed_in': False,
      'expiration': None,
      'message': 'Invalid token.',
    }), False, None
  
  if payload['exp'] < time.time():
    return json.dumps({
      'signed_in': False,
      'expiration': None,
      'message': 'Token has expired.',
    }), False, None
  
  return json.dumps({
    'signed_in': True,
    'expiration': payload['exp'],
    'message': 'Token is valid.',
  }), True, username2accountid(payload['username'])

@app.route('/api/am_i_signed_in', methods=['POST'])
def am_i_signed_in():
  token_check, signed_in, _ = check_token(request)
  response = app.make_response(token_check)
  # Clear the cookie if the token is invalid.
  if not signed_in:
    response.set_cookie('token', '', httponly=True, secure=True, samesite='Lax', expires=0)
  return response, 200

@app.route('/api/sync', methods=['POST'])
def sync():
  client_operations = request.json['operations']
  last_sync = request.json['last_sync']

  _, is_good_token, account_id = check_token(request)
  if not is_good_token:
    return '', 401

  db = get_db(account_id=account_id)
  cursor = db.cursor()

  print(f'SYNCING {last_sync}')
  print(client_operations)

  response = []
  cursor.execute('SELECT * FROM decks WHERE remote_date > ?', (last_sync,))
  response += [make_operation('decks', tuple2deck(t)) for t in cursor.fetchall()]
  cursor.execute('SELECT * FROM cards WHERE remote_date > ?', (last_sync,))
  response += [make_operation('cards', tuple2card(t)) for t in cursor.fetchall()]
  cursor.execute('SELECT * FROM reviews WHERE remote_date > ?', (last_sync,))
  response += [make_operation('reviews', tuple2review(t)) for t in cursor.fetchall()]

  print(response)

  # Sort by remote_date, then by date_created.
  response.sort(key=lambda x: x['row']['remote_date'])
  response.sort(key=lambda x: x['row']['date_created'])

  if len(response) > 0:
    gCounter = max(x['row']['remote_date'] for x in response)
  else:
    # last_sync is apparently bigger than the remote_date for all server data. This should
    # probably never happen, but if it does... then last_sync is a valid value for gCounter.
    gCounter = last_sync
  gCounter += 1

  try:
    cursor.execute('begin')
    for operation in client_operations:
      print(operation)
      operation['row']['remote_date'] = gCounter
      table = operation['table']
      row = operation['row']
      assert table in ['decks', 'cards', 'reviews']
      if table == 'decks':
        cursor.execute('INSERT OR REPLACE INTO decks VALUES (?, ?, ?, ?)', (row['deck_id'], row['deck_name'], row['date_created'], row['remote_date']))
      elif table == 'cards':
        cursor.execute('INSERT OR REPLACE INTO cards VALUES (?, ?, ?, ?, ?, ?)', (row['card_id'], row['deck_id'], row['front'], row['back'], row['date_created'], row['remote_date']))
      elif table == 'reviews':
        cursor.execute('INSERT OR REPLACE INTO reviews VALUES (?, ?, ?, ?, ?, ?)', (row['review_id'], row['card_id'], row['deck_id'], row['response'], row['date_created'], row['remote_date']))
      else:
        assert False, f'Unknown table: {table}'

        
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
  if os.path.exists('accounts.db'):
    os.remove('accounts.db')
  if os.path.exists('account-dbs'):
    shutil.rmtree('account-dbs')
  os.mkdir('account-dbs')
  account_db = get_account_db()
  account_cursor = account_db.cursor()
  account_cursor.execute('CREATE TABLE IF NOT EXISTS accounts (username STRING PRIMARY KEY, password_sha256 STRING, account_id STRING)')
  account_id = username2accountid('alice')
  account_cursor.execute('INSERT INTO accounts VALUES (?, ?, ?)', (
    'alice',
    hashlib.sha256('test'.encode()).hexdigest(),
    account_id,
  ))
  account_db.commit()

  db = get_db(account_id)
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
    for j in range(10 if i == 0 else 3):
      deck['cards'].append({
        'card_id': uuid.uuid4().hex,
        'deck_id': deck['deck_id'],
        'front': f'Front {j + 1}',
        'back': f'Back {j + 1}',
      })
    decks.append(deck)
  
  # with open('vocab.txt', 'r') as f:
  #   deck = {
  #     'deck_id': uuid.uuid4().hex,
  #     'cards': [],
  #     'name': f'Chinese | English'
  #   }
  #   lines = f.read().split('\n')
  #   seen = set()
  #   for i in range(0, len(lines), 2):
  #     if lines[i + 0] == '' or lines[i + 1] == '':
  #       break
  #     if lines[i + 0] in seen:
  #       print(f'SKIPPING {lines[i + 0]}')
  #       continue
  #     seen.add(lines[i + 0])
  #     a = f'English for: {lines[i + 0]}'
  #     b = f'Chinese for: {lines[i + 1]}'
  #     deck['cards'].append({
  #       'card_id': uuid.uuid4().hex, 'deck_id': deck['deck_id'], 'front': a, 'back': b,
  #     })
  #     deck['cards'].append({
  #       'card_id': uuid.uuid4().hex, 'deck_id': deck['deck_id'], 'front': b, 'back': a,
  #     })
  #   decks.append(deck)

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
