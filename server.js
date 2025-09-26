require('dotenv').config();
const { default: axios } = require('axios');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo();

// Middleware parse JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Socket.io config
io.attach(server, {
    pingInterval: process.env.PING_INTERVAL || 10000,
    pingTimeout: process.env.PING_TIMEOUT || 5000,
    cookie: false
});

// Store connected devices - single map with all info
let deviceMap = new Map(); // deviceId -> {socketId, type, connectedAt}

// === Helper Functions ===
function emitToDevice(deviceId, event, payload) {
    const info = deviceMap.get(deviceId);
    if (!info) {
        console.log(`Device ${deviceId} not connected`);
        return false;
    }
    io.to(info.socketId).emit(event, payload);
    console.log(`Sent ${event} to ${deviceId}`);
    return true;
}

function getDevicesByType(type) {
    const devices = [];
    deviceMap.forEach((info, deviceId) => {
        if (info.type === type) {
            devices.push({ deviceId, ...info });
        }
    });
    return devices;
}

function logConnectedDevices() {
    console.log('\nConnected Devices Status:');
    console.log(`Total devices: ${deviceMap.size}`);
    deviceMap.forEach((info, deviceId) => {
        console.log(`  - ${deviceId} (${info.type}) -> Socket: ${info.socketId}`);
    });
    console.log('');
}

// === Socket.IO events ===
io.on('connection', (socket) => {
    console.log('A user connected: ', socket.id);

    // Đăng ký device
    socket.on('register', (data) => {
        console.log('Device registered:', data);

        if (data.deviceId) {
            deviceMap.set(data.deviceId, {
                socketId: socket.id,
                type: data.deviceType || data.type,
                connectedAt: new Date()
            });

            console.log(`Device ${data.deviceId} (${data.deviceType || data.type}) registered with socket ${socket.id}`);
            logConnectedDevices();
        } else {
            console.log('Registration failed: deviceId is required');
        }
    });

    // Khi disconnect
    socket.on('disconnect', () => {
        console.log('A user disconnected: ', socket.id);

        // Find and remove device by socketId
        let disconnectedDevice = null;
        deviceMap.forEach((info, deviceId) => {
            if (info.socketId === socket.id) {
                disconnectedDevice = { deviceId, ...info };
                deviceMap.delete(deviceId);
            }
        });

        if (disconnectedDevice) {
            console.log(`Device ${disconnectedDevice.deviceId} (${disconnectedDevice.type}) disconnected`);
            logConnectedDevices();
        }
    });

    // Cảnh báo RFID
    socket.on('send_command_check_rfid_warning', async (rfids) => {
        try {
            console.log('received warning from: ' + socket.id + " - " + rfids);
            const apiUrl = `${process.env.API_BACKEND_NEXTJS_URL}/api/v1/assets/warning`;
            const response = await axios.post(apiUrl, rfids);
            console.log('Response: ', response.data);
            socket.emit('receive_command_check_rfid_warning', true);
        } catch (err) {
            console.error('Error fetching warning data: ', err);
        }
    });

    // Arduino yêu cầu Camera chụp ảnh
    socket.on('send_request_capture', (data) => {
        console.log('Arduino requests camera capture:', data);

        if (data.deviceReceive) {
            const deviceInfo = deviceMap.get(data.deviceReceive);
            if (deviceInfo && deviceInfo.type === 'camera') {
                emitToDevice(data.deviceReceive, 'receive_request_capture', { deviceId: data.deviceReceive });
            } else if (!deviceInfo) {
                console.log(`Camera ${data.deviceReceive} not found`);
            } else {
                console.log(`Device ${data.deviceReceive} is not a camera (type: ${deviceInfo.type})`);
            }
        }
    });

    // Camera yêu cầu RFID quét
    socket.on('send_command_start_motion_scan', (data) => {
        // data = { deviceId: 'ESP32_CAM_01', deviceReceive: 'ESP32_RFID_01'}
        console.log('Received send_command_start_motion_scan from camera:', data);

        if (data.deviceReceive) {
            // Target specific RFID device
            const deviceInfo = deviceMap.get(data.deviceReceive);
            if (deviceInfo && deviceInfo.type === 'rfid') {
                emitToDevice(data.deviceReceive, 'receive_command_start_motion_scan', {
                    duration: 20000,
                    deviceId: data.deviceReceive,
                });
            } else if (!deviceInfo) {
                console.log(`RFID device ${data.deviceReceive} not found`);
            } else {
                console.log(`Device ${data.deviceReceive} is not an RFID device (type: ${deviceInfo.type})`);
            }
        }
    });
});

// === REST API ===
app.get('/api/devices', (req, res) => {
    const devices = Array.from(deviceMap.entries()).map(([deviceId, info]) => ({
        deviceId,
        socketId: info.socketId,
        type: info.type,
        connectedAt: info.connectedAt,
        online: true
    }));

    res.json({
        success: true,
        devices: devices,
        total: devices.length,
        devicesByType: {
            camera: getDevicesByType('camera').length,
            rfid: getDevicesByType('rfid').length,
            arduino: getDevicesByType('arduino').length
        }
    });
});

app.post('/api/test-device', (req, res) => {
    const { deviceId, message = 'test' } = req.body;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: 'deviceId is required' });
    }

    const success = emitToDevice(deviceId, 'test_message', { 
        message, 
        timestamp: new Date(), 
        from: 'server' 
    });

    if (success) {
        res.json({ 
            success: true, 
            message: `Test message sent to ${deviceId}`,
            deviceInfo: deviceMap.get(deviceId)
        });
    } else {
        res.status(404).json({
            success: false,
            message: `Device ${deviceId} not found or not connected`,
            availableDevices: Array.from(deviceMap.keys())
        });
    }
});

