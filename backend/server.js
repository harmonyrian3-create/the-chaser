require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const { Resend } = require('resend');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Tesseract = require('tesseract.js');
const cron = require('node-cron');
const path = require('path'); // <-- Added to handle file paths

const app = express();
app.use(cors());
app.use(express.json());

// 🔥 NEW: Serve your frontend files (index.html, upload.html)
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// --- 1. CONNECT TO NEON DATABASE ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- 2. INITIALIZE APIs ---
const resend = new Resend(process.env.RESEND_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const upload = multer({ storage: multer.memoryStorage() });

// --- 3. CREATE DATABASE TABLES ---
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS firms (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
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
    console.log('✅ Neon Database tables are ready!');
  } catch (err) {
    console.error('❌ DB Init Error:', err.message);
  }
};
initDB();

// --- 4. API ENDPOINTS ---

// Test endpoint
app.get('/api/status', (req, res) => res.send('🚀 The Chaser API is alive!'));

// 🔥 NEW: Add an accounting firm (This is your customer)
app.post('/api/firms', async (req, res) => {
  try {
    const { email, name } = req.body;
    const result = await pool.query(
      `INSERT INTO firms (email, name) VALUES ($1, $2) RETURNING *`,
      [email, name]
    );
    res.json({ success: true, firm: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new client (Your aunt/firm uses this)
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

// Upload receipt (Client uploads from the link in the email)
app.post('/api/upload-receipt', upload.single('receipt'), async (req, res) => {
  try {
    const { client_id } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    // OCR the receipt using Tesseract.js
    const { data: { text } } = await Tesseract.recognize(file.buffer, 'eng');
    const extractedText = text;

    // AI Categorization using Gemini
    const prompt = `Classify this receipt text into ONE word: "Meals", "Travel", "Supplies", or "Other". Receipt: """${extractedText}"""`;
    const result = await model.generateContent(prompt);
    const category = result.response.text().trim();

    // Save to database
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

// Send a reminder email (Manually or via Cron)
app.post('/api/send-reminder', async (req, res) => {
  try {
    const { client_id } = req.body;
    const result = await pool.query(
      `SELECT c.*, f.email as firm_email FROM clients c LEFT JOIN firms f ON c.firm_id = f.id WHERE c.id = $1`,
      [client_id]
    );
    const client = result.rows[0];
    if (!client) throw new Error('Client not found');

    // ✅ NOW this points to the correct local URL!
    const uploadLink = `${process.env.BASE_URL}/upload.html?client=${client.id}`;

    // Send professional email via Resend
    await resend.emails.send({
      from: 'The Chaser <onboarding@resend.dev>',
      to: [client.email],
      subject: '📄 Upload your receipts now! – Action Required',
      html: `
        <h2>Hi ${client.name},</h2>
        <p><strong>📌 Action Required:</strong> We are still waiting for your Q3 receipts.</p>
        <p>Please click the button below to upload them immediately:</p>
        <p><a href="${uploadLink}" style="background:#007bff;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;">Upload Receipts Now</a></p>
        <p><b>⏰ Deadline:</b> This Friday, or we will have to file an extension.</p>
        <p>Thank you,<br>Your Accounting Team</p>
      `,
    });

    await pool.query(
      `UPDATE clients SET last_reminder_sent = NOW(), status = 'reminded' WHERE id = $1`,
      [client_id]
    );

    res.json({ success: true, message: 'Reminder sent via Email' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- 5. CRON JOB (Runs daily at 9 AM to auto-nag) ---
cron.schedule('0 9 * * *', async () => {
  console.log('⏰ Running daily nagging cron job...');
  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const res = await pool.query(
      `SELECT id FROM clients WHERE status = 'awaiting' AND (last_reminder_sent IS NULL OR last_reminder_sent < $1)`,
      [threeDaysAgo]
    );
    console.log(`Found ${res.rows.length} clients to nag`);
    for (let row of res.rows) {
      await fetch(`${process.env.BASE_URL}/api/send-reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: row.id }),
      });
    }
  } catch (err) { console.error('Cron failed:', err); }
});

// --- 6. START THE SERVER ---
app.listen(process.env.PORT, () => console.log(`🚀 The Chaser running on port ${process.env.PORT}`));