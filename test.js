const nodemailer = require("nodemailer");

// Nastavenie emailového servera (SMTP)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "test.klinika2025@gmail.com",  // Nahradiť vlastným emailom
    pass: "qnbiwzjllupitvys",       // App Password z Google
  },
});

// Nastavenie testovacieho emailu
const mailOptions = {
  from: "test.klinika2025@gmail.com",
  to: "matus.stanko18@gmail.com",  // Zadaj email, na ktorý chceš dostať testovací email
  subject: "Testovací email",
  text: "Ak čítaš tento email, konfigurácia funguje správne!",
};

// Odoslanie emailu
transporter.sendMail(mailOptions, (error, info) => {
  if (error) {
    console.error("❌ Chyba pri odosielaní emailu:", error);
  } else {
    console.log("✅ Email odoslaný:", info.response);
  }
});