require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");

const app = express();

const oAuth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI // http://localhost:8000/
);

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

app.get("/", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    // Step 1: show login link
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
    });

    return res.send(`
      <h2>Google Gmail OAuth</h2>
      <p>Click below to authorize:</p>
      <a href="${authUrl}" target="_blank">Login with Google</a>
    `);
  }

  // Step 2: handle code returned by Google
  try {
    const { tokens } = await oAuth2Client.getToken(code);

    if (!tokens.refresh_token) {
      return res.send(`
        ⚠️ No refresh token received. 
        Try revoking previous access in your Google account and retry.
      `);
    }

    res.send(`
      ✅ Success! Your refresh token is: <br>
      <pre>${tokens.refresh_token}</pre>
      <br>Copy this and save it into your .env as:<br>
      <pre>GMAIL_REFRESH_TOKEN=${tokens.refresh_token}</pre>
    `);
  } catch (err) {
    res.send("❌ Error retrieving tokens: " + err.message);
  }
});

app.listen(8000, () => {
  console.log("Server running at http://localhost:8000");
});
