require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const multer = require("multer");
const fs = require("fs");
const { Client } = require("@neondatabase/serverless");
const readXlsxFile = require("read-excel-file/node");

const app = express();
const PORT = process.env.PORT || 8000;

// Neon DB client
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(() => console.log("Neon client connected"))
  .catch(err => console.error("Neon connection error:", err));

app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://email-frontend-two-eta.vercel.app"
  ],
  methods: ["GET", "POST"]
}));
app.use(express.json());

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads";
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ----------------------
// Single Email Route
// ----------------------
app.post("/send-email", upload.array("attachments", 10), async (req, res) => {
  const { to, subject, text } = req.body;

  if (!to || !subject || !text) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

  const attachments = req.files?.map(file => ({
    filename: file.originalname,
    path: file.path,
  })) || [];

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text,
      attachments,
    });

    // Save to DB
    await client.query(
      `INSERT INTO sent_emails (recipient, subject, body, sent_at, attachments)
       VALUES ($1, $2, $3, NOW(), $4)`,
      [to, subject, text, attachments.map(f => f.filename)]
    );

    // Delete uploaded files
    attachments.forEach(f => fs.unlinkSync(f.path));

    res.json({ success: true, message: "Email sent and saved successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error sending email", error: err.message });
  }
});

// ----------------------
// Excel Bulk Email Route
// ----------------------
app.post("/import-excel", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

  try {
    const rows = await readXlsxFile(req.file.path);
    const header = rows.shift(); // remove header
    let sentCount = 0;

    for (const row of rows) {
      const [name, email, subject, message] = row;
      if (email && subject && message) {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: email,
          subject,
          text: message,
        });

        await client.query(
          `INSERT INTO sent_emails (recipient, subject, body, sent_at, attachments)
           VALUES ($1, $2, $3, NOW(), $4)`,
          [email, subject, message, []]
        );

        sentCount++;
      }
    }

    fs.unlinkSync(req.file.path);

    res.json({ success: true, message: `${sentCount} emails sent successfully!` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to send emails", error: err.message });
  }
});

// ----------------------
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
