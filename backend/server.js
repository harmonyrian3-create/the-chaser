require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const { Resend } = require('resend');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Tesseract = require('tesseract.js');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. SERVE FRONTEND FILES ---
const frontendPath = path.join(__dirname, '..', 'frontend');
console.log('📁 Serving frontend from:', frontendPath);
app.use(express.static(frontendPath));

// Explicit routes for HTML pages
app.get('/', (req, res) => res.sendFile(path.join(frontendPath, 'index.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(frontendPath, 'register.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(frontendPath, 'login.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(frontendPath, 'dashboard.html')));
app.get('/upload.html', (req, res) => res.sendFile(path.join(frontendPath, 'upload.html')));

// --- 2. CONNECT TO NEON DATABASE ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- 3. INITIALIZE APIs ---
const resend = new Resend(process.env.RESEND_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const upload = multer({ storage: multer.memoryStorage() });

// --- 4. CREATE / UPDATE TABLES ---
const initDB = async () => {
  try {
    // Create firms table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS firms (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        password TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Add password column if missing (for existing tables)
    await pool.query(`
      ALTER TABLE firms ADD COLUMN IF NOT EXISTS password TEXT;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        firm_id UUID REFERENCES firms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        status TEXT DEFAULT 'awaiting',
        last_reminder_sent TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS receipts (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        file_url TEXT,
        extracted_text TEXT,
        category TEXT,
        upload_date TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Database tables ready (password column added).');
  } catch (err) {
    console.error('❌ DB Init Error:', err.message);
  }
};
initDB();

// --- 5. API ENDPOINTS ---

app.get('/api/status', (req, res) => res.send('🚀 The Chaser API is alive!'));

// REGISTER
app.post('/api/firms', async (req, res) => {
  try {
    const { email, name, password } = req.body;
    const result = await pool.query(
      `INSERT INTO firms (email, name, password) VALUES ($1, $2, $3) RETURNING id, name, email`,
      [email, name, password]
    );
    res.json({ success: true, firm: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query(
      `SELECT id, name, email FROM firms WHERE email = $1 AND password = $2`,
      [email, password]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    res.json({ success: true, firm: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET CLIENTS FOR FIRM
app.get('/api/clients', async (req, res) => {
  try {
    const { firm_id } = req.query;
    if (!firm_id) return res.status(400).json({ error: 'firm_id required' });
    const result = await pool.query(
      `SELECT * FROM clients WHERE firm_id = $1 ORDER BY created_at DESC`,
      [firm_id]
    );
    res.json({ success: true, clients: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADD CLIENT
app.post('/api/clients', async (req, res) => {
  try {
    const { firm_id, name, email, phone } = req.body;
    const result = await pool.query(
      `INSERT INTO clients (firm_id, name, email, phone, status) 
       VALUES ($1, $2, $3, $4, 'awaiting') RETURNING *`,
      [firm_id, name, email, phone]
    );
    res.json({ success: true, client: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPLOAD RECEIPT
app.post('/api/upload-receipt', upload.single('receipt'), async (req, res) => {
  try {
    const { client_id } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });

    const { data: { text } } = await Tesseract.recognize(file.buffer, 'eng');
    const extractedText = text;

    const prompt = `Classify this receipt text into ONE word: "Meals", "Travel", "Supplies", or "Other". Receipt: """${extractedText}"""`;
    const result = await model.generateContent(prompt);
    const category = result.response.text().trim();

    await pool.query(
      `INSERT INTO receipts (client_id, file_url, extracted_text, category) VALUES ($1, $2, $3, $4)`,
      [client_id, 'processed_in_memory', extractedText, category]
    );
    await pool.query(`UPDATE clients SET status = 'uploaded' WHERE id = $1`, [client_id]);

    res.json({ success: true, category });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// SEND REMINDER
app.post('/api/send-reminder', async (req, res) => {
  try {
    const { client_id } = req.body;
    const result = await pool.query(
      `SELECT c.*, f.email as firm_email FROM clients c LEFT JOIN firms f ON c.firm_id = f.id WHERE c.id = $1`,
      [client_id]
    );
    const client = result.rows[0];
    if (!client) throw new Error('Client not found');

    const uploadLink = `${process.env.BASE_URL}/upload.html?client=${client.id}`;

    await resend.emails.send({
      from: 'The Chaser <onboarding@resend.dev>',
      to: [client.email],
      subject: '📄 Upload your receipts now!',
      html: `
        <h2>Hi ${client.name},</h2>
        <p>Please upload your Q3 receipts here:</p>
        <a href="${uploadLink}" style="background:#007bff;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Upload Now</a>
      `
    });

    await pool.query(
      `UPDATE clients SET last_reminder_sent = NOW(), status = 'reminded' WHERE id = $1`,
      [client_id]
    );

    res.json({ success: true, message: 'Reminder sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- CRON JOB (daily at 9 AM) ---
cron.schedule('0 9 * * *', async () => {
  console.log('⏰ Running daily nagging cron...');
  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const res = await pool.query(
      `SELECT id FROM clients WHERE status = 'awaiting' AND (last_reminder_sent IS NULL OR last_reminder_sent < $1)`,
      [threeDaysAgo]
    );
    for (let row of res.rows) {
      await fetch(`${process.env.BASE_URL}/api/send-reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: row.id }),
      });
    }
  } catch (err) { console.error('Cron failed:', err); }
});

// --- START SERVER ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 The Chaser running on port ${PORT}`);
  console.log(`📁 Frontend: ${frontendPath}`);
});