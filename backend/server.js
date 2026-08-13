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
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// --- FRONTEND STATIC FILES ---
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

app.get('/', (req, res) => res.sendFile(path.join(frontendPath, 'index.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(frontendPath, 'register.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(frontendPath, 'login.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(frontendPath, 'dashboard.html')));
app.get('/pricing.html', (req, res) => res.sendFile(path.join(frontendPath, 'pricing.html')));
app.get('/receipts.html', (req, res) => res.sendFile(path.join(frontendPath, 'receipts.html')));
app.get('/settings.html', (req, res) => res.sendFile(path.join(frontendPath, 'settings.html')));
app.get('/upload.html', (req, res) => res.sendFile(path.join(frontendPath, 'upload.html')));
app.get('/forgot-password.html', (req, res) => res.sendFile(path.join(frontendPath, 'forgot-password.html')));
app.get('/reset-password.html', (req, res) => res.sendFile(path.join(frontendPath, 'reset-password.html')));
app.get('/verify-email.html', (req, res) => res.sendFile(path.join(frontendPath, 'verify-email.html')));
app.get('/privacy.html', (req, res) => res.sendFile(path.join(frontendPath, 'privacy.html')));
app.get('/terms.html', (req, res) => res.sendFile(path.join(frontendPath, 'terms.html')));

// --- DATABASE ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- APIs ---
const resend = new Resend(process.env.RESEND_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const upload = multer({ storage: multer.memoryStorage() });

// --- JWT MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
};

// --- INIT DB ---
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS firms (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        password TEXT,
        reset_token TEXT,
        reset_token_expiry TIMESTAMP,
        verification_token TEXT,
        verification_token_expiry TIMESTAMP,
        email_verified BOOLEAN DEFAULT FALSE,
        subscription_status TEXT DEFAULT 'trial',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`ALTER TABLE firms ADD COLUMN IF NOT EXISTS password TEXT;`);
    await pool.query(`ALTER TABLE firms ADD COLUMN IF NOT EXISTS reset_token TEXT;`);
    await pool.query(`ALTER TABLE firms ADD COLUMN IF NOT EXISTS reset_token_expiry TIMESTAMP;`);
    await pool.query(`ALTER TABLE firms ADD COLUMN IF NOT EXISTS verification_token TEXT;`);
    await pool.query(`ALTER TABLE firms ADD COLUMN IF NOT EXISTS verification_token_expiry TIMESTAMP;`);
    await pool.query(`ALTER TABLE firms ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE firms ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial';`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        firm_id UUID REFERENCES firms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        firm_id UUID REFERENCES firms(id) ON DELETE CASCADE,
        amount DECIMAL(10,2) NOT NULL,
        currency TEXT DEFAULT 'USD',
        status TEXT DEFAULT 'paid',
        invoice_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        firm_id UUID REFERENCES firms(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        password TEXT,
        role TEXT DEFAULT 'member',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Database ready.');
  } catch (err) { console.error('DB Init Error:', err.message); }
};
initDB();

// --- PUBLIC ROUTES ---
app.get('/api/status', (req, res) => res.send('🚀 API alive'));

// REGISTER
app.post('/api/firms', async (req, res) => {
  try {
    const { email, name, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO firms (email, name, password) VALUES ($1, $2, $3) RETURNING id, name, email`,
      [email, name, hashedPassword]
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
    let result = await pool.query(`SELECT * FROM firms WHERE email = $1`, [email]);
    let firm = result.rows[0];

    if (!firm) {
      const userResult = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
      if (userResult.rows.length > 0) {
        const user = userResult.rows[0];
        const firmResult = await pool.query(`SELECT * FROM firms WHERE id = $1`, [user.firm_id]);
        firm = firmResult.rows[0];
      }
    }

    if (!firm) return res.status(401).json({ error: 'Invalid credentials' });
    if (!firm.email_verified) {
      return res.status(401).json({ error: 'Please verify your email address first. Check your inbox and spam folder.' });
    }

    const valid = await bcrypt.compare(password, firm.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: firm.id, email: firm.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, firm: { id: firm.id, name: firm.name, email: firm.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SEND VERIFICATION
app.post('/api/send-verification', async (req, res) => {
  try {
    const { email } = req.body;
    const result = await pool.query(`SELECT * FROM firms WHERE email = $1`, [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Firm not found' });

    const firm = result.rows[0];
    if (firm.email_verified) return res.json({ success: true, message: 'Email already verified.' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 86400000);

    await pool.query(
      `UPDATE firms SET verification_token = $1, verification_token_expiry = $2 WHERE id = $3`,
      [token, expiry, firm.id]
    );

    const verifyLink = `${process.env.BASE_URL}/verify-email.html?token=${token}`;

    await resend.emails.send({
      from: 'The Chaser <onboarding@resend.dev>',
      to: [email],
      subject: '✅ Verify your email address',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <div style="background: #1e3a8a; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0;">📧 The Chaser</h1>
          </div>
          <div style="padding: 20px;">
            <h2 style="color: #1e293b;">Verify your email address</h2>
            <p style="color: #475569;">Click the button below to verify your email and activate your account.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${verifyLink}" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Verify Email</a>
            </div>
            <p style="color: #94a3b8; font-size: 12px;">This link expires in 24 hours. Check your spam folder if you don't see it.</p>
          </div>
          <div style="border-top: 1px solid #e2e8f0; padding: 10px; text-align: center; color: #94a3b8; font-size: 12px;">
            &copy; 2026 The Chaser. All rights reserved.
          </div>
        </div>
      `
    });

    res.json({ success: true, message: 'Verification email sent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// VERIFY EMAIL
app.get('/api/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const result = await pool.query(
      `SELECT * FROM firms WHERE verification_token = $1 AND verification_token_expiry > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired token. Please request a new verification email.' });
    }

    await pool.query(
      `UPDATE firms SET email_verified = TRUE, verification_token = NULL, verification_token_expiry = NULL WHERE id = $1`,
      [result.rows[0].id]
    );

    res.json({ success: true, message: 'Email verified successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// FORGOT PASSWORD
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const result = await pool.query(`SELECT * FROM firms WHERE email = $1`, [email]);
    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
    }

    const firm = result.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 3600000);

    await pool.query(
      `UPDATE firms SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3`,
      [token, expiry, firm.id]
    );

    const resetLink = `${process.env.BASE_URL}/reset-password.html?token=${token}`;

    await resend.emails.send({
      from: 'The Chaser <onboarding@resend.dev>',
      to: [email],
      subject: '🔑 Reset your password',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <div style="background: #1e3a8a; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0;">📧 The Chaser</h1>
          </div>
          <div style="padding: 20px;">
            <h2 style="color: #1e293b;">Reset your password</h2>
            <p style="color: #475569;">We received a request to reset your password. Click the button below to set a new one.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset Password</a>
            </div>
            <p style="color: #94a3b8; font-size: 12px;">This link expires in 1 hour. If you didn't request this, please ignore this email.</p>
          </div>
          <div style="border-top: 1px solid #e2e8f0; padding: 10px; text-align: center; color: #94a3b8; font-size: 12px;">
            &copy; 2026 The Chaser. All rights reserved.
          </div>
        </div>
      `
    });

    res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// RESET PASSWORD
app.post('/api/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const result = await pool.query(
      `SELECT * FROM firms WHERE reset_token = $1 AND reset_token_expiry > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired token.' });
    }

    const firm = result.rows[0];
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query(
      `UPDATE firms SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2`,
      [hashedPassword, firm.id]
    );

    res.json({ success: true, message: 'Password has been reset successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- PROTECTED ROUTES ---

// Get Firm Profile
app.get('/api/firms/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, name, email, subscription_status FROM firms WHERE id = $1`, [req.user.id]);
    res.json({ success: true, firm: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update Firm Profile
app.put('/api/firms/me', authenticateToken, async (req, res) => {
  try {
    const { name, email } = req.body;
    await pool.query(`UPDATE firms SET name = $1, email = $2 WHERE id = $3`, [name, email, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update Password
app.put('/api/firms/me/password', authenticateToken, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Min 6 chars' });
    const hashed = await bcrypt.hash(password, 10);
    await pool.query(`UPDATE firms SET password = $1 WHERE id = $2`, [hashed, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET CLIENTS
app.get('/api/clients', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM clients WHERE firm_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, clients: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ADD CLIENT
app.post('/api/clients', authenticateToken, async (req, res) => {
  try {
    const { name, email } = req.body;
    const result = await pool.query(
      `INSERT INTO clients (firm_id, name, email, status) VALUES ($1, $2, $3, 'awaiting') RETURNING *`,
      [req.user.id, name, email]
    );
    res.json({ success: true, client: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// UPDATE CLIENT
app.put('/api/clients/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email } = req.body;
    const check = await pool.query(`SELECT * FROM clients WHERE id = $1 AND firm_id = $2`, [id, req.user.id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Client not found' });

    await pool.query(
      `UPDATE clients SET name = $1, email = $2 WHERE id = $3`,
      [name, email, id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE CLIENT
app.delete('/api/clients/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(`SELECT * FROM clients WHERE id = $1 AND firm_id = $2`, [id, req.user.id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Client not found' });

    await pool.query(`DELETE FROM clients WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET RECEIPTS
app.get('/api/receipts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, c.name as client_name 
       FROM receipts r JOIN clients c ON r.client_id = c.id 
       WHERE c.firm_id = $1 ORDER BY r.upload_date DESC`,
      [req.user.id]
    );
    res.json({ success: true, receipts: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET ANALYTICS
app.get('/api/analytics', authenticateToken, async (req, res) => {
  try {
    const firmId = req.user.id;
    const totalRes = await pool.query(`SELECT COUNT(*) FROM clients WHERE firm_id = $1`, [firmId]);
    const totalClients = parseInt(totalRes.rows[0].count);

    const awaitingRes = await pool.query(`SELECT COUNT(*) FROM clients WHERE firm_id = $1 AND status = 'awaiting'`, [firmId]);
    const awaiting = parseInt(awaitingRes.rows[0].count);

    const uploadedRes = await pool.query(`SELECT COUNT(*) FROM clients WHERE firm_id = $1 AND status = 'uploaded'`, [firmId]);
    const uploaded = parseInt(uploadedRes.rows[0].count);

    const avgRes = await pool.query(`
      SELECT AVG(EXTRACT(EPOCH FROM (r.upload_date - c.created_at)) / 86400) as avg_days
      FROM clients c
      JOIN receipts r ON r.client_id = c.id
      WHERE c.firm_id = $1
    `, [firmId]);
    const avgResponseDays = avgRes.rows[0].avg_days ? parseFloat(avgRes.rows[0].avg_days).toFixed(1) : null;

    const receiptsRes = await pool.query(`
      SELECT COUNT(*) FROM receipts r JOIN clients c ON r.client_id = c.id WHERE c.firm_id = $1
    `, [firmId]);
    const totalReceipts = parseInt(receiptsRes.rows[0].count);

    res.json({
      success: true,
      analytics: {
        totalClients,
        awaiting,
        uploaded,
        totalReceipts,
        avgResponseDays: avgResponseDays ? `${avgResponseDays} days` : 'N/A'
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- BILLING HISTORY ---
app.get('/api/invoices', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM invoices WHERE firm_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, invoices: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- TEAM MANAGEMENT ---
app.post('/api/users/invite', authenticateToken, async (req, res) => {
  try {
    const { email, role } = req.body;
    const firmId = req.user.id;
    const existing = await pool.query(`SELECT * FROM users WHERE email = $1 AND firm_id = $2`, [email, firmId]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'User already invited' });
    }
    await pool.query(
      `INSERT INTO users (firm_id, email, role) VALUES ($1, $2, $3)`,
      [firmId, email, role || 'member']
    );
    res.json({ success: true, message: 'Invitation sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, role, created_at FROM users WHERE firm_id = $1`,
      [req.user.id]
    );
    res.json({ success: true, users: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM users WHERE id = $1 AND firm_id = $2`, [id, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// UPLOAD RECEIPT
app.post('/api/upload-receipt', upload.single('receipt'), async (req, res) => {
  try {
    const { client_id } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });

    const { data: { text } } = await Tesseract.recognize(file.buffer, 'eng');
    const prompt = `Classify this receipt into "Meals", "Travel", "Supplies", or "Other". Receipt: """${text}"""`;
    const result = await model.generateContent(prompt);
    const category = result.response.text().trim();

    await pool.query(
      `INSERT INTO receipts (client_id, file_url, extracted_text, category) VALUES ($1, $2, $3, $4)`,
      [client_id, 'processed_in_memory', text, category]
    );
    await pool.query(`UPDATE clients SET status = 'uploaded' WHERE id = $1`, [client_id]);
    res.json({ success: true, category });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// SEND REMINDER
app.post('/api/send-reminder', authenticateToken, async (req, res) => {
  try {
    const { client_id } = req.body;
    const check = await pool.query(`SELECT * FROM clients WHERE id = $1 AND firm_id = $2`, [client_id, req.user.id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Client not found' });

    const client = check.rows[0];
    const uploadLink = `${process.env.BASE_URL}/upload.html?client=${client.id}`;

    await resend.emails.send({
      from: 'The Chaser <onboarding@resend.dev>',
      to: [client.email],
      subject: `📄 Action Required: Upload your receipts for ${client.name}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <div style="background: #1e3a8a; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0;">📧 The Chaser</h1>
          </div>
          <div style="padding: 20px;">
            <h2 style="color: #1e293b;">Hi ${client.name},</h2>
            <p style="color: #475569;">We are still waiting for your Q3 receipts. Please upload them at your earliest convenience.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${uploadLink}" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Upload Receipts Now</a>
            </div>
            <p style="color: #94a3b8; font-size: 12px;">If you have already uploaded, please ignore this message.</p>
          </div>
          <div style="border-top: 1px solid #e2e8f0; padding: 10px; text-align: center; color: #94a3b8; font-size: 12px;">
            &copy; 2026 The Chaser. All rights reserved.
          </div>
        </div>
      `
    });

    await pool.query(`UPDATE clients SET last_reminder_sent = NOW(), status = 'reminded' WHERE id = $1`, [client_id]);
    res.json({ success: true, message: 'Reminder sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- CRON JOB ---
cron.schedule('0 9 * * *', async () => {
  console.log('⏰ Running daily nagging cron job...');
  try {
    const result = await pool.query(`
      SELECT c.id, c.name, c.email, c.firm_id 
      FROM clients c
      WHERE c.status = 'awaiting' 
      AND (c.last_reminder_sent IS NULL OR c.last_reminder_sent < NOW() - INTERVAL '3 days')
    `);
    console.log(`Found ${result.rows.length} clients to remind.`);
    for (let client of result.rows) {
      const uploadLink = `${process.env.BASE_URL}/upload.html?client=${client.id}`;
      try {
        await resend.emails.send({
          from: 'The Chaser <onboarding@resend.dev>',
          to: [client.email],
          subject: `📄 Reminder: Upload your receipts`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
              <div style="background: #1e3a8a; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
                <h1 style="color: white; margin: 0;">📧 The Chaser</h1>
              </div>
              <div style="padding: 20px;">
                <h2 style="color: #1e293b;">Hi ${client.name},</h2>
                <p style="color: #475569;">We noticed you haven't uploaded your receipts yet. Please do so as soon as possible.</p>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${uploadLink}" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Upload Receipts Now</a>
                </div>
              </div>
              <div style="border-top: 1px solid #e2e8f0; padding: 10px; text-align: center; color: #94a3b8; font-size: 12px;">
                &copy; 2026 The Chaser. All rights reserved.
              </div>
            </div>
          `
        });
        await pool.query(`UPDATE clients SET last_reminder_sent = NOW(), status = 'reminded' WHERE id = $1`, [client.id]);
        console.log(`Reminder sent to ${client.email}`);
      } catch (err) {
        console.error(`Failed to send reminder to ${client.email}:`, err.message);
      }
    }
  } catch (err) { console.error('Cron job failed:', err.message); }
});

// --- START ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Frontend path: ${frontendPath}`);
});