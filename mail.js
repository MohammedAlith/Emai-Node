require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const multer = require("multer");
const fs = require("fs");
const { Client } = require("@neondatabase/serverless");
const { google } = require("googleapis");
const readXlsxFile = require("read-excel-file/node");

const app = express();
const PORT = process.env.PORT || 8000;


const requiredEnv = [
  "DATABASE_URL",
  "EMAIL_USER",
  "EMAIL_PASS",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REDIRECT_URI",
  "GMAIL_REFRESH_TOKEN",
];
let missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(" Missing environment variables:", missingEnv.join(", "));
}


const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(() => console.log(" Neon client connected"))
  .catch(err => console.error(" Neon connection error:", err.message));


const createTables = async () => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS sent_emails (
      id SERIAL PRIMARY KEY,
      recipient TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      attachments TEXT[]
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS received_emails (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      received_at TIMESTAMPTZ
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS refresh_emails (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      received_at TIMESTAMPTZ
    );
  `);

  console.log(" Database tables ready");
};


app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://email-frontend-two-eta.vercel.app"
  ],
  methods: ["GET", "POST"]
}));
app.use(express.json());


const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads";
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });


const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});


const oAuth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

const htmlToText = (html) => {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

const getBody = (part) => {
  if (!part) return "";
  if (part.body?.data) {
    const decoded = Buffer.from(part.body.data, "base64").toString("utf-8");
    return htmlToText(decoded);
  }
  if (part.parts && part.parts.length) {
    for (const p of part.parts) {
      const inner = getBody(p);
      if (inner) return inner;
    }
  }
  return "";
};


const fetchUnreadEmails = async (max) => {
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: max,
      q: "is:unread after:2025/09/12",
    });

    const messages = res.data.messages || [];
    if (!messages.length) return [];

    const emails = [];

    for (const msg of messages) {
      const fullMsg = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const headers = fullMsg.data.payload.headers;
      const from = headers.find(h => h.name === "From")?.value || "";
      const to = headers.find(h => h.name === "To")?.value || "";
      const subject = headers.find(h => h.name === "Subject")?.value || "";
      const dateHeader = headers.find(h => h.name === "Date")?.value || "";

      let dateISO = null;
      if (dateHeader) {
        const parsedDate = new Date(dateHeader);
        if (!isNaN(parsedDate)) dateISO = parsedDate.toISOString();
      }

      const body = getBody(fullMsg.data.payload);
      const email = { id: msg.id, from, to, subject, body, date: dateISO };
      emails.push(email);

      await client.query(
        `INSERT INTO received_emails (id, sender, recipient, subject, body, received_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING`,
        [msg.id, from, to, subject, body, dateISO]
      );
    }

    return emails;
  } catch (err) {
    console.error(" Error fetching unread emails:", err.message);
    return [];
  }
};




app.get("/emails/receive", async (req, res) => {
  const emails = await fetchUnreadEmails();
  res.json(emails);
});


app.get("/emails/sent", async (req, res) => {
  try {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    const result = await client.query(
      "SELECT * FROM sent_emails WHERE sent_at >= $1 AND sent_at < $2 limit 20",
      [startOfDay.toISOString(), endOfDay.toISOString()]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching sent emails:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


app.post("/send-email", upload.array("attachments", 10), async (req, res) => {
  const { to, subject, text } = req.body;
  if (!to || !subject || !text) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

  const attachments = req.files?.map(f => ({ filename: f.originalname, path: f.path })) || [];

  try {
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text, attachments });

    await client.query(
      `INSERT INTO sent_emails (recipient, subject, body, sent_at, attachments)
       VALUES ($1,$2,$3,NOW(),$4)`,
      [to, subject, text, attachments.map(f => f.filename)]
    );

    attachments.forEach(f => fs.unlinkSync(f.path));
    res.json({ success: true, message: "Email sent + saved!" });
  } catch (err) {
    console.error(" Error sending email:", err.message);
    res.status(500).json({ success: false, message: "Error sending email", error: err.message });
  }
});

app.post("/import-excel", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

  try {
    const rows = await readXlsxFile(req.file.path);
    rows.shift();
    let sentCount = 0;

    for (const row of rows) {
      const [name, email, subject, message] = row;
      if (email && subject && message) {
        await transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject, text: message });
        await client.query(
          `INSERT INTO sent_emails (recipient, subject, body, sent_at, attachments)
           VALUES ($1,$2,$3,NOW(),$4)`,
          [email, subject, message, []]
        );
        sentCount++;
      }
    }

    fs.unlinkSync(req.file.path);
    res.json({ success: true, message: `${sentCount} emails sent successfully!` });
  } catch (err) {
    console.error(" Error sending bulk emails:", err.message);
    res.status(500).json({ success: false, message: "Bulk send failed", error: err.message });
  }
});


app.get("/emails/refresh", async (req, res) => {
  try {
 
    const existingResult = await client.query(
      "SELECT id FROM received_emails"
    );
    const existingIds = existingResult.rows.map(r => r.id);

    const resGmail = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread",
      maxResults: 50
    });

    const messages = resGmail.data.messages || [];
    if (!messages.length) return res.json([]);

    const newEmails = [];

    for (const msg of messages) {
      // skip if already in received_emails
      if (existingIds.includes(msg.id)) continue;

      const fullMsg = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
      const headers = fullMsg.data.payload.headers;
      const from = headers.find(h => h.name === "From")?.value || "";
      const to = headers.find(h => h.name === "To")?.value || "";
      const subject = headers.find(h => h.name === "Subject")?.value || "";
      const dateHeader = headers.find(h => h.name === "Date")?.value || "";
      const dateISO = new Date(dateHeader).toISOString();
      const body = getBody(fullMsg.data.payload);

  
      await client.query(
        `INSERT INTO refresh_emails (id, sender, recipient, subject, body, received_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING`,
        [msg.id, from, to, subject, body, dateISO]
      );

      newEmails.push({ id: msg.id, from, to, subject, body, date: dateISO });
    }

    res.json(newEmails); 
  } catch (err) {
    console.error("Error refreshing emails:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


app.listen(PORT, async () => {
  try {
    await createTables();
    console.log(` Server running on http://localhost:${PORT}`);
  } catch (err) {
    console.error(" Error creating tables:", err.message);
  }
});
