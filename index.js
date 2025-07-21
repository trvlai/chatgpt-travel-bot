const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const axios = require("axios");
const chrono = require("chrono-node");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// In-memory session store
const sessionStore = {};

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

// --- Helper: extract flight info ---
function extractFlightInfo(text) {
  const cityMatch = text.match(/from\s+([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+)/i);
  const from = cityMatch?.[1]?.trim() || null;
  const to = cityMatch?.[2]?.trim() || null;

  let datePart = "";
  if (cityMatch) {
    datePart = text.slice(cityMatch[0].length);
  } else {
    datePart = text;
  }

  const parsedDates = chrono.parse(datePart);
  const date = parsedDates.length ? parsedDates[0].start.date().toISOString().split("T")[0] : null;

  return { from, to, date };
}

app.get("/", (req, res) => {
  res.send("✅ Travel Chat API is running");
});

app.post("/chat", async (req, res) => {
  const { prompt, sessionId } = req.body;

  if (!prompt || !sessionId) {
    return res.status(400).json({ error: "Missing prompt or sessionId" });
  }

  // Init session & tracking
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
      ],
      flightSearch: {
        from: null,
        to: null,
        date: null
      }
    };
  }

  const session = sessionStore[sessionId];
  session.history.push({ role: "user", content: prompt });

  // --- Gather all info so far ---
  const latestInfo = extractFlightInfo(prompt);
  if (latestInfo.from) session.flightSearch.from = latestInfo.from;
  if (latestInfo.to) session.flightSearch.to = latestInfo.to;
  if (latestInfo.date) session.flightSearch.date = latestInfo.date;

  const { from, to, date } = session.flightSearch;

  // Ask for missing info
  let missing = [];
  if (!from) missing.push("Which city will you be flying from?");
  if (!to) missing.push("Where would you like to fly to?");
  if (!date) missing.push("When would you like to fly?");

  if (missing.length) {
    const reply = "Just need a bit more info! " + missing.join(" ");
    session.history.push({ role: "assistant", content: reply });
    return res.json({ reply });
  }

  // --- DEBUG: log search params ---
  console.log("Kiwi flight search:", { from, to, date });

  // --- Call Kiwi one-way endpoint ---
  try {
    const response = await axios.get("https://kiwi-com-cheap-flights.p.rapidapi.com/one-way", {
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

    // --- DEBUG: print out response for troubleshooting ---
    console.log("Kiwi API response:", JSON.stringify(response.data, null, 2));

    const flights = response.data?.data || [];
    if (!flights.length) {
      // Reset search state so user can try new route/date
      session.flightSearch = { from: null, to: null, date: null };
      return res.json({ reply: `😢 Sorry, I couldn't find any flights from ${from} to ${to} on ${date}.` });
    }

    const reply = flights.map(flight => {
      const airline = flight.airlines?.[0] || "Unknown airline";
      const price = flight.price?.amount || "N/A";
      const depTime = new Date(flight.local_departure).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `✈️ ${airline} — Departs at ${depTime}, $${price}`;
    }).join("\n");

    // Reset search for next request
    session.flightSearch = { from: null, to: null, date: null };
    session.history.push({ role: "assistant", content: reply });
    return res.json({ reply });
  } catch (err) {
    console.error("🔥 Kiwi API error:", err.response?.data || err.message || err);
    return res.status(500).json({ error: "Flight search failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 API running on port ${PORT}`);
});