app.post('/api/capture-image', (req, res) => {
    const { cameraId, source = 'manual' } = req.body;

    if (cameraId) {
        // Target specific camera
        const deviceInfo = deviceMap.get(cameraId);
        if (deviceInfo && deviceInfo.type === 'camera') {
            const success = emitToDevice(cameraId, 'captureCommand', {
                command: 'capture',
                source: source,
                requestId: Date.now()
            });

            if (success) {
                res.json({
                    success: true,
                    message: `Capture command sent to camera ${cameraId}`,
                    cameraId: cameraId,
                    source: source
                });
            } else {
                res.status(500).json({
                    success: false,
                    message: `Failed to send capture command to camera ${cameraId}`
                });
            }
        } else if (!deviceInfo) {
            res.status(404).json({
                success: false,
                message: `Camera ${cameraId} not found`
            });
        } else {
            res.status(400).json({
                success: false,
                message: `Device ${cameraId} is not a camera (type: ${deviceInfo.type})`
            });
        }
    } else {
        // Broadcast to all cameras
        const cameras = getDevicesByType('camera');
        let successCount = 0;

        cameras.forEach(camera => {
            const success = emitToDevice(camera.deviceId, 'captureCommand', {
                command: 'capture',
                source: source,
                requestId: Date.now()
            });
            if (success) successCount++;
        });

        if (cameras.length > 0) {
            res.json({
                success: true,
                message: `Capture command sent to ${successCount}/${cameras.length} cameras`,
                devicesCount: successCount,
                source: source
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'No cameras connected'
            });
        }
    }
});

app.post('/api/motion-scan', (req, res) => {
    const { rfidId, cameraId, duration = 20000 } = req.body;

    if (rfidId) {
        // Target specific RFID device
        const deviceInfo = deviceMap.get(rfidId);
        if (deviceInfo && deviceInfo.type === 'rfid') {
            const success = emitToDevice(rfidId, 'receive_command_start_motion_scan', {
                duration: duration,
                deviceId: cameraId || 'manual',
                cameraId: cameraId || 'manual'
            });

            if (success) {
                res.json({
                    success: true,
                    message: `Motion scan command sent to RFID ${rfidId}`,
                    rfidId: rfidId,
                    duration: duration
                });
            } else {
                res.status(500).json({
                    success: false,
                    message: `Failed to send motion scan command to RFID ${rfidId}`
                });
            }
        } else if (!deviceInfo) {
            res.status(404).json({
                success: false,
                message: `RFID device ${rfidId} not found`
            });
        } else {
            res.status(400).json({
                success: false,
                message: `Device ${rfidId} is not an RFID device (type: ${deviceInfo.type})`
            });
        }
    } else {
        // Broadcast to all RFID devices
        const rfidDevices = getDevicesByType('rfid');
        let successCount = 0;

        rfidDevices.forEach(rfid => {
            const success = emitToDevice(rfid.deviceId, 'receive_command_start_motion_scan', {
                duration: duration,
                deviceId: cameraId || 'manual',
                cameraId: cameraId || 'manual'
            });
            if (success) successCount++;
        });

        if (rfidDevices.length > 0) {
            res.json({
                success: true,
                message: `Motion scan command sent to ${successCount}/${rfidDevices.length} RFID devices`,
                devicesCount: successCount,
                duration: duration
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'No RFID devices connected'
            });
        }
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        server: 'Socket.IO Server',
        version: '2.0.0',
        uptime: process.uptime(),
        connectedDevices: deviceMap.size,
        devicesByType: {
            camera: getDevicesByType('camera').length,
            rfid: getDevicesByType('rfid').length,
            arduino: getDevicesByType('arduino').length
        },
        timestamp: new Date()
    });
});

app.get('/api/test-env', (req, res) => {
    res.json({
        success: true,
        message: 'Environment variables test',
        environment: {
            API_BASE_URL: process.env.API_BACKEND_NEXTJS_URL,
            PORT: process.env.PORT,
            PING_INTERVAL: process.env.PING_INTERVAL,
            PING_TIMEOUT: process.env.PING_TIMEOUT,
            NODE_ENV: process.env.NODE_ENV || 'development'
        },
        constructedApiUrl: `${process.env.API_BACKEND_NEXTJS_URL}/api/v1/assets/warning`,
        timestamp: new Date()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date() });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Socket.IO Server v2.0 listening on *:${PORT}`);
    console.log('API Endpoints:');
    console.log('   GET  /api/devices       - List connected devices');
    console.log('   POST /api/test-device   - Test device communication');
    console.log('   POST /api/capture-image - Send capture command to cameras');
    console.log('   POST /api/motion-scan   - Send motion scan command to RFID devices');
    console.log('   GET  /api/status        - Server status');
    console.log('   GET  /api/test-env      - Test environment variables');
    console.log('   GET  /health            - Health check');
    console.log('');
    console.log('WebSocket Events:');
    console.log('   register                       - Device registration');
    console.log('   send_command_start_motion_scan    - Camera → RFID motion scan');
    console.log('   send_request_capture              - Arduino → Camera capture');
    console.log('   send_command_check_rfid_warning  - RFID warning check');
});
