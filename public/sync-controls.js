import { useState, useEffect } from 'react';

export default function SyncControls() {
  const [syncId, setSyncId] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [ws, setWs] = useState(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const connectSync = () => {
    if (!syncId.trim()) return;
    
    // Use the same host and protocol as the main site
    const wsUrl = `wss://${window.location.host}/sync?syncId=${syncId}`;
    console.log('Connecting to WebSocket:', wsUrl);
    
    const newWs = new WebSocket(wsUrl);  // Create WebSocket connection FIRST
    
    // Set a connection timeout
    const connectionTimeout = setTimeout(() => {
      if (newWs.readyState !== WebSocket.OPEN) {
        newWs.close();
        alert('Failed to connect. Please try again.');
        setIsSyncing(false);
      }
    }, 5000);  // 5 second timeout

    newWs.onmessage = (event) => {
      console.log('Received message:', event.data); // Debug logging
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'sync_update':
          if (window.player && data.forced) {
            window.player.currentTime = data.timestamp;
            if (data.isPlaying) window.player.play();
            else window.player.pause();
          }
          break;
        case 'play_pause_update':
          if (window.player) {
            if (data.isPlaying) window.player.play();
            else window.player.pause();
          }
          break;
        case 'viewer_count':
          setViewerCount(data.count);
          break;
      }
    };
    
    newWs.onopen = () => {
      console.log('Connection opened successfully');
      clearTimeout(connectionTimeout);
      setIsSyncing(true);
      setWs(newWs);
      alert('Successfully connected!');
    };
    
    newWs.onclose = () => {
      console.log('Connection closed');
      setIsSyncing(false);
      setViewerCount(0);
      alert('Disconnected from sync session');
    };

    newWs.onerror = (error) => {
      console.error('WebSocket error:', error);
      alert('Error connecting to sync session. Please try again.');
      setIsSyncing(false);
    };

    setIsSyncing(true);
};

  const syncTimestamp = () => {
    if (ws && window.player) {
      ws.send(JSON.stringify({
        type: 'sync_timestamp',
        timestamp: window.player.currentTime,
        isPlaying: !window.player.paused
      }));
    }
  };

  const togglePlayAll = () => {
    if (ws && window.player) {
      const isPlaying = !window.player.paused;
      ws.send(JSON.stringify({
        type: 'play_pause',
        isPlaying: !isPlaying
      }));
      if (isPlaying) window.player.pause();
      else window.player.play();
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <button 
        onClick={() => setIsMenuOpen(!isMenuOpen)}
        className="bg-[#e67e22] text-white p-3 rounded-full shadow-lg hover:bg-[#d35400] transition-all"
      >
        <i className={`fas fa-users ${isSyncing ? 'text-green-400' : ''}`}></i>
      </button>

      {isMenuOpen && (
        <div className="absolute bottom-16 right-0 bg-[#2a2220] p-4 rounded-lg shadow-xl border border-[#e67e22]/10 backdrop-blur-md w-72">
          {!isSyncing ? (
            <div className="space-y-3">
              <input
                type="text"
                value={syncId}
                onChange={(e) => setSyncId(e.target.value)}
                placeholder="Enter Sync ID"
                className="w-full p-2 bg-[#1a1614] border border-[#e67e22]/20 rounded text-white"
              />
              <button
                onClick={connectSync}
                className="w-full bg-[#e67e22] text-white p-2 rounded hover:bg-[#d35400] transition-all"
              >
                Start Sync Session
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-white/80 text-sm">
                Sync ID: {syncId} • {viewerCount} viewer{viewerCount !== 1 ? 's' : ''}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={syncTimestamp}
                  className="bg-[#e67e22] text-white p-2 rounded hover:bg-[#d35400] transition-all"
                >
                  Sync Time
                </button>
                <button
                  onClick={togglePlayAll}
                  className="bg-[#e67e22] text-white p-2 rounded hover:bg-[#d35400] transition-all"
                >
                  Play/Pause All
                </button>
              </div>
              <button
                onClick={disconnectSync}
                className="w-full bg-red-500 text-white p-2 rounded hover:bg-red-600 transition-all"
              >
                End Sync
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}