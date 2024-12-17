import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs-extra';
import multer from 'multer';
import WebTorrent from 'webtorrent';
import crypto from 'crypto';
import session from 'express-session';
import FileStore from 'session-file-store';
import cookieParser from 'cookie-parser';
import fetch from 'node-fetch';
import path from 'path';
import compression from 'compression';
import { setupWebSocketServer } from './sync-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FileStoreSession = FileStore(session);

// Track active downloads
const activeDownloads = new Map();

// Video format content types with codecs for better playback
const videoContentTypes = {
    '.mp4': 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    '.webm': 'video/webm; codecs="vp8, vorbis"',
    '.ogg': 'video/ogg; codecs="theora, vorbis"',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.m4v': 'video/x-m4v',
    '.ts': 'video/mp2t',
    '.3gp': 'video/3gpp',
    '.m3u8': 'application/x-mpegURL'
};

// Cache and streaming optimization settings
const CACHE_CONTROL_HEADER = 'public, max-age=3600'; // 1 hour cache
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks for better streaming
const MAX_CHUNK_SIZE = 5 * 1024 * 1024; // 5MB max chunk size
const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1MB default chunk size

// Initialize WebTorrent with optimized settings
const client = new WebTorrent({
    maxConns: 100,
    nodeId: crypto.randomBytes(20),
    tracker: {
        announce: [
            "wss://tracker.openwebtorrent.com",
            "wss://tracker.btorrent.xyz",
            "wss://tracker.files.fm:7073/announce",
            "ws://tracker.files.fm:7072/announce",
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://tracker.openbittorrent.com:6969/announce",
            "udp://open.stealth.si:80/announce",
        ]
    }
});

// Keep track of WebTorrent client state
let isClientDestroyed = false;

// Ensure WebTorrent client stays alive
client.on('error', (err) => {
    console.error('WebTorrent client error:', err);
    if (!isClientDestroyed) {
        client.destroy((err) => {
            if (err) console.error('Error destroying client:', err);
            isClientDestroyed = true;
            setTimeout(() => {
                client.reinit();
                isClientDestroyed = false;
            }, 1000);
        });
    }
});

const app = express();

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const moviesDir = join(__dirname, 'movies');
        if (!fs.existsSync(moviesDir)) {
            fs.mkdirSync(moviesDir);
        }
        cb(null, 'movies/');
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage: storage });

// Middleware
app.use(express.json());
app.use(cookieParser());

// Enable compression for all responses
app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
        // Don't compress video streams
        if (req.path.startsWith('/stream/')) return false;
        return compression.filter(req, res);
    }
}));

