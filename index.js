const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const axios = require("axios");
const chrono = require("chrono-node"); // ✅ NEW: smart date parser
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ✅ In-memory session store (replace with Redis/DB for production)
const sessionStore = {};

// ✅ Load API Keys
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is missing!");
} else {
  console.log("✅ OPENAI_API_KEY loaded");
}

if (!process.env.KIWI_API_KEY) {
  console.error("❌ KIWI_API_KEY is missing!");
} else {
  console.log("✅ KIWI_API_KEY loaded");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function extractFlightInfo(text) {
  const match = text.match(/from ([a-zA-Z\s]+) to ([a-zA-Z\s]+)(.*)/i);
  if (!match) return null;

  const [, fromRaw, toRaw, datePart] = match;
  const from = fromRaw.trim();
  const to = toRaw.trim();

  const parsedDates = chrono.parse(datePart);
  if (!parsedDates.length) return null;

  const firstDate = parsedDates[0].start.date();
  const formattedDate = firstDate.toISOString().split("T")[0];

  return {
    from,
    to,
    date: formattedDate
  };
}

app.get("/", (req, res) => {
  res.send("✅ Travel Chat API is running");
});

app.post("/chat", async (req, res) => {
  const { prompt, sessionId } = req.body;

  if (!prompt || !sessionId) {
    return res.status(400).json({ error: "Missing prompt or sessionId" });
  }

  // Create session if it doesn't exist
  if (!sessionStore[sessionId]) {
    sessionStore[sessionId] = {
      history: [
        {
          role: "system",
          content: `You're Moouris — a friendly, upbeat, and slightly playful AI travel assistant.
You love helping users find the best flights and trip options.
Ask only the information that’s missing (like destination, departure, date range, or trip duration),
and always keep your replies short, cheerful, and easy to read.
Avoid sounding robotic. Keep a helpful tone, like a smart and friendly concierge who's excited to assist!`
        }
      ]
    };
  }

  const session = sessionStore[sessionId];
  session.history.push({ role: "user", content: prompt });

  const recentMessages = session.history.slice(-10);

  const flightInfo = extractFlightInfo(prompt);
  if (flightInfo) {
    const { from, to, date } = flightInfo;

    try {
      const response = await axios.get("https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip", {
        params: {
          source: `City:${from}`,
          destination: `City:${to}`,
          outbound: date,
          currency: "usd",
          locale: "en",
          adults: 1,
          cabinClass: "ECONOMY",
          sortBy: "QUALITY",
          limit: 3,
          contentProviders: "KIWI"
        },
        headers: {
          "X-RapidAPI-Key": process.env.KIWI_API_KEY,
          "X-RapidAPI-Host": "kiwi-com-cheap-flights.p.rapidapi.com"
        }
      });

      const flights = response.data?.data || [];
      if (!flights.length) {
        return res.json({ reply: `😢 Sorry, I couldn't find any flights from ${from} to ${to} on ${date}.` });
      }

      const reply = flights.map(flight => {
        const airline = flight.airlines?.[0] || "Unknown airline";
        const price = flight.price?.amount || "N/A";
        const depTime = new Date(flight.local_departure).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `✈️ ${airline} — Departs at ${depTime}, $${price}`;
      }).join("\n");

      session.history.push({ role: "assistant", content: reply });
      return res.json({ reply });

    } catch (err) {
      console.error("🔥 Kiwi API error:", err.response?.data || err.message || err);
      return res.status(500).json({ error: "Flight search failed" });
    }
  }

  // 🎯 Default: call OpenAI if no direct flight info was detected
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: recentMessages,
      temperature: 0.4,
      max_tokens: 300
    });

    const reply = completion.choices[0].message.content;
    session.history.push({ role: "assistant", content: reply });

    res.json({ reply });
  } catch (err) {
    console.error("🔥 OpenAI error:", err?.response?.data || err.message || err);
    res.status(500).json({ error: "AI request failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 API running on port ${PORT}`);
});
