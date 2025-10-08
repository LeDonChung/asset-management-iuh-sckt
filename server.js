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
    cors: {
        origin: ["http://localhost:3003", "http://localhost:3001", "http://localhost:3000"],
        methods: ["GET", "POST"],
        credentials: true
    },
    pingInterval: process.env.PING_INTERVAL || 10000,
    pingTimeout: process.env.PING_TIMEOUT || 5000,
    cookie: false
});

// Store connected IoT devices - single map with all info
let deviceMap = new Map(); // deviceId -> {socketId, type, connectedAt}

// Store connected users from frontend - separate map for user tracking  
let userMap = new Map(); // userId -> {socketId, connectedAt, userInfo}

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
function emitToUser(userId, event, payload) {
    const info = userMap.get(userId);
    if (!info) {
        console.log(`User ${userId} not connected`);
        return false;
    }
    io.to(info.socketId).emit(event, payload);
    console.log(`Sent ${event} to ${userId}`);
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
    console.log('\nConnected IoT Devices Status:');
    console.log(`Total devices: ${deviceMap.size}`);
    deviceMap.forEach((info, deviceId) => {
        console.log(`  - ${deviceId} (${info.type}) -> Socket: ${info.socketId}`);
    });
    console.log('');
}

function logConnectedUsers() {
    console.log('\nConnected Users Status:');
    console.log(`Total users: ${userMap.size}`);
    userMap.forEach((info, userId) => {
        console.log(`  - ${userId} (${info.userInfo?.username || 'Unknown'}) -> Socket: ${info.socketId}`);
    });
    console.log('');
}

