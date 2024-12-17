import { WebSocketServer } from 'ws';
import { parse } from 'url';

const syncSessions = new Map();

function setupWebSocketServer(server) {
    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws, req) => {
        const { query } = parse(req.url, true);
        const syncId = query.syncId;
        let session;

        if (syncId) {
            if (!syncSessions.has(syncId)) {
                session = {
                    clients: new Set(),
                    lastTimestamp: 0,
                    isPlaying: false
                };
                syncSessions.set(syncId, session);
            } else {
                session = syncSessions.get(syncId);
            }

            session.clients.add(ws);

            // Send current session state to new client
            ws.send(JSON.stringify({
                type: 'sync_state',
                timestamp: session.lastTimestamp,
                isPlaying: session.isPlaying,
                viewerCount: session.clients.size
            }));

            // Broadcast viewer count update
            session.clients.forEach(client => {
                client.send(JSON.stringify({
                    type: 'viewer_count',
                    count: session.clients.size
                }));
            });
        }

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (!session) return;

                switch (data.type) {
                    case 'sync_timestamp':
                        session.lastTimestamp = data.timestamp;
                        session.isPlaying = data.isPlaying;
                        session.clients.forEach(client => {
                            if (client !== ws) {
                                client.send(JSON.stringify({
                                    type: 'sync_update',
                                    timestamp: data.timestamp,
                                    isPlaying: data.isPlaying,
                                    forced: true
                                }));
                            }
                        });
                        break;

                    case 'play_pause':
                        session.isPlaying = data.isPlaying;
                        session.clients.forEach(client => {
                            if (client !== ws) {
                                client.send(JSON.stringify({
                                    type: 'play_pause_update',
                                    isPlaying: data.isPlaying
                                }));
                            }
                        });
                        break;
                }
            } catch (error) {
                console.error('Error processing message:', error);
            }
        });

        ws.on('close', () => {
            if (session) {
                session.clients.delete(ws);
                if (session.clients.size === 0) {
                    syncSessions.delete(syncId);
                } else {
                    // Broadcast updated viewer count
                    session.clients.forEach(client => {
                        client.send(JSON.stringify({
                            type: 'viewer_count',
                            count: session.clients.size
                        }));
                    });
                }
            }
        });
    });

    return wss;
}

export { setupWebSocketServer };