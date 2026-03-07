const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(session({
    secret: 'nanoagent-v7-secret',
    resave: false,
    saveUninitialized: false
}));

// MongoDB
mongoose.connect('mongodb://127.0.0.1:27017/nanoagent')
    .then(() => console.log('✅ Connected to MongoDB Locally!'))
    .catch(err => console.error('❌ MongoDB Error:', err));

const UserSchema = new mongoose.Schema({
    email: String,
    password: String,
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// Global auth state
global.isAgentUnlocked = false;
global.activeUserEmail = null;

// 📱 WhatsApp Bot
let whatsappGroups = [];
let pendingRemoteTask = null;
let WHATSAPP_TARGET = '+918840472962';
let waQR = null;
let waConnected = false;

console.log('📱 Initializing WhatsApp Client...');
const waClient = new Client({
    authStrategy: new LocalAuth({ clientId: 'nanoagent-client' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
});

waClient.on('qr', async (qr) => {
    waQR = await qrcode.toDataURL(qr);
    console.log('📱 QR CODE RECEIVED - Ready for scan!');
});

waClient.on('authenticated', () => console.log('🔐 WhatsApp Authenticated! Session saved.'));
waClient.on('auth_failure', () => console.error('❌ WhatsApp auth failed.'));

waClient.on('ready', async () => {
    waConnected = true;
    waQR = null;
    console.log('✅ WhatsApp Client Ready!');
    console.log('📱 Loading WhatsApp groups...');
    const chats = await waClient.getChats();
    whatsappGroups = chats.filter(c => c.isGroup).map(g => ({ id: g.id._serialized, name: g.name }));
    console.log(`📱 Found ${whatsappGroups.length} groups.`);
    console.log(`📱 WhatsApp target set (manual): ${WHATSAPP_TARGET}`);

    // Pre-load groups
    console.log('📱 Pre-loading WhatsApp groups (background)...');
    console.log(`📱 ✅ Pre-loaded ${whatsappGroups.length} groups!`);
});

// 📱 Listen for /nanoagent commands from WhatsApp
waClient.on('message_create', async msg => {
    if (!msg.fromMe) return;
    const body = (msg.body || '').trim();
    if (!body.toLowerCase().startsWith('/nanoagent ')) return;

    const task = body.substring('/nanoagent '.length).trim();
    if (!task) return;

    const chatId = msg.to || msg.from;
    console.log(`📱 WhatsApp Remote Task: ${task} [from: ${msg.from}, to: ${chatId}]`);

    pendingRemoteTask = task;

    try {
        await waClient.sendMessage(chatId, `🤖 *NanoAgent* received your task:\n\n_"${task}"_\n\n⏳ Processing...`);
    } catch (e) {
        console.log('📱 WhatsApp reply failed:', e.message);
    }
});

waClient.initialize();

// ======== ROUTES ========

// Views
app.get('/login', (req, res) => res.render('login'));
app.get('/signup', (req, res) => res.render('signup'));
app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('dashboard', { user: req.session.user });
});

// Auth API
app.post('/signup', async (req, res) => {
    const { email, password } = req.body;
    try {
        const existing = await User.findOne({ email });
        if (existing) return res.render('signup', { error: 'Email already registered.' });
        const hash = await bcrypt.hash(password, 10);
        await User.create({ email, password: hash });
        res.redirect('/login');
    } catch (err) {
        res.render('signup', { error: 'Signup failed.' });
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) return res.render('login', { error: 'User not found.' });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.render('login', { error: 'Invalid password.' });
        req.session.user = { email: user.email };
        global.isAgentUnlocked = true;
        global.activeUserEmail = user.email;
        res.redirect('/dashboard');
    } catch (err) {
        res.render('login', { error: 'Login failed.' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    global.isAgentUnlocked = false;
    global.activeUserEmail = null;
    res.redirect('/login');
});

// Extension Auth Check
app.get('/api/auth-status', (req, res) => {
    res.json({ authenticated: global.isAgentUnlocked, user: global.activeUserEmail });
});

// 📱 WhatsApp Status & Target APIs
app.get('/api/whatsapp-qr', (req, res) => {
    res.json({ connected: waConnected, qr: waQR, target: WHATSAPP_TARGET, groups: whatsappGroups });
});

app.post('/api/whatsapp-target-manual', (req, res) => {
    const { target } = req.body;
    if (!target) return res.status(400).json({ error: 'No target provided.' });
    WHATSAPP_TARGET = target;
    console.log(`📱 WhatsApp Manual Target updated to: ${WHATSAPP_TARGET}`);
    res.json({ success: true, target: WHATSAPP_TARGET });
});

// 📱 WhatsApp Remote Task Polling (extension polls this)
app.get('/api/whatsapp-poll', (req, res) => {
    if (pendingRemoteTask) {
        const task = pendingRemoteTask;
        pendingRemoteTask = null;
        console.log(`📱 Extension picked up remote task: ${task}`);
        res.json({ task });
    } else {
        res.json({ task: null });
    }
});

// 📱 WhatsApp Send (extension sends results back)
app.post('/api/whatsapp-send', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.json({ error: 'No message provided.' });

    try {
        const targetId = WHATSAPP_TARGET.replace('+', '') + '@c.us';
        await waClient.sendMessage(targetId, message);
        console.log(`📱 WhatsApp message sent to ${WHATSAPP_TARGET}`);
        res.json({ sent: true });
    } catch (err) {
        console.log('📱 WhatsApp send error:', err.message);
        res.json({ error: err.message });
    }
});

// Start server
app.listen(3000, () => {
    console.log('🚀 Web UI running on http://localhost:3000/login');
});
