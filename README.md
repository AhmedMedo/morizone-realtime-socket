# Morizone Real-Time Server

Socket.io server for real-time trip tracking and offers.

## Setup

```bash
cd realtime-server
npm install
```

## Create .env file

```bash
cp .env.example .env
# Edit .env with your settings
```

## Run

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

## Test Endpoints

| Endpoint | Method | Description |
|:---|:---|:---|
| `/health` | GET | Health check + connection count |
| `/emit` | POST | Emit event to a room |
| `/broadcast` | POST | Emit to all clients |
| `/rooms` | GET | List all active rooms |

## Test with cURL

```bash
# Health check
curl http://localhost:3001/health

# Emit to a trip room
curl -X POST http://localhost:3001/emit \
  -H "Content-Type: application/json" \
  -d '{"room": "trip:123", "event": "test", "data": {"message": "Hello!"}}'
```
