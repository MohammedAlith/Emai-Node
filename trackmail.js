require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");

const PORT = process.env.PORT || 8000;
const app = express();

app.use(cors());
app.use(express.json());

// ===== Google OAuth2 Setup =====
const oAuth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);

oAuth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN,
});

const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

// ===== Fetch Unread Emails =====
const fetchUnreadEmails = async (max = 10) => {
  try {
    // Step 1: list unread messages
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: max,
      q: "is:unread", // only unread emails
    });

    const messages = res.data.messages || [];
    if (!messages.length) return [];

    const emails = [];

    // Step 2: fetch each message's headers
    for (const msg of messages) {
      const fullMsg = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const headers = fullMsg.data.payload.headers;
      const subject = headers.find(h => h.name === "Subject")?.value || "";
      const from = headers.find(h => h.name === "From")?.value || "";
      const to = headers.find(h => h.name === "To")?.value || "";
      const date = headers.find(h => h.name === "Date")?.value || "";

      emails.push({ id: msg.id, from, to, subject, date });
    }

    return emails;
  } catch (err) {
    console.error("Error fetching unread emails:", err.message);
    return [];
  }
};

// ===== API Endpoint =====
app.get("/emails", async (req, res) => {
  const emails = await fetchUnreadEmails(10);
  res.json(emails); // plain array of key-value objects
});

// ===== Start Server =====
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