// Session configuration
app.use(session({
    store: new FileStoreSession({
        path: './sessions',
        ttl: 86400,
        retries: 0
    }),
    secret: 'super-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// Auth middleware
const auth = (req, res, next) => {
    const publicPaths = ['/login.html', '/auth/login', '/movie-config', '/movies', '/stream'];
    
    if (publicPaths.some(path => req.path.startsWith(path))) {
        return next();
    }

    if (req.session.authenticated) {
        return next();
    }

    res.redirect('/login.html');
};

// Apply auth middleware
app.use(auth);

// Serve static files with caching
app.use(express.static('public', {
    maxAge: '1h',
    etag: true,
    lastModified: true
}));

// Auth routes
app.post('/auth/login', (req, res) => {
    const { password } = req.body;
    
    if (password === "CHICKENBUTT") {
        req.session.authenticated = true;
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Session save failed' });
            }
            res.json({ 
                success: true, 
                redirectUrl: '/index.html'
            });
        });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

// Movie configuration endpoints
app.get('/movie-config/:id', (req, res) => {
    const configPath = join(__dirname, 'movieConfig.json');
    const movieId = req.params.id;
    
    try {
        let config = {};
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        
        const movieConfig = config[movieId] || {
            title: `Movie ${movieId.replace('movie', '')}`,
            description: `Description for Movie ${movieId.replace('movie', '')}`
        };

        if (movieConfig.filename) {
            const ext = path.extname(movieConfig.filename).toLowerCase();
            movieConfig.fileType = videoContentTypes[ext] || 'video/mp4';
        }

        res.json(movieConfig);
    } catch (error) {
        console.error('Error reading config:', error);
        res.status(500).json({ error: 'Failed to read config' });
    }
});

app.get('/movies', (req, res) => {
    const configPath = join(__dirname, 'movieConfig.json');
    let config = {};
    
    try {
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }

        // Transform config to movie data with proper source URLs
        const movieData = {};
        for (const [slot, movie] of Object.entries(config)) {
            movieData[slot] = {
                title: movie.title || `Movie ${slot.replace('movie', '')}`,
                description: movie.description || `Description for Movie ${slot.replace('movie', '')}`,
                source: movie.filename ? `/stream/${movie.filename}` : ""
            };
        }

        // Get list of available files
        const availableFiles = fs.readdirSync(join(__dirname, 'movies'))
            .filter(file => videoContentTypes[path.extname(file).toLowerCase()]);

        // Check if request is from admin page (you can check headers or query params)
        const isAdmin = req.headers.referer && req.headers.referer.includes('admin.html');
        
        if (isAdmin) {
            // Return format expected by admin page
            res.json({
                availableFiles,
                config: movieData
            });
        } else {
            // Return format expected by index page
            res.json(movieData);
        }
    } catch (error) {
        console.error('Error reading movie config:', error);
        res.status(500).json({ error: 'Failed to read movie config' });
    }
});

// Enhanced streaming endpoint with optimizations
app.get('/stream/:filename', (req, res) => {
    const filePath = join(__dirname, 'movies', req.params.filename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('File not found');
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = videoContentTypes[ext] || 'video/mp4';

    // Handle range requests
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        let start = parseInt(parts[0], 10);
        let end = parts[1] ? parseInt(parts[1], 10) : start + DEFAULT_CHUNK_SIZE;
        
        // Ensure end doesn't exceed file size and chunk size is reasonable
        end = Math.min(end, fileSize - 1, start + MAX_CHUNK_SIZE);
        
        // Validate range
        if (start >= fileSize || end >= fileSize || start > end) {
            res.status(416).send('Requested range not satisfiable');
            return;
        }

        const chunksize = (end - start) + 1;
        const stream = fs.createReadStream(filePath, {
            start,
            end,
            highWaterMark: CHUNK_SIZE // Optimize buffer size
        });
        
        // Set streaming headers
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': contentType,
            'Cache-Control': CACHE_CONTROL_HEADER,
            'X-Content-Type-Options': 'nosniff'
        });

        // Handle stream errors
        stream.on('error', error => {
            console.error('Stream error:', error);
            if (!res.headersSent) {
                res.status(500).send('Error streaming file');
            }
        });

        // Pipe the stream with error handling
        stream.pipe(res).on('error', error => {
            console.error('Pipe error:', error);
        });
    } else {
        // For non-range requests, send entire file with caching headers
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': contentType,
            'Cache-Control': CACHE_CONTROL_HEADER,
            'Accept-Ranges': 'bytes',
            'X-Content-Type-Options': 'nosniff'
        });

        const stream = fs.createReadStream(filePath, {
            highWaterMark: CHUNK_SIZE // Optimize buffer size
        });
        
        stream.on('error', error => {
            console.error('Stream error:', error);
            if (!res.headersSent) {
                res.status(500).send('Error streaming file');
            }
        });

        stream.pipe(res).on('error', error => {
            console.error('Pipe error:', error);
        });
    }
});

// Endpoint to update movie details
app.post('/admin/update-movie', (req, res) => {
    const { slot, filename, title, description } = req.body;
    const configPath = join(__dirname, 'movieConfig.json');

    try {
        let config = {};
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }

        // Update the movie configuration
        config[slot] = {
            filename,
            title,
            description
        };

        // Write the updated configuration back to the file
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

        res.json({ success: true });
    } catch (error) {
        console.error('Error updating movie config:', error);
        res.status(500).json({ error: 'Failed to update movie config' });
    }
});