// === Socket.IO events ===
io.on('connection', (socket) => {
    console.log('A user connected: ', socket.id);

    // Đăng ký IoT device (camera, RFID, arduino)
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

    // Đăng ký user từ frontend
    socket.on('register_user', (data) => {
        console.log('📝 User registration attempt:', data);

        if (data && data.userId) {
            userMap.set(data.userId, {
                socketId: socket.id,
                connectedAt: new Date(),
                userInfo: {
                    username: data.username || 'Unknown',
                    email: data.email || '',
                    role: data.role || ''
                }
            });

            console.log(`✅ User ${data.userId} (${data.username || 'Unknown'}) registered with socket ${socket.id}`);
            logConnectedUsers();

            // Gửi acknowledgment về client
            socket.emit('user_registered', {
                success: true,
                userId: data.userId,
                message: 'User registered successfully'
            });
        } else {
            console.log('❌ User registration failed: userId is required', data);
            socket.emit('user_registered', {
                success: false,
                message: 'userId is required'
            });
        }
    });

    // Khi disconnect
    socket.on('disconnect', () => {
        console.log('A connection disconnected: ', socket.id);

        // Find and remove device by socketId
        let disconnectedDevice = null;
        deviceMap.forEach((info, deviceId) => {
            if (info.socketId === socket.id) {
                disconnectedDevice = { deviceId, ...info };
                deviceMap.delete(deviceId);
            }
        });

        // Find and remove user by socketId
        let disconnectedUser = null;
        userMap.forEach((info, userId) => {
            if (info.socketId === socket.id) {
                disconnectedUser = { userId, ...info };
                userMap.delete(userId);
            }
        });

        if (disconnectedDevice) {
            console.log(`Device ${disconnectedDevice.deviceId} (${disconnectedDevice.type}) disconnected`);
            logConnectedDevices();
        }

        if (disconnectedUser) {
            console.log(`User ${disconnectedUser.userId} (${disconnectedUser.userInfo?.username || 'Unknown'}) disconnected`);
            logConnectedUsers();
        }
    });

    // Cảnh báo RFID
    socket.on('send_command_check_rfid_warning', async ({ rfids, roomId, deviceId }) => {
        try {
            // 1. Gọi API để lấy thông tin RFID alerts
            const apiUrl = `${process.env.API_BACKEND_NEXTJS_URL}/api/v1/alerts/get-user-rfid-alerts`;
            const { data: rfidAlerts } = await axios.post(apiUrl, rfids);

            // 2. Lọc ra các RFID cần cảnh báo (có userIds và allowMove = false)
            const warnings = rfidAlerts
                .filter(item => !item.allowMove && item.userIds?.length > 0)
                .map(item => ({
                    rfid: item.rfid,
                    userIds: item.userIds,
                    allowMove: item.allowMove,
                    assetId: item.assetId,
                }));

            if (warnings.length === 0) {
                return;
            }

            // 3. Chuẩn bị dữ liệu tạo alert trong backend
            const alertsToCreate = warnings.map(w => ({
                assetId: w.assetId,
                deviceId: deviceId,
                roomId,
            }));

            // 4. Gửi request tạo alert trong hệ thống
            const { data: warningData } = await axios.post(
                `${process.env.API_BACKEND_NEXTJS_URL}/api/v1/alerts/bulk`,
                alertsToCreate
            );

            // 5. Xử lý dữ liệu cảnh báo từ hệ thống
                console.error(`[RFID WARNING] Invalid warning data received:`, warningData.map(w => w.asset));

            // 6. Emit dữ liệu cảnh báo về thiết bị iot -> [alertId]
            socket.emit('receive_command_check_rfid_warning', warningData.map(w => w.id));
            // 7. Gửi thông báo đến người dùng (nếu cần)
            // trong warning có userIds và assetId
            // Chuẩn bị bộ dữ liệu gồm: [{ userIds: ..., warningData }]
            // userIds từ warning và cần so sánh với assetId trong warningData để lấy đúng cảnh báo
            const userWarnings = warnings.map(w => ({
                userIds: w.userIds,
                warningData: warningData.filter(alert => alert.asset?.rfid === w.rfid)
            }));
            console.log(`[RFID WARNING] Emit to users:`, userWarnings);
            // Gửi đến từng user
            userWarnings.forEach(uw => {
                uw.userIds.forEach(userId => {
                    emitToUser(userId, 'receive_alert', uw.warningData);
                });
            });

        } catch (error) {
            console.error(`[RFID WARNING] Error:`, error.message || error);
        }
    });

    socket.on('send_stop_buzzer', (deviceId) => {
        console.log('Received send_stop_buzzer from device:', deviceId);
        if (deviceId) {
            emitToDevice(deviceId, 'receive_stop_buzzer', { deviceId });
        }
    });
    // Arduino yêu cầu Camera chụp ảnh
    socket.on('send_request_capture', (data) => {
        console.log('Arduino requests camera capture:', data);

        if (data.deviceReceive) {
            const deviceInfo = deviceMap.get(data.deviceReceive);
            if (deviceInfo && deviceInfo.type === 'camera') {
                emitToDevice(data.deviceReceive, 'receive_request_capture', { deviceId: data.deviceReceive, alertIds: data.alertIds || [] });
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

    socket.on('receive_capture', async (data) => {
        console.log('📸 Received capture data from ESP32-CAM:', data);
        
        try {
            const { imageData, alertIds, deviceId } = data;
            
            if (!imageData || !alertIds || alertIds.length === 0) {
                console.log('❌ Invalid capture data - missing imageData or alertIds');
                return;
            }

            // Convert base64 to buffer
            const imageBuffer = Buffer.from(imageData, 'base64');
            
            // Tạo FormData để gửi đến endpoint updateAlertsImage
            const FormData = require('form-data');
            const form = new FormData();
            
            // Append file
            form.append('File', imageBuffer, {
                filename: 'capture.jpg',
                contentType: 'image/jpeg'
            });
            
            // Append alertIds as JSON string
            form.append('alertIds', JSON.stringify(alertIds));
            
            console.log('🔄 Calling updateAlertsImage endpoint...');
            
            // Gọi trực tiếp endpoint updateAlertsImage
            const response = await axios.post(
                `${process.env.API_BACKEND_NEXTJS_URL}/api/v1/alerts/update-alerts-image`,
                form,
                {
                    headers: {
                        ...form.getHeaders(),
                    },
                }
            );

            console.log('✅ Alerts updated successfully with uploaded image');

        } catch (error) {
            console.error('❌ Error processing capture:', error.message || error);
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

app.get('/api/users', (req, res) => {
    const users = Array.from(userMap.entries()).map(([userId, info]) => ({
        userId,
        socketId: info.socketId,
        connectedAt: info.connectedAt,
        userInfo: info.userInfo,
        online: true
    }));

    res.json({
        success: true,
        users: users,
        total: users.length
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
    console.log('   GET  /api/devices       - List connected IoT devices');
    console.log('   GET  /api/users         - List connected users');
    console.log('   POST /api/test-device   - Test device communication');
    console.log('   POST /api/capture-image - Send capture command to cameras');
    console.log('   POST /api/motion-scan   - Send motion scan command to RFID devices');
    console.log('   GET  /api/status        - Server status');
    console.log('   GET  /api/test-env      - Test environment variables');
    console.log('   GET  /health            - Health check');
    console.log('');
    console.log('WebSocket Events:');
    console.log('   register                       - IoT Device registration (camera, RFID, arduino)');
    console.log('   register_user                  - User registration from frontend');
    console.log('   send_command_start_motion_scan    - Camera → RFID motion scan');
    console.log('   send_request_capture              - Arduino → Camera capture');
    console.log('   send_command_check_rfid_warning  - RFID warning check');
});
