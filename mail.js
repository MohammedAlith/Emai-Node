require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const multer = require("multer");
const fs = require("fs");
const { Client } = require("@neondatabase/serverless");

const app = express();
const PORT = process.env.PORT || 8000;

// -----------------------------
// Neon DB client (serverless-safe)
// -----------------------------
const client = new Client({ connectionString: process.env.DATABASE_URL });

// Connect once at startup
client.connect()
  .then(() => console.log("Neon client connected"))
  .catch(err => console.error("Neon connection error:", err));

// -----------------------------
// Middleware
// -----------------------------
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://email-frontend-two-eta.vercel.app"
  ],
  methods: ["GET", "POST"]
}));
app.use(express.json());

// -----------------------------
// Multer config for file uploads
// -----------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads";
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

// -----------------------------
// Routes
// -----------------------------
app.get("/", (req, res) => {
  res.send("Server is running");
});

app.post("/send-email", upload.array("attachments", 10), async (req, res) => {
  const { to, subject, text } = req.body;

  if (!to || !subject || !text) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

  const attachments = req.files?.map(file => ({
    filename: file.originalname,
    path: file.path,
  }));

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS, // Use App Password
    },
  });

  try {
    // Send email
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text,
      attachments,
    });
    console.log("Email sent:", info.response);

    // Save email in Neon database (reuse the client)
    const attachmentNames = attachments?.map(f => f.filename) || [];
    await client.query(
      `INSERT INTO sent_emails (recipient, subject, body, sent_at, attachments)
       VALUES ($1, $2, $3, NOW(), $4)`,
      [to, subject, text, attachmentNames]
    );

    // Delete uploaded files
    attachments?.forEach(f => fs.unlinkSync(f.path));

    res.json({ success: true, message: "Email sent and saved successfully!" });
  } catch (error) {
    console.error("Error sending email:", error);
    res.status(500).json({ success: false, message: "Error sending email", error });
  }
});


app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
