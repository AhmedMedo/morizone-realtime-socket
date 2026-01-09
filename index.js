require('dotenv').config();
const http = require('http');
const express = require('express');
const axios = require('axios');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());
app.use(express.static('public')); // Serve static files from public directory

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT;
if (!PORT) {
    throw new Error('PORT not provided by Passenger');
}
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
const LARAVEL_API_URL = process.env.LARAVEL_API_URL;

if (!INTERNAL_SECRET || !LARAVEL_API_URL) {
    throw new Error('Missing environment variables');
}

// ============================================
// LOGGING HELPER
// ============================================
function log(type, message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${type}] ${message}`);
    if (data) console.log(JSON.stringify(data, null, 2));

    // Broadcast log to connected logs viewers
    io.emit('server:log', {
        type,
        message,
        data,
        timestamp
    });
}

// ============================================
// INTERNAL SECRET MIDDLEWARE (for Laravel calls)
// ============================================
function verifyInternalSecret(req, res, next) {
    const secret = req.headers['x-internal-secret'];

    if (!secret || secret !== INTERNAL_SECRET) {
        log('AUTH', 'Invalid internal secret attempt', {
            provided: secret ? 'yes' : 'no',
            ip: req.ip
        });
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

// ============================================
// SANCTUM TOKEN VALIDATION (for mobile connections)
// ============================================
async function validateSanctumToken(token, userType = 'user') {
    if (!token) return null;

    try {
        const response = await axios.get(`${LARAVEL_API_URL}/api/v1/socket-auth/validate`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'Accept-Language': 'en'
            }
        });

        if (response.data && response.data.user) {
            log('AUTH', 'Token validated successfully', {
                user_id: response.data.user.id,
                type: response.data.type
            });
            return response.data;
        }

        return null;
    } catch (error) {
        log('AUTH', 'Token validation failed', {
            error: error.message,
            status: error.response?.status
        });
        return null;
    }
}

// ============================================
// HTTP ENDPOINTS (for Laravel to call)
// ============================================

// Health check (no auth required)
app.get('/health', (req, res) => {
    log('HTTP', 'Health check requested');
    res.json({ status: 'ok', connections: io.engine.clientsCount });
});

// Emit to room (requires internal secret)
app.post('/emit', verifyInternalSecret, (req, res) => {
    const { room, event, data } = req.body;

    log('HTTP', `Emit request: ${event} to room: ${room}`, data);

    if (!room || !event) {
        return res.status(400).json({ error: 'room and event are required' });
    }

    io.to(room).emit(event, data);

    log('HTTP', `Emitted ${event} to ${room}`);
    res.json({ success: true, room, event });
});

// Broadcast to all (requires internal secret)
app.post('/broadcast', verifyInternalSecret, (req, res) => {
    const { event, data } = req.body;

    log('HTTP', `Broadcast request: ${event}`, data);

    io.emit(event, data);

    res.json({ success: true, event, clientCount: io.engine.clientsCount });
});

// List all rooms (requires internal secret)
app.get('/rooms', verifyInternalSecret, (req, res) => {
    const rooms = Array.from(io.sockets.adapter.rooms.keys());
    log('HTTP', 'Rooms list requested', { rooms });
    res.json({ rooms });
});

// ============================================
// SOCKET.IO CONNECTION HANDLING
// ============================================

io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    const userType = socket.handshake.query.user_type || 'user';

    log('AUTH', 'Connection attempt', {
        hasToken: !!token,
        userType,
        ip: socket.handshake.address
    });

    // Allow logs viewer without authentication
    if (userType === 'logs_viewer') {
        log('AUTH', 'Logs viewer: allowing unauthenticated connection');
        socket.user = { id: 'logs-viewer', type: 'logs_viewer', name: 'Logs Viewer' };
        return next();
    }

    // Skip auth for development/testing if no token
    if (!token && process.env.NODE_ENV === 'development') {
        log('AUTH', 'Dev mode: allowing unauthenticated connection');
        socket.user = { id: 'dev-user', type: 'dev', name: 'Dev User' };
        return next();
    }

    if (!token) {
        return next(new Error('Authentication required'));
    }

    const authResult = await validateSanctumToken(token, userType);

    if (!authResult) {
        return next(new Error('Invalid token'));
    }

    socket.user = authResult.user;
    socket.userType = authResult.type;
    next();
});

io.on('connection', (socket) => {
    log('SOCKET', `New connection: ${socket.id}`, {
        user: socket.user,
        type: socket.userType
    });

    // Join personal room based on user type
    if (socket.user && socket.user.id) {
        const personalRoom = `${socket.userType || 'user'}:${socket.user.id}`;
        socket.join(personalRoom);
        log('SOCKET', `Joined personal room: ${personalRoom}`);
    }

    // Join trip room if specified
    const tripId = socket.handshake.query.trip_id;
    if (tripId) {
        const roomName = `trip:${tripId}`;
        socket.join(roomName);
        log('SOCKET', `Joined trip room: ${roomName}`);

        // Notify others in the room
        socket.to(roomName).emit('user:joined', {
            socketId: socket.id,
            user: socket.user,
            userType: socket.userType,
            tripId
        });
    }

    // Handle joining/leaving trip rooms dynamically
    socket.on('join:trip', (data) => {
        const roomName = `trip:${data.trip_id}`;
        socket.join(roomName);
        log('SOCKET', `${socket.id} joined room: ${roomName}`);

        socket.to(roomName).emit('user:joined', {
            socketId: socket.id,
            user: socket.user,
            userType: socket.userType,
            tripId: data.trip_id
        });
    });

    socket.on('leave:trip', (data) => {
        const roomName = `trip:${data.trip_id}`;
        socket.leave(roomName);
        log('SOCKET', `${socket.id} left room: ${roomName}`);

        socket.to(roomName).emit('user:left', {
            socketId: socket.id,
            user: socket.user,
            tripId: data.trip_id
        });
    });

    // Handle location updates from driver
    socket.on('driver:location', (data) => {
        log('SOCKET', `Location update from ${socket.id}`, data);

        const tripId = data.trip_id || socket.handshake.query.trip_id;
        if (tripId) {
            socket.to(`trip:${tripId}`).emit('driver:location', {
                ...data,
                driver_id: socket.user?.id,
                timestamp: Date.now()
            });
            log('SOCKET', `Broadcasted location to trip:${tripId}`);
        }
    });

    // Test event - echo back
    socket.on('test', (data) => {
        log('SOCKET', `Test event from ${socket.id}`, data);
        socket.emit('test:response', {
            received: data,
            user: socket.user,
            message: 'Socket.io is working!',
            timestamp: Date.now()
        });
    });

    // Handle disconnect
    socket.on('disconnect', (reason) => {
        log('SOCKET', `Disconnected: ${socket.id}, reason: ${reason}`);

        if (tripId) {
            socket.to(`trip:${tripId}`).emit('user:left', {
                socketId: socket.id,
                user: socket.user,
                tripId
            });
        }
    });
});

// ============================================
// START SERVER
// ============================================
server.listen(PORT, () => {
    log('SERVER', `Socket.io server running on port ${PORT}`);
    log('SERVER', `Environment: ${process.env.NODE_ENV || 'development'}`);
    log('SERVER', `Laravel API: ${LARAVEL_API_URL}`);
    log('SERVER', `Internal secret: ${INTERNAL_SECRET ? 'configured' : 'NOT SET!'}`);
});
