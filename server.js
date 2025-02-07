require("dotenv").config();
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000; // Azure sets PORT automatically

// PostgreSQL Connection (Azure)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Azure PostgreSQL requires SSL
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    keepAlive: true
});

// Handle unexpected PostgreSQL errors
pool.on("error", (err) => {
    console.error("⚠️ PostgreSQL error:", err);
    logError(err);
    reconnectDatabase();
});

async function reconnectDatabase() {
    console.log("🔄 Reconnecting to PostgreSQL...");
    try {
        await pool.query("SELECT 1");
        console.log("🟢 Reconnected!");
    } catch (err) {
        console.error("🔴 Reconnect failed, retrying...", err);
        logError(err);
        setTimeout(reconnectDatabase, 5000);
    }
}

// Log errors to a file
function logError(error) {
    const logMessage = `[${new Date().toISOString()}] ${error}\n`;
    fs.appendFileSync("server_errors.log", logMessage);
}

// API Health Check
app.get("/api/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({ status: "🟢 Database Connected" });
    } catch (err) {
        logError(err);
        res.status(500).json({ status: "🔴 Database Disconnected", error: err.message });
    }
});

// CORS Config for Azure Deployment
const cors = require("cors");
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS || "https://your-frontend.azurewebsites.net",
    methods: ["GET", "POST", "DELETE"],
    credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // Serve static files

// SMS - Twilio
const twilio = require("twilio");
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

async function sendSMS(phone, message) {
    try {
        const response = await twilioClient.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: phone
        });
        console.log(`✅ SMS sent to ${phone}: ${response.sid}`);
    } catch (error) {
        logError(error);
        console.error("❌ Error sending SMS:", error);
    }
}

// EMAIL - Nodemailer
const nodemailer = require("nodemailer");
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

async function sendConfirmationEmail(toEmail, phone, reservationDetails) {
    const BASE_URL = process.env.BASE_URL || "https://your-azure-webapp.azurewebsites.net";
    const cancelLink = `${BASE_URL}/zrusit.html?token=${reservationDetails.cancellation_token}`;

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
        console.log(`✅ Email sent to ${toEmail}`);
    } catch (error) {
        logError(error);
        console.error("❌ Error sending email:", error);
    }
}

// Format time
function formatDateTime(dateString, timeString) {
    const date = new Date(dateString);
    const formattedDate = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
    const formattedTime = timeString.slice(0, 5);
    return { formattedDate, formattedTime };
}

// API ROUTES

// GET: All time slots
app.get("/api/get_all_timeslots", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM time_slots ORDER BY time ASC");
        res.json(result.rows);
    } catch (err) {
        logError(err);
        res.status(500).json({ error: "Chyba pri načítaní termínov" });
    }
});

// DELETE: Delete time slot
app.delete("/api/delete_timeslot/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const checkResult = await pool.query("SELECT is_taken FROM time_slots WHERE id = $1", [id]);
        if (checkResult.rows.length === 0) return res.status(404).json({ error: "Termín neexistuje" });
        if (checkResult.rows[0].is_taken) return res.status(400).json({ error: "Obsadený termín nemožno vymazať! Musíš najprv zrušiť rezerváciu" });

        await pool.query("DELETE FROM time_slots WHERE id = $1", [id]);
        res.json({ message: "Termín úspešne vymazaný" });

    } catch (err) {
        logError(err);
        res.status(500).json({ error: "Chyba pri mazaní termínu" });
    }
});

// POST: Create Reservation
const crypto = require("crypto");

app.post("/api/create_reservation", async (req, res) => {
    const { phone, email, timeslot_id } = req.body;
    if (!phone || !email || !timeslot_id) return res.status(400).json({ error: "Chýbajú údaje!" });

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
        await client.query("INSERT INTO reservations (phone, email, time_slot_id, cancellation_token, created_at) VALUES ($1, $2, $3, $4, NOW())", [phone, email, timeslot_id, cancellationToken]);
        await client.query("UPDATE time_slots SET is_taken = true WHERE id = $1", [timeslot_id]);
        await client.query("COMMIT");

        sendConfirmationEmail(email, phone, { date: checkResult.rows[0].date, time: checkResult.rows[0].time, cancellation_token: cancellationToken });
        sendSMS(phone, `✅ Vaša rezervácia bola úspešná.`);

        res.json({ message: "Rezervácia úspešná!" });

    } catch (err) {
        await client.query("ROLLBACK");
        logError(err);
        res.status(500).json({ error: "Chyba pri rezervácii." });
    } finally {
        client.release();
    }
});

// Start server
app.listen(PORT, () => console.log(`🟢 Server beží na port ${PORT}`));