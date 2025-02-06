require("dotenv").config();
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const fs = require("fs"); // File system for logs

const app = express();
const PORT = 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Pripoj sa na SQL
pool.connect()
    .then(() => console.log("🟢 Pripojenie k PostgreSQL úspešné"))
    .catch((err) => console.error("🔴 Chyba pripojenia k PostgreSQL:", err));

// CORS 
const cors = require("cors");
app.use(cors());
app.use(express.json());
// staticke files
app.use(express.static(path.join(__dirname, "public"))); 

// SMS
const twilio = require("twilio");

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
async function sendSMS(phone, message) {
    try {
        const response = await twilioClient.messages.create({
            body: message,
            from: TWILIO_PHONE_NUMBER,
            to: phone
        });
        console.log(`✅ SMS sent to ${phone}: ${response.sid}`);
    } catch (error) {
        console.error("❌ Error sending SMS:", error);
    }
}

// EMAIL
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER, // Tvoj email
        pass: process.env.EMAIL_PASS, // Heslo alebo App Password
    },
});

async function sendConfirmationEmail(toEmail, phone, reservationDetails) {
    const cancelLink = `http://localhost:3000/zrusit.html?token=${reservationDetails.cancellation_token}`;
  
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: toEmail,
      subject: "Potvrdenie rezervácie - Dentalná klinika",
      text: `Dobrý deň,
  
  Vaša rezervácia na dentálnej klinike bola úspešne potvrdená.
  
  📅 Dátum: ${reservationDetails.date}
  ⏰ Čas: ${reservationDetails.time}
  📞 Telefón: ${phone}
  📧 Váš e-mail: ${toEmail}
  
  Ak si želáte zrušiť alebo zmeniť termín, použite tento odkaz:
  ❌ Zrušiť termín: ${cancelLink}
  
  Tešíme sa na Vašu návštevu!
  Dentalná klinika`,
    };
  
    try {
      await transporter.sendMail(mailOptions);
      console.log(`✅ Email odoslaný na ${toEmail}`);
    } catch (error) {
      console.error("❌ Chyba pri odosielaní emailu:", error);
    }
}

// Format time
function formatDateTime(dateString, timeString) {
    const date = new Date(dateString);

    // Format date as DD/MM/YYYY
    const formattedDate = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;

    // Extract and format time as HH:MM
    const formattedTime = timeString.slice(0, 5); // Assumes time is stored in 'HH:MM:SS' format

    return { formattedDate, formattedTime };
}

// -------------------------- //
//        API ROUTES
// -------------------------- //

// GET: Všetky termíny
app.get("/api/get_all_timeslots", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM time_slots ORDER BY time ASC");
        res.json(result.rows); 
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Chyba pri načítaní termínov" });
    }
});

// DELETE: Vymazať time_slot
app.delete("/api/delete_timeslot/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const checkResult = await pool.query("SELECT is_taken FROM time_slots WHERE id = $1", [id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: "Termín neexistuje" });
        }

        if (checkResult.rows[0].is_taken) {
            return res.status(400).json({ error: "Obsadený termín nemožno vymazať! Musíš najprv zrušiť rezerváciu" });
        }

        await pool.query("DELETE FROM time_slots WHERE id = $1", [id]);
        res.json({ message: "Termín úspešne vymazaný" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Chyba pri mazaní termínu" });
    }
});

// POST: Vytvorenie rezervácie
const crypto = require("crypto"); 

app.post("/api/create_reservation", async (req, res) => {
    const { phone, email, timeslot_id } = req.body;

    if (!phone || !email || !timeslot_id) {
        return res.status(400).json({ error: "Chýbajú údaje!" });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const checkResult = await client.query("SELECT id, is_taken, date, time FROM time_slots WHERE id = $1", [timeslot_id]);

        if (checkResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Termín neexistuje." });
        }

        if (checkResult.rows[0].is_taken) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Termín je už obsadený." });
        }

        const cancellationToken = crypto.randomBytes(16).toString("hex");

        const insertReservationQuery = `
            INSERT INTO reservations (phone, email, time_slot_id, cancellation_token, created_at)
            VALUES ($1, $2, $3, $4, NOW()) RETURNING id
        `;
        const reservationResult = await client.query(insertReservationQuery, [phone, email, timeslot_id, cancellationToken]);
        const reservationId = reservationResult.rows[0].id;

        await client.query("UPDATE time_slots SET is_taken = true WHERE id = $1", [timeslot_id]);

        await client.query("COMMIT");

        const { formattedDate, formattedTime } = formatDateTime(checkResult.rows[0].date, checkResult.rows[0].time);

        const reservationDetails = {
            id: reservationId,
            date: formattedDate,
            time: formattedTime,
            cancellation_token: cancellationToken
        };

        sendConfirmationEmail(email, phone, reservationDetails);
        sendSMS(phone, `✅ Vaša rezervácia bola úspešná.\n📅 Dátum: ${formattedDate}\n⏰ Čas: ${formattedTime}`);

        res.json({ 
            message: "Rezervácia úspešná!", 
            reservation_id: reservationId, 
            cancellation_token: cancellationToken 
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("❌ Chyba pri rezervácii:", err);
        res.status(500).json({ error: "Chyba pri rezervácii." });
    } finally {
        client.release();
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🟢 Server beží na http://localhost:${PORT}`);
});