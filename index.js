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

// --- Helper: Extract flight info (city names, date) ---
function extractFlightInfo(text, sessionFlightSearch = {}) {
  let cityMatch = text.match(/from\s+([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)(?:\s|$)/i);
  let from = cityMatch?.[1]?.trim() || null;
  let toRaw = cityMatch?.[2]?.trim() || null;
  let to = toRaw;
  if (to) to = to.replace(/\b(next|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})\b.*$/i, "").trim();

  let datePart = "";
  if (cityMatch) {
    datePart = text.slice(cityMatch[0].length);
    let matchDateWord = toRaw?.match(/\b(next|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})\b.*$/i);
    if (!datePart && matchDateWord) datePart = matchDateWord[0];
  } else {
    cityMatch = text.match(/to\s+([a-zA-Z\s]+)/i);
    to = cityMatch?.[1]?.trim() || to || null;
    from = sessionFlightSearch.from || from || null;
    datePart = cityMatch ? text.slice(cityMatch[0].length) : text;
    if (!to && !from) {
      const cityWord = text.match(/([A-Z][a-z]+)/g);
      if (cityWord && cityWord.length === 1) to = cityWord[0];
    }
  }
  const parsedDates = chrono.parse(datePart);
  const date = parsedDates.length ? parsedDates[0].start.date().toISOString().split("T")[0] : null;
  return { from, to, date };
}

// Simple map for demo: city name -> Skyscanner code
// In production, use a full lookup or API (see Skyscanner docs or endpoints!)
const cityToSkyId = city => {
  const lookup = {
    london: "LOND",
    paris: "PARI",
    rome: "ROME",
    dubai: "DXBA",
    newyork: "NYCA",
    madrid: "MADR",
    barcelona: "BCN",
    tokyo: "TYOA"
    // ...expand as needed
  };
  if (!city) return null;
  // Try exact match (case-insensitive, spaces removed)
  return lookup[city.toLowerCase().replace(/\s/g, "")] || null;
};

app.get("/", (req, res) => {
  res.send("✅ Travel Chat API is running");
});

app.post("/chat", async (req, res) => {
  const { prompt, sessionId } = req.body;

  if (!prompt || !sessionId) {
    return res.status(400).json({ error: "Missing prompt or sessionId" });
  }

  // Init session
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

  // Extract info & accumulate
  const latestInfo = extractFlightInfo(prompt, session.flightSearch);
  if (latestInfo.from) session.flightSearch.from = latestInfo.from;
  if (latestInfo.to) session.flightSearch.to = latestInfo.to;
  if (latestInfo.date) session.flightSearch.date = latestInfo.date;
  const { from, to, date } = session.flightSearch;

  // Missing info?
  let missing = [];
  if (!from) missing.push("Which city will you be flying from?");
  if (!to) missing.push("Where would you like to fly to?");
  if (!date) missing.push("When would you like to fly?");
  if (missing.length) {
    const reply = "Just need a bit more info! " + missing.join(" ");
    session.history.push({ role: "assistant", content: reply });
    return res.json({ reply });
  }

  // --- Fly Scraper: city name -> Skyscanner code
  const fromSkyId = cityToSkyId(from);
  const toSkyId = cityToSkyId(to);

  if (!fromSkyId || !toSkyId) {
    const msg = `Sorry, I couldn't identify the airport/city codes for "${from}" or "${to}". Try major cities (London, Paris, Rome, etc).`;
    session.history.push({ role: "assistant", content: msg });
    return res.json({ reply: msg });
  }

  console.log("[Fly Scraper flight search]", { fromSkyId, toSkyId, date });

  try {
    const response = await axios.get("https://fly-scraper.p.rapidapi.com/flights/search-one-way", {
      params: {
        originSkyId: fromSkyId,
        destinationSkyId: toSkyId,
        departureDate: date,
        adults: "1"
      },
      headers: {
        "x-rapidapi-key": process.env.RAPIDAPI_KEY, // set RAPIDAPI_KEY in .env
        "x-rapidapi-host": "fly-scraper.p.rapidapi.com"
      }
    });

    const itineraries = response.data?.data?.itineraries || [];
    if (!itineraries.length) {
      return res.json({ reply: `😢 Sorry, I couldn't find any flights from ${from} to ${to} on ${date}.` });
    }

    // Format top 3 flight options
    const reply = itineraries.slice(0, 3).map(flight => {
      const price = flight.price?.raw || "N/A";
      const dep = flight.legs?.[0]?.departureTime || "";
      const arr = flight.legs?.[0]?.arrivalTime || "";
      return `✈️ $${price} | Departure: ${dep} → Arrival: ${arr}`;
    }).join("\n");

    // Reset search on success
    session.flightSearch = { from: null, to: null, date: null };
    session.history.push({ role: "assistant", content: reply });
    return res.json({ reply });
  } catch (err) {
    console.error("🔥 Fly Scraper API error:", err.response?.data || err.message || err);
    return res.status(500).json({ error: "Flight search failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 API running on port ${PORT}`);
});
