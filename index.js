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

// Load API keys
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

/**
 * Smart flight info extractor.
 * - Tries "from X to Y"
 * - Tries just "to Y"
 * - Tries just one city
 * - Grabs dates using chrono-node
 */
function extractFlightInfo(text, sessionFlightSearch = {}) {
  // 1. Try "from X to Y"
  let cityMatch = text.match(/from\s+([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+)/i);
  let from = cityMatch?.[1]?.trim() || null;
  let to = cityMatch?.[2]?.trim() || null;
  let datePart = "";

  if (cityMatch) {
    datePart = text.slice(cityMatch[0].length);
  } else {
    // 2. Try "to Y" (keep previous 'from' if available)
    cityMatch = text.match(/to\s+([a-zA-Z\s]+)/i);
    to = cityMatch?.[1]?.trim() || to || null;
    from = sessionFlightSearch.from || from || null;
    datePart = cityMatch ? text.slice(cityMatch[0].length) : text;
    // 3. Try single city (like "dubai" or "london")
    if (!to && !from) {
      const cityWord = text.match(/([A-Z][a-z]+)/g); // crude, picks up cities
      if (cityWord && cityWord.length === 1) to = cityWord[0];
    }
  }

  // Use chrono-node to grab date
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

  // Init session & tracking if new
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

  // Extract info and **accumulate** in the session
  const latestInfo = extractFlightInfo(prompt, session.flightSearch);
  if (latestInfo.from) session.flightSearch.from = latestInfo.from;
  if (latestInfo.to) session.flightSearch.to = latestInfo.to;
  if (latestInfo.date) session.flightSearch.date = latestInfo.date;

  const { from, to, date } = session.flightSearch;

  // Ask only for missing info
  let missing = [];
  if (!from) missing.push("Which city will you be flying from?");
  if (!to) missing.push("Where would you like to fly to?");
  if (!date) missing.push("When would you like to fly?");

  if (missing.length) {
    const reply = "Just need a bit more info! " + missing.join(" ");
    session.history.push({ role: "assistant", content: reply });
    return res.json({ reply });
  }

  // --- LOG ---
  console.log("[Kiwi flight search]", { from, to, date });

  // --- Real flight search! ---
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

    // Only log plain objects!
    console.log("[Kiwi API response]", JSON.stringify(response.data, null, 2));

    const flights = response.data?.data || [];
    if (!flights.length) {
      // Don't reset state on failure — let user refine query (only reset on success)
      return res.json({ reply: `😢 Sorry, I couldn't find any flights from ${from} to ${to} on ${date}.` });
    }

    const reply = flights.map(flight => {
      const airline = flight.airlines?.[0] || "Unknown airline";
      const price = flight.price?.amount || "N/A";
      const depTime = new Date(flight.local_departure).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `✈️ ${airline} — Departs at ${depTime}, $${price}`;
    }).join("\n");

    // Reset session search info ONLY ON SUCCESS
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
