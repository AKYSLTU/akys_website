const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

app.post("/api/contact", async (req, res) => {
  const { name, organization, country, phone, email, message } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const body = `
New AKYS website contact form submission:

Name: ${name || "-"}
Organization: ${organization || "-"}
Country: ${country || "-"}
Phone: ${phone || "-"}
Email: ${email || "-"}

Message:
${message || "-"}
`.trim();

  try {
    await transporter.sendMail({
      from: `"AKYS Website" <${process.env.SMTP_FROM}>`,
      to: "gm@akys.ai",
      replyTo: email,
      subject: "New contact from akys.ai website",
      text: body,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Email send failed", err);
    res.status(500).json({ error: "Email send failed" });
  }
});

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.use(express.static(__dirname));

app.get("*", (req, res) => {
  const publicIndex = path.join(publicDir, "index.html");
  const rootIndex = path.join(__dirname, "index.html");
  const target = fs.existsSync(publicIndex) ? publicIndex : rootIndex;
  res.sendFile(target);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