// Endpoint to delete a movie
app.post('/admin/delete-movie', (req, res) => {
    const { filename } = req.body;
    const filePath = join(__dirname, 'movies', filename);
    const configPath = join(__dirname, 'movieConfig.json');

    try {
        // Delete the file
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        // Update config to remove references to the deleted file
        if (fs.existsSync(configPath)) {
            let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            
            // Remove file from any slots that were using it
            for (const [slot, movie] of Object.entries(config)) {
                if (movie.filename === filename) {
                    delete config[slot].filename;
                }
            }

            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting movie:', error);
        res.status(500).json({ error: 'Failed to delete movie' });
    }
});

// Endpoint to start a torrent download
app.post('/admin/start-torrent', (req, res) => {
    const { magnetLink } = req.body;
    
    if (!magnetLink) {
        return res.status(400).json({ error: 'Magnet link is required' });
    }

    try {
        client.add(magnetLink, { path: join(__dirname, 'movies') }, (torrent) => {
            // Track this download
            const downloadId = crypto.randomBytes(16).toString('hex');
            activeDownloads.set(downloadId, torrent);

            // Set up progress tracking
            torrent.on('download', () => {
                console.log('Download progress:', torrent.progress);
            });

            torrent.on('done', () => {
                console.log('Torrent download finished');
                activeDownloads.delete(downloadId);
            });

            torrent.on('error', (err) => {
                console.error('Torrent error:', err);
                activeDownloads.delete(downloadId);
            });

            res.json({ success: true, downloadId });
        });
    } catch (error) {
        console.error('Error starting torrent:', error);
        res.status(500).json({ error: 'Failed to start torrent download' });
    }
});

// Endpoint to start a direct download
app.post('/admin/start-direct-download', async (req, res) => {
    const { url, filename } = req.body;
    
    if (!url || !filename) {
        return res.status(400).json({ error: 'URL and filename are required' });
    }

    const downloadPath = join(__dirname, 'movies', filename);
    const downloadId = crypto.randomBytes(16).toString('hex');

    try {
        // Start the download
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Create write stream
        const fileStream = fs.createWriteStream(downloadPath);
        
        // Track this download
        activeDownloads.set(downloadId, { url, filename, stream: fileStream });

        // Pipe the download to file
        response.body.pipe(fileStream);

        // Handle completion
        fileStream.on('finish', () => {
            console.log('Direct download finished');
            activeDownloads.delete(downloadId);
            fileStream.close();
        });

        // Handle errors
        fileStream.on('error', (error) => {
            console.error('Download error:', error);
            activeDownloads.delete(downloadId);
            fileStream.close();
            if (fs.existsSync(downloadPath)) {
                fs.unlinkSync(downloadPath);
            }
        });

        res.json({ success: true, downloadId });
    } catch (error) {
        console.error('Error starting direct download:', error);
        if (fs.existsSync(downloadPath)) {
            fs.unlinkSync(downloadPath);
        }
        res.status(500).json({ error: 'Failed to start direct download' });
    }
});

// Start server with improved settings
const server = app.listen(3000, '0.0.0.0', () => {
    console.log('Server running on port 3000');
}).on('error', function(err) {
    console.error('Server error:', err);
});

// Set up WebSocket server
setupWebSocketServer(server);

// Optimize server for video streaming
server.setTimeout(600000); // 10 minutes timeout
server.maxHeadersCount = 100;
server.keepAliveTimeout = 5000; // 5 seconds keep-alive
server.headersTimeout = 60000; // 1 minute headers timeout

// Handle process events
process.on('SIGINT', async () => {
    console.log('Gracefully shutting down...');
    const activeDownloadCount = activeDownloads.size + client.torrents.length;
    if (activeDownloadCount > 0) {
        console.log(`Waiting for ${activeDownloadCount} active downloads to complete...`);
    }
    client.destroy((err) => {
        if (err) console.error('Error destroying WebTorrent client:', err);
        process.exit(0);
    });
});

process.on('uncaughtException', function(err) {
    console.error('Caught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
